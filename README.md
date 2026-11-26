# MAYA — Voice-Controlled AI Assistant

A Python desktop assistant inspired by J.A.R.V.I.S. This project starts with a secure, modular foundation for wake-word voice control, system monitoring, dashboard UI, natural-language commands, reminders, and extensible local/cloud AI.

## Features planned

- `Hey Jarvis` wake-word activation
- Hindi, English, and Hinglish command handling
- Voice input and text-to-speech
- System health monitoring
- Screen and image analysis hooks
- File, document, and PDF tools
- Secure app and PC automation
- Internet search and research tools
- Smart-home integrations
- Persistent preferences and conversation memory
- Animated futuristic dashboard
- Confirmation before sensitive or destructive actions

## Getting started

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
``>

## Security

Sensitive operations require explicit configuration and should use confirmation dialogs. API keys belong in environment variables or a local secret store, never in source control.
