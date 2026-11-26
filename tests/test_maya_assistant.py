import json
import os
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch
from urllib.request import Request, urlopen

import maya_assistant as maya


class MayaAssistantTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.data_path = Path(self.temp_dir.name) / "app-data"
        self.previous_paths = maya.DATA_DIR, maya.DATABASE, maya.NOTES_DIR
        maya.DATA_DIR = self.data_path
        maya.DATABASE = self.data_path / "test.sqlite3"
        maya.NOTES_DIR = self.data_path / "notes"
        self.addCleanup(self._restore_paths)

    def _restore_paths(self):
        maya.DATA_DIR, maya.DATABASE, maya.NOTES_DIR = self.previous_paths

    def test_database_connections_are_closed_after_use(self):
        connect = maya._connect
        connections = []

        def tracked_connect():
            connection = connect()
            connections.append(connection)
            return connection

        with patch.object(maya, "_connect", side_effect=tracked_connect):
            maya.remember("theme", "blue")
        with self.assertRaises(sqlite3.ProgrammingError):
            connections[0].execute("SELECT 1")

    def test_wake_prefix_and_bilingual_status_intent(self):
        result = maya.command("Hey Jarvis, what's my system status?")
        self.assertEqual(result["kind"], "status")
        self.assertEqual(maya.command("Jarvis")["kind"], "message")

    def test_search_workflow_parses_each_safe_step(self):
        result = maya.command("What's my system status then search the web for weather")
        self.assertEqual(result["kind"], "workflow")
        self.assertEqual([step["kind"] for step in result["results"]], ["status", "search"])
        self.assertIn("weather", result["results"][1]["url"])

    def test_curated_skills_route_to_the_right_workflow(self):
        cases = {
            "help me code a Python error": "coding",
            "fix this bug: the parser crashes": "debugging",
            "debug this traceback": "debugging",
            "help me write a thank-you note": "writing",
            "summarize the difference": "summarize",
            "translate hello to Hindi": "translate",
            "plan my study schedule": "planner",
            "teach me recursion": "study",
            "brainstorm a garden design": "brainstorm",
        }
        for phrase, skill in cases.items():
            with self.subTest(phrase=phrase):
                result = maya.command(phrase)
                self.assertEqual(result, {"kind": "chat", "text": phrase, "skill": skill})

    def test_self_recovery_command_runs_a_local_diagnostic(self):
        report = {"summary": "All MAYA self-checks passed.", "checks": []}
        with patch.object(maya, "self_diagnostics", return_value=report):
            self.assertEqual(
                maya.command("Run MAYA self-check"),
                {"kind": "diagnostics", **report},
            )
            self.assertEqual(
                maya._run_agent_tool("self_check", {}),
                ("MAYA self-check", report),
            )

    def test_self_diagnostics_reports_unavailable_ollama(self):
        from urllib.error import URLError

        with patch.object(maya.urllib.request, "urlopen", side_effect=URLError("offline")):
            report = maya.self_diagnostics()
        checks = {check["name"]: check for check in report["checks"]}
        self.assertEqual(checks["Local memory"]["status"], "ok")
        self.assertEqual(checks["Local AI service"]["status"], "action_needed")
        self.assertIn("ollama serve", checks["Local AI service"]["detail"])

    def test_local_ai_retries_once_after_transient_connection_error(self):
        from urllib.error import URLError

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def read(self, _limit):
                return b'{"message":{"content":"Recovered"}}'

        with patch.object(
            maya.urllib.request,
            "urlopen",
            side_effect=[URLError("temporary"), FakeResponse()],
        ) as urlopen:
            with patch.object(maya.time, "sleep"):
                result = maya._ollama_chat([{"role": "user", "content": "hi"}], "test-model")
        self.assertEqual(result, "Recovered")
        self.assertEqual(urlopen.call_count, 2)

    def test_web_research_sanitizes_results_and_limits_query(self):
        fake_ddgs = types.ModuleType("ddgs")
        fake_ddgs.__path__ = []
        fake_exceptions = types.ModuleType("ddgs.exceptions")
        fake_exceptions.DDGSException = type("DDGSException", (Exception,), {})

        class FakeDDGS:
            def __init__(self, timeout):
                self.timeout = timeout

            def text(self, query, max_results):
                self.query = query
                self.max_results = max_results
                return [
                    {"title": "Good source", "href": "https://example.com/a", "body": "Evidence"},
                    {"title": "Unsafe link", "href": "javascript:alert(1)", "body": "Ignore"},
                ]

        fake_ddgs.DDGS = FakeDDGS
        with patch.dict(sys.modules, {"ddgs": fake_ddgs, "ddgs.exceptions": fake_exceptions}):
            self.assertEqual(
                maya.web_research(" test "),
                [{"title": "Good source", "url": "https://example.com/a", "snippet": "Evidence"}],
            )
        with self.assertRaisesRegex(ValueError, "1 to 300"):
            maya.web_research("")

    def test_agent_runs_validated_read_only_tools(self):
        planning = json.dumps(
            {
                "reply": "I will check system health.",
                "tool_calls": [{"name": "system_status", "arguments": {}}],
            }
        )
        responses = iter([planning, "CPU use is low and memory is available."])
        with patch.object(maya, "_ollama_chat", side_effect=lambda *args: next(responses)):
            with patch.object(maya, "system_status", return_value={"cpu_percent": 12}):
                result = maya.run_agent("How is my system doing?")
        self.assertEqual(result["text"], "CPU use is low and memory is available.")
        self.assertEqual(result["steps"], ["System health"])
        self.assertEqual(len(maya.conversation()), 2)

    def test_agent_rejects_unapproved_tools_without_running_them(self):
        planning = json.dumps(
            {
                "reply": "I will run a command.",
                "tool_calls": [{"name": "run_shell", "arguments": {"command": "whoami"}}],
            }
        )
        with patch.object(maya, "_ollama_chat", return_value=planning):
            with self.assertRaisesRegex(RuntimeError, "does not allow"):
                maya.run_agent("Run a system command")
        self.assertEqual(maya.conversation(), [])

    def test_agent_plans_with_only_bounded_read_only_tools(self):
        planning = json.dumps(
            {
                "reply": "I will check system health.",
                "tool_calls": [{"name": "system_status", "arguments": {}}],
            }
        )
        responses = iter([planning, "CPU use is low and memory is available."])
        with patch.object(maya, "_ollama_chat", side_effect=lambda *args: next(responses)):
            with patch.object(maya, "system_status", return_value={"cpu_percent": 12}):
                result = maya.run_agent("How is my system doing?")
        self.assertEqual(result["text"], "CPU use is low and memory is available.")
        self.assertEqual(result["steps"], ["System health"])
        self.assertEqual(len(maya.conversation()), 2)

    def test_agent_rejects_unapproved_tools_without_running_them(self):
        planning = json.dumps(
            {
                "reply": "I will run a command.",
                "tool_calls": [{"name": "run_shell", "arguments": {"command": "whoami"}}],
            }
        )
        with patch.object(maya, "_ollama_chat", return_value=planning):
            with self.assertRaisesRegex(RuntimeError, "does not allow"):
                maya.run_agent("Run a system command")
        self.assertEqual(maya.conversation(), [])

    def test_reminder_creation_and_time_bounds(self):
        result = maya.command("remind me in 2 minutes to drink water")
        self.assertEqual(result["kind"], "reminder")
        self.assertEqual(maya.get_reminders()[0]["text"], "drink water")
        with self.assertRaisesRegex(ValueError, "between 10 seconds"):
            maya.add_reminder("too soon", datetime.now(timezone.utc) + timedelta(seconds=2))

    def test_notes_are_written_only_to_private_app_directory(self):
        result = maya.command("take a note: buy oat milk")
        self.assertIn("note-", result["text"])
        notes = list(maya.NOTES_DIR.glob("*.txt"))
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].read_text(), "buy oat milk\n")

    def test_file_reader_rejects_paths_outside_allowed_folder(self):
        root = Path(self.temp_dir.name) / "Documents"
        root.mkdir()
        safe_file = root / "todo.txt"
        safe_file.write_text("test data", encoding="utf-8")
        outside = Path(self.temp_dir.name) / "outside.txt"
        outside.write_text("not allowed", encoding="utf-8")
        with patch.object(maya, "_allowed_roots", return_value=[root]):
            self.assertEqual(maya.read_file(str(safe_file))["text"], "test data")
            with self.assertRaisesRegex(ValueError, "Only files directly"):
                maya.read_file(str(outside))

    def test_smart_home_voice_command_is_confirmation_only(self):
        environment = {
            "HOME_ASSISTANT_URL": "https://home.example",
            "HOME_ASSISTANT_TOKEN": "test-token",
            "HOME_ASSISTANT_ALLOWED_ENTITIES": "light.office",
        }
        with patch.dict(os.environ, environment, clear=False):
            result = maya.command("turn on light.office")
            self.assertEqual(result["kind"], "home_confirmation")
            self.assertEqual(result["entity_id"], "light.office")
            with self.assertRaisesRegex(ValueError, "HOME_ASSISTANT_ALLOWED_ENTITIES"):
                maya.control_home("switch.unlisted", "turn_on")


