from __future__ import annotations

import json
import mimetypes
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import maya_assistant as maya


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
HOST = "127.0.0.1"
PORT = int(os.environ.get("MAYA_PORT", "8765"))


class MayaHandler(BaseHTTPRequestHandler):
    server_version = "MAYA/1.0"

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; "
            "media-src 'self' blob:; style-src 'self'; script-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )

    def _json(self, data: object, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(payload)

    def _request_is_local(self) -> bool:
        host = self.headers.get("Host", "").split(":", 1)[0].strip("[]").casefold()
        if host not in {"127.0.0.1", "localhost"}:
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port in {None, PORT}

    def _body(self) -> dict:
        return maya.parse_json_body(self)

    def do_GET(self) -> None:
        if not self._request_is_local():
            self._json({"error": "Local requests only"}, 403)
            return
        route = urlparse(self.path)
        if route.path == "/api/status":
            self._json(maya.system_status())
        elif route.path == "/api/settings":
            self._json(maya.settings())
        elif route.path == "/api/reminders":
            self._json({"reminders": maya.get_reminders()})
        elif route.path == "/api/files":
            from urllib.parse import parse_qs

            query = parse_qs(route.query).get("q", [""])[0][:200]
            self._json({"files": maya.list_files(query)})
        elif route.path == "/api/history":
            self._json({"messages": maya.conversation(), "preferences": maya.preferences()})
        elif route.path == "/api/research":
            from urllib.parse import parse_qs

            query = parse_qs(route.query).get("q", [""])[0]
            try:
                self._json({"results": maya.web_research(query)})
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except RuntimeError as exc:
                self._json({"error": str(exc)}, 503)
        else:
            self._static_file(route.path)

    def do_POST(self) -> None:
        if not self._request_is_local():
            self._json({"error": "Local requests only"}, 403)
            return
        try:
            body = self._body()
            route = urlparse(self.path).path
            if route == "/api/command":
                text = body.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                    raise ValueError("Command must contain 1 to 1,000 characters")
                self._json(maya.command(text))
            elif route == "/api/chat":
                text = body.get("text")
                skill = body.get("skill", "assistant")
                if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                    raise ValueError("Message must contain 1 to 4,000 characters")
                if not isinstance(skill, str):
                    raise ValueError("Skill must be a string")
                self._json({"text": maya.ask_ollama(text.strip(), skill=skill)})
            elif route == "/api/agent":
                text = body.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                    raise ValueError("Agent request must contain 1 to 1,000 characters")
                self._json(maya.run_agent(text.strip()))
            elif route == "/api/screen":
                image = maya.decode_image(body.get("image"))
                question = body.get("question", "Describe the visible screen and help me understand it.")
                if not isinstance(question, str) or len(question) > 1000:
                    raise ValueError("Question must be 1,000 characters or fewer")
                self._json({"text": maya.ask_ollama(question, image)})
            elif route == "/api/files/read":
                file_path = body.get("path")
                if not isinstance(file_path, str) or len(file_path) > 2048:
                    raise ValueError("Invalid file path")
                self._json(maya.read_file(file_path))
            elif route == "/api/reminders":
                text = body.get("text")
                seconds = body.get("seconds")
                if not isinstance(text, str) or not isinstance(seconds, int) or isinstance(seconds, bool):
                    raise ValueError("Provide reminder text and a delay in seconds")
                due_at = time.time() + seconds
                import datetime as dt

                reminder = maya.add_reminder(text, dt.datetime.fromtimestamp(due_at, dt.timezone.utc))
                self._json({"reminder": reminder}, 201)
            elif route.startswith("/api/reminders/") and route.endswith("/complete"):
                match = re.fullmatch(r"/api/reminders/(\d+)/complete", route)
                if not match or not maya.complete_reminder(int(match.group(1))):
                    self._json({"error": "Reminder not found"}, 404)
                    return
                self._json({"ok": True})
            elif route == "/api/home":
                entity_id, service = body.get("entity_id"), body.get("service")
                if not isinstance(entity_id, str) or not isinstance(service, str):
                    raise ValueError("Provide a configured device and action")
                self._json({"text": maya.control_home(entity_id, service)})
            else:
                self._json({"error": "Not found"}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc)}, 400)
        except RuntimeError as exc:
            self._json({"error": str(exc)}, 503)
        except Exception as exc:
            self.log_error("Request failed: %s", exc)
            self._json({"error": "The request failed. Check the server log for details."}, 500)

    def _static_file(self, url_path: str) -> None:
        relative = unquote(url_path).lstrip("/") or "index.html"
        requested = (WEB_ROOT / relative).resolve()
        if not requested.is_relative_to(WEB_ROOT) or not requested.is_file():
            self._json({"error": "Not found"}, 404)
            return
        payload = requested.read_bytes()
        content_type = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[MAYA] {self.address_string()} - {fmt % args}")


def main() -> None:
    maya.DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), MayaHandler)
    server.daemon_threads = True
    print(f"{maya.APP_NAME} ready at http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping MAYA...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
