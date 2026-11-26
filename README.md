# MAYA — local-first voice assistant

MAYA is a Python application with a browser-based desktop dashboard. It runs on your computer, supports English, Hindi, and Hinglish, and combines safe built-in voice commands with optional local AI.

## Run it

Requirements: Python 3.10+ and a current browser. No API keys or cloud AI account are needed for the dashboard and built-in commands.

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows PowerShell:
# .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python main.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). MAYA binds to loopback only. Stop it with Ctrl+C.

## VS Code

Open the project folder in VS Code and select a Python 3.10+ interpreter. Create and activate a virtual environment, then install `requirements.txt` as shown above. The included workspace settings enable the Python extension's unittest discovery for `tests/test_*.py`; run MAYA from the integrated terminal with `python main.py`.

For local AI, agent mode, document summaries, and screen/image analysis, install [Ollama](https://ollama.com/) and download models once:

```bash
ollama serve
ollama pull qwen2.5:3b
ollama pull llava:7b
```

The local Ollama server should be available at `http://127.0.0.1:11434`. Override models with `MAYA_OLLAMA_MODEL` and `MAYA_OLLAMA_VISION_MODEL`. Once the models are downloaded, chat and image analysis can run offline.

Turn on **AGENT** beside the message box to let MAYA plan a request, use up to three allowlisted read-only tools (web search, system health, and file-name search), and summarize what it found. Agent mode never runs shell commands, changes settings, sends email, or writes/deletes files. Keep it off for direct built-in commands such as reminders and Home Assistant (which still ask for confirmation). Agent mode requires the local Ollama model.

## Voice and commands

Select **English** or **Hindi / Hinglish**, press **Start listening**, and say “Hey Jarvis” followed by a command. You can also say the wake phrase first and then give a command. Browser speech-recognition support varies; Chrome and Edge generally provide it. Some browsers send speech to their recognition provider, so voice recognition may need internet access even when MAYA's local commands and Ollama work offline. Audio is not stored by MAYA. Typing remains available if voice recognition is unavailable.

Examples:

- “Hey Jarvis, what's my system status?”
- “Research today's weather” (MAYA fetches web snippets and source links)
- “Open browser”, “open calculator”, or “open files”
- “Take a note: call the dentist”
- “Remember that I prefer concise answers”
- “Remind me in 20 minutes to stretch”
- “Find file budget”
- “Fix this bug: [paste the error and relevant code]”, “translate hello to Hindi”, “plan my study week”, or “brainstorm a garden”
- “Run MAYA self-check” to inspect the app, local database, Ollama service, and configured model. A failed check gives safe next steps; MAYA does not restart services or modify files automatically.
- Open **Skills** for the built-in research, coding, error/bug fixing, self-recovery, writing, document-summary, translation, planning, study, brainstorming, productivity, system-health, smart-home, and screen-understanding tools.
- “Turn on light.office” (only after configuring the Home Assistant allowlist)
- “What's in this picture?” (use **Analyze screen** and approve the browser's screen-share prompt)
- Combine safe steps with “then”, e.g. “What's my system status then search the web for weather”

Web research displays result snippets and source links from the `ddgs` metasearch library; it requires internet access and results should be verified at their source. Email commands create a `mailto:` draft in your configured mail app; MAYA never sends email. File browsing is limited to supported files directly inside Documents, Downloads, and Desktop. It can read text/Markdown/CSV/JSON/log, PDF, and DOCX files up to 1 MB; select **Summarize** to ask the local AI to summarize a document. Notes are saved under `~/.maya-assistant/notes`. MAYA does not delete files, run arbitrary shell commands, or inject unrestricted keyboard/mouse actions.

The **Skills** page contains curated, built-in capabilities only; it does not download or execute third-party skill packs. Coding, error/bug diagnosis, writing, translation, planning, study, brainstorming, document summaries, and natural-language chat use the local Ollama model. Chat requests retry once after a transient local connection failure; this never runs a system command or modifies user data. Web search works separately and needs internet.

## Optional smart-home controls

MAYA integrates with Home Assistant. Set these environment variables before starting the app:

- `HOME_ASSISTANT_URL`: an HTTPS URL, or a loopback URL for a local instance.
- `HOME_ASSISTANT_TOKEN`: a Home Assistant long-lived access token.
- `HOME_ASSISTANT_ALLOWED_ENTITIES`: comma-separated entity IDs, such as `light.office,switch.fan`.

Only listed entities can be controlled. Voice or dashboard changes always require confirmation. Keep the token in your operating system's secret store or a private shell environment; do not put it in source control or expose the server to your network.

## Data and capabilities

- Preferences, recent local-AI conversation, and reminders are stored in `~/.maya-assistant/maya.sqlite3`. Relevant preferences may be included in local chat context. Agent requests are limited to validated, read-only tools; the model cannot directly access the operating system.
- Local AI is optional. When Ollama is unavailable, built-in commands and the dashboard still work; AI questions show an explicit setup error.
- System telemetry reports CPU, memory, disk, battery (when available), and NVIDIA GPU utilization when `nvidia-smi` is installed. Other GPU vendors are not currently reported.
- Screen analysis requires your explicit browser screen-share approval and a local vision model. The captured frame is sent only to the local Ollama endpoint and is not saved by MAYA.
- Internet search requires internet access. Reminder desktop notifications require browser permission and the dashboard to be open.
- Browser speech recognition, screen sharing, and notifications depend on browser support and permissions.

## Security

MAYA listens only on `127.0.0.1`, restricts browser-origin requests, applies a Content Security Policy, and uses an allowlist for app launches. Sensitive smart-home actions require confirmation and an explicit device allowlist. Email is only drafted, file access is read-only except MAYA's own notes, and no free-form command execution is exposed.

## Tests

```bash
python -m unittest discover -s tests -v
```