class HttpAppTests(unittest.TestCase):
    def test_local_dashboard_and_origin_guard(self):
        import main
        from http.server import ThreadingHTTPServer

        server = ThreadingHTTPServer(("127.0.0.1", 0), main.MayaHandler)
        previous_port = main.PORT
        main.PORT = server.server_port
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.shutdown)
        self.addCleanup(setattr, main, "PORT", previous_port)
        base = f"http://127.0.0.1:{server.server_port}"

        with urlopen(f"{base}/", timeout=3) as response:
            page = response.read().decode()
            self.assertEqual(response.status, 200)
            self.assertIn("MAYA", page)
            self.assertIn("Content-Security-Policy", response.headers)

        request = Request(
            f"{base}/api/command",
            data=json.dumps({"text": "Hey Jarvis"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=3) as response:
            self.assertEqual(json.loads(response.read())["kind"], "message")

        with patch.object(
            main.maya,
            "web_research",
            return_value=[{"title": "Source", "url": "https://example.com", "snippet": "Excerpt"}],
        ):
            with urlopen(f"{base}/api/research?q=local+AI", timeout=3) as response:
                self.assertEqual(json.loads(response.read())["results"][0]["title"], "Source")

        with patch.object(main.maya, "run_agent", return_value={"text": "Done", "steps": ["System health"]}):
            request = Request(
                f"{base}/api/agent",
                data=json.dumps({"text": "Check my computer"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=3) as response:
                self.assertEqual(json.loads(response.read())["steps"], ["System health"])

        blocked = Request(f"{base}/api/status", headers={"Origin": "http://evil.example"})
        with self.assertRaises(HTTPError) as context:
            urlopen(blocked, timeout=3)
        try:
            self.assertEqual(context.exception.code, 403)
        finally:
            context.exception.close()


if __name__ == "__main__":
    unittest.main()
