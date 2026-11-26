"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const elements = {
  orb: $("#orb-stage"),
  orbCaption: $("#orb-caption"),
  micButton: $("#mic-button"),
  micLabel: $("#mic-label"),
  conversation: $("#conversation-list"),
  input: $("#command-input"),
  reminders: $("#reminders-list"),
  fileList: $("#file-list"),
};
let recognition = null;
let listening = false;
let awakeUntil = 0;
let screenStream = null;
let notifiedReminders = new Set();
let activeLanguage = "en-IN";
let agentMode = false;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Unexpected server response (${response.status})`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  window.setTimeout(() => node.remove(), 4800);
}

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1000));
  utterance.lang = activeLanguage;
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function addMessage(role, text, action = null) {
  const welcome = $(".welcome-message", elements.conversation);
  if (welcome) welcome.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "assistant" ? "M" : "Y";
  const body = document.createElement("div");
  body.className = "message-body";
  const title = document.createElement("strong");
  title.textContent = role === "assistant" ? "MAYA" : "YOU";
  body.append(title, document.createTextNode(text));
  if (action?.url && /^(https:\/\/|mailto:)/.test(action.url)) {
    const link = document.createElement("a");
    link.href = action.url;
    link.textContent = action.label || "Open";
    link.target = action.url.startsWith("mailto:") ? "_self" : "_blank";
    link.rel = "noopener noreferrer";
    link.className = "action-link";
    body.append(document.createElement("br"), link);
  }
  if (Array.isArray(action?.results) && action.results.length) {
    const list = document.createElement("div");
    list.className = "research-results";
    for (const result of action.results) {
      if (!/^(https:\/\/|http:\/\/)/.test(result.url)) continue;
      const item = document.createElement("article");
      item.className = "research-result";
      const link = document.createElement("a");
      link.href = result.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = result.title;
      const snippet = document.createElement("p");
      snippet.textContent = result.snippet;
      item.append(link, snippet);
      list.append(item);
    }
    if (list.childElementCount) body.append(list);
  }
  if (Array.isArray(action?.steps) && action.steps.length) {
    const steps = document.createElement("div");
    steps.className = "agent-steps";
    for (const step of action.steps) {
      const chip = document.createElement("span");
      chip.className = "agent-step";
      chip.textContent = step;
      steps.append(chip);
    }
    body.append(steps);
  }
  row.append(avatar, body);
  elements.conversation.append(row);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function setOrbState(state, caption) {
  elements.orb.classList.toggle("listening", state === "listening");
  elements.orb.classList.toggle("thinking", state === "thinking");
  elements.orbCaption.textContent = caption;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function updateMetric(name, percent, value) {
  $(`#${name}-value`).textContent = value;
  $(`#${name}-bar`).value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const cpu = status.cpu_percent;
    const memory = status.memory;
    updateMetric("cpu", cpu, Number.isFinite(cpu) ? `${Math.round(cpu)}%` : "Unavailable");
    updateMetric("ram", memory?.percent, memory ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : "Unavailable");
    updateMetric("disk", status.disk?.percent, status.disk ? `${formatBytes(status.disk.used)} / ${formatBytes(status.disk.total)}` : "Unavailable");
    $("#platform-label").textContent = status.platform;
    $("#gpu-label").textContent = status.gpu?.available
      ? `GPU · ${status.gpu.name} · ${status.gpu.utilization_percent}%`
      : status.battery
        ? `BATTERY · ${status.battery.percent}%${status.battery.plugged_in ? " · CHARGING" : ""}`
        : "GPU / BATTERY · unavailable";
  } catch (error) {
    toast(`System monitor: ${error.message}`, true);
  }
}

function timeUntil(isoTime) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return "Scheduled";
  if (date.getTime() <= Date.now()) return "Due now";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function notifyDueReminders(reminders) {
  for (const reminder of reminders) {
    if (new Date(reminder.due_at).getTime() <= Date.now() && !notifiedReminders.has(reminder.id)) {
      notifiedReminders.add(reminder.id);
      toast(`Reminder: ${reminder.text}`);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("MAYA reminder", { body: reminder.text });
      }
      speak(`Reminder. ${reminder.text}`);
    }
  }
}

async function refreshReminders() {
  try {
    const { reminders } = await api("/api/reminders");
    elements.reminders.replaceChildren();
    if (!reminders.length) {
      elements.reminders.innerHTML = '<div class="empty-state">No reminders yet.</div>';
      return;
    }
    notifyDueReminders(reminders);
    for (const reminder of reminders) {
      const row = document.createElement("div");
      row.className = "reminder-item";
      const done = document.createElement("button");
      done.className = "reminder-check";
      done.setAttribute("aria-label", `Complete reminder: ${reminder.text}`);
      done.addEventListener("click", async () => {
        try {
          await api(`/api/reminders/${reminder.id}/complete`, { method: "POST", body: "{}" });
          refreshReminders();
        } catch (error) {
          toast(error.message, true);
        }
      });
      const copy = document.createElement("div");
      copy.className = "reminder-copy";
      const text = document.createElement("strong");
      text.textContent = reminder.text;
      const due = document.createElement("small");
      due.textContent = timeUntil(reminder.due_at);
      copy.append(text, due);
      row.append(done, copy);
      elements.reminders.append(row);
    }
  } catch (error) {
    toast(`Reminders: ${error.message}`, true);
  }
}

function renderFiles(files) {
  elements.fileList.replaceChildren();
  if (!files.length) {
    elements.fileList.innerHTML = '<div class="empty-state">No supported files found in Documents, Downloads, or Desktop.</div>';
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-item";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;
    const meta = document.createElement("small");
    meta.className = "file-meta";
    meta.textContent = `${file.folder} · ${file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "Document"}`;
    info.append(name, meta);
    const open = document.createElement("button");
    open.className = "file-open";
    open.textContent = "Read";
    open.addEventListener("click", async () => {
      open.disabled = true;
      try {
        const documentData = await api("/api/files/read", {
          method: "POST",
          body: JSON.stringify({ path: file.path }),
        });
        addMessage("assistant", `${documentData.name}\n\n${documentData.text || "(No extractable text found.)"}`);
        switchView("assistant");
      } catch (error) {
        toast(error.message, true);
      } finally {
        open.disabled = false;
      }
    });
    const actions = document.createElement("div");
    actions.className = "file-actions";
    actions.append(open);
    const summarize = document.createElement("button");
    summarize.className = "file-open";
    summarize.textContent = "Summarize";
    summarize.addEventListener("click", async () => {
      summarize.disabled = true;
      try {
        const documentData = await api("/api/files/read", {
          method: "POST",
          body: JSON.stringify({ path: file.path }),
        });
        const response = await api("/api/chat", {
          method: "POST",
          body: JSON.stringify({
            skill: "summarize",
            text: `Summarize this document. Keep the key facts and caveats.\n\nDocument: ${documentData.name}\n\n${documentData.text.slice(0, 3400)}`,
          }),
        });
        addMessage("assistant", `${documentData.name}\n\n${response.text}`);
        switchView("assistant");
        await refreshMemory();
      } catch (error) {
        toast(error.message, true);
      } finally {
        summarize.disabled = false;
      }
    });
    actions.append(summarize);
    row.append(info, actions);
    elements.fileList.append(row);
  }
}

async function refreshFiles(query = "") {
  try {
    const { files } = await api(`/api/files?q=${encodeURIComponent(query)}`);
    renderFiles(files);
  } catch (error) {
    elements.fileList.textContent = error.message;
    toast(`Files: ${error.message}`, true);
  }
}

function renderMemory(data) {
  const preferences = $("#preferences-list");
  preferences.replaceChildren();
  if (!data.preferences.length) {
    preferences.innerHTML = '<div class="empty-state">Nothing remembered yet. Say “remember that …” to add a preference.</div>';
  } else {
    for (const item of data.preferences) {
      const node = document.createElement("div");
      node.className = "preference-item";
      node.textContent = item;
      preferences.append(node);
    }
  }
  const history = $("#memory-history");
  history.replaceChildren();
  if (!data.messages.length) {
    history.innerHTML = '<div class="empty-state">Your recent AI conversation will appear here.</div>';
  } else {
    for (const item of data.messages) {
      const row = document.createElement("div");
      row.className = `history-item ${item.role}`;
      const role = document.createElement("span");
      role.className = "history-role";
      role.textContent = item.role === "assistant" ? "MAYA" : "YOU";
      const text = document.createElement("span");
      text.className = "history-text";
      text.textContent = item.content;
      row.append(role, text);
      history.append(row);
    }
  }
}

async function refreshMemory() {
  try {
    renderMemory(await api("/api/history"));
  } catch (error) {
    toast(`Memory: ${error.message}`, true);
  }
}

async function refreshSettings() {
  try {
    const data = await api("/api/settings");
    $("#ai-dot").classList.toggle("ready", data.local_ai);
    $("#ai-status").textContent = data.local_ai ? "Local AI connected" : "Local AI offline";
    $("#ai-model").textContent = data.ai_model;
    $("#skill-count").textContent = `${data.skills.length} built-in skills`;
    const pill = $("#home-pill");
    const status = $("#home-status");
    const devices = $("#device-list");
    pill.textContent = data.smart_home_configured ? "CONNECTED" : "NOT CONNECTED";
    pill.classList.toggle("connected", data.smart_home_configured);
    status.textContent = data.smart_home_configured
      ? `${data.smart_home_entities.length} allowlisted device${data.smart_home_entities.length === 1 ? "" : "s"} available. Every action asks first.`
      : "Home Assistant is not configured. See the secure setup details below.";
    devices.replaceChildren();
    for (const entity of data.smart_home_entities) {
      const row = document.createElement("div");
      row.className = "device-item";
      const info = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = entity;
      const kind = document.createElement("small");
      kind.textContent = entity.split(".")[0].replaceAll("_", " ");
      info.append(name, kind);
      const buttons = document.createElement("div");
      buttons.className = "device-buttons";
      for (const action of ["turn_on", "turn_off"]) {
        const button = document.createElement("button");
        button.textContent = action === "turn_on" ? "Turn on" : "Turn off";
        button.addEventListener("click", () => confirmHomeAction(entity, action));
        buttons.append(button);
      }
      row.append(info, buttons);
      devices.append(row);
    }
  } catch (error) {
    $("#ai-status").textContent = "Service unavailable";
    toast(`Settings: ${error.message}`, true);
  }
}

async function confirmHomeAction(entityId, service) {
  const verb = service === "turn_on" ? "turn on" : "turn off";
  if (!window.confirm(`MAYA will ${verb} ${entityId}. Continue?`)) return;
  try {
    const result = await api("/api/home", {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId, service }),
    });
    addMessage("assistant", result.text);
    speak(result.text);
  } catch (error) {
    toast(error.message, true);
  }
}

function switchView(name) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  const titles = {
    assistant: "Assistant",
    devices: "Smart home",
    files: "Files & notes",
    memory: "Memory",
    skills: "Built-in skills",
  };
  $("#page-title").textContent = titles[name] || titles.assistant;
}

function displayStatus(data) {
  const cpu = Number.isFinite(data.cpu_percent) ? `${Math.round(data.cpu_percent)}%` : "not available";
  const ram = data.memory ? `${data.memory.percent}% (${formatBytes(data.memory.used)} of ${formatBytes(data.memory.total)})` : "not available";
  const disk = data.disk ? `${data.disk.percent}% used` : "not available";
  return `System health — CPU ${cpu}; memory ${ram}; disk ${disk}.`;
}

async function handleResult(result, voiceResponse = false) {
  if (result.kind === "workflow") {
    for (const step of result.results) await handleResult(step, voiceResponse);
    return;
  }
  if (result.kind === "diagnostics") {
    const checks = (result.checks || [])
      .map((check) => `${check.status === "ok" ? "OK" : "ACTION NEEDED"} · ${check.name}: ${check.detail}`)
      .join("\n");
    const text = `${result.summary}\n${checks}`;
    addMessage("assistant", text);
    if (voiceResponse) speak(result.summary);
  } else if (result.kind === "status") {
    const status = await api("/api/status");
    const text = displayStatus(status);
    addMessage("assistant", text);
    if (voiceResponse) speak(text);
  } else if (result.kind === "search") {
    let results = [];
    try {
      ({ results } = await api(`/api/research?q=${encodeURIComponent(result.query)}`));
    } catch (error) {
      toast(`Web research: ${error.message}. Search can still open in your browser.`, true);
    }
    const text = results.length
      ? `I found ${results.length} web sources for “${result.query}”. Review their snippets and open any source to verify it.`
      : `Search results for “${result.query}” are ready.`;
    addMessage("assistant", text, { url: result.url, label: "Open search ↗", results });
    if (voiceResponse) speak(text);
  } else if (result.kind === "email") {
    addMessage("assistant", "Draft ready. Review and send it in your mail app.", { url: result.url, label: "Open email draft ↗" });
    if (voiceResponse) speak("Your email draft is ready. Tap the link to review it in your mail app.");
  } else if (result.kind === "files") {
    addMessage("assistant", result.text || `Found ${result.files.length} files.`);
    renderFiles(result.files || []);
    switchView("files");
    if (voiceResponse) speak(result.text || "I found your files.");
  } else if (result.kind === "reminder") {
    addMessage("assistant", result.text || "Reminder set.");
    await refreshReminders();
    if (voiceResponse) speak(result.text || "Reminder set.");
  } else if (result.kind === "home_confirmation") {
    if (!window.confirm(`${result.text}\n\nMAYA will only control allowlisted devices.`)) return;
    const response = await api("/api/home", {
      method: "POST",
      body: JSON.stringify({ entity_id: result.entity_id, service: result.service }),
    });
    addMessage("assistant", response.text);
    if (voiceResponse) speak(response.text);
  } else if (result.kind === "chat") {
    elements.orb.classList.add("thinking");
    setOrbState("thinking", "THINKING");
    try {
      const response = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ text: result.text, skill: result.skill || "assistant" }),
      });
      addMessage("assistant", response.text);
      if (voiceResponse) speak(response.text);
      await refreshMemory();
    } finally {
      setOrbState(listening ? "listening" : "ready", listening ? "LISTENING FOR WAKE WORD" : "SYSTEM ONLINE");
    }
  } else {
    const text = result.text || "Done.";
    addMessage("assistant", text);
    if (voiceResponse) speak(text);
    if (/saved your note/i.test(text)) refreshFiles();
  }
}

async function executeCommand(text, voiceResponse = false) {
  if (!text.trim()) return;
  addMessage("user", text);
  elements.input.value = "";
  setOrbState("thinking", "PROCESSING");
  try {
    const result = await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (agentMode && result.kind === "chat") {
      await executeAgent(result.text, voiceResponse, false);
    } else {
      await handleResult(result, voiceResponse);
    }
  } catch (error) {
    addMessage("assistant", error.message);
    toast(error.message, true);
    if (voiceResponse) speak(error.message);
  } finally {
    setOrbState(listening ? "listening" : "ready", listening ? "LISTENING FOR WAKE WORD" : "SYSTEM ONLINE");
  }
}

async function executeAgent(text, voiceResponse = false, includeUser = true) {
  if (!text.trim()) return;
  if (includeUser) addMessage("user", text);
  setOrbState("thinking", "PLANNING");
  try {
    const result = await api("/api/agent", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    addMessage("assistant", result.text, { steps: result.steps });
    if (voiceResponse) speak(result.text);
    await refreshMemory();
  } catch (error) {
    addMessage("assistant", error.message);
    toast(`Agent mode: ${error.message}`, true);
    if (voiceResponse) speak(error.message);
  } finally {
    setOrbState(listening ? "listening" : "ready", listening ? "LISTENING FOR WAKE WORD" : "SYSTEM ONLINE");
  }
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    elements.micButton.disabled = true;
    elements.micButton.title = "Speech recognition is not supported in this browser. You can still type commands.";
    elements.micLabel.textContent = "Voice unavailable";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.lang = activeLanguage;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (!event.results[index].isFinal) continue;
      const transcript = event.results[index][0].transcript.trim();
      const wake = transcript.match(/^(?:hey\s+jarvis|jarvis|हे\s*जार्विस|जार्विस)[,\s.!-]*(.*)$/i);
      if (wake) {
        const spokenCommand = wake[1].trim();
        awakeUntil = Date.now() + 10_000;
        if (spokenCommand) {
          awakeUntil = 0;
          executeCommand(spokenCommand, true);
        } else {
          setOrbState("listening", "I'M LISTENING");
          speak("I'm listening.");
          window.setTimeout(() => {
            if (listening && Date.now() > awakeUntil) setOrbState("listening", "LISTENING FOR WAKE WORD");
          }, 10_100);
        }
      } else if (Date.now() < awakeUntil) {
        awakeUntil = 0;
        executeCommand(transcript, true);
      }
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      listening = false;
      updateMicState();
      toast("Microphone permission was denied. Allow it in your browser settings.", true);
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      toast(`Voice recognition: ${event.error}. Check browser speech support.`, true);
    }
  };
  recognition.onend = () => {
    if (listening) {
      try { recognition.start(); } catch { /* The browser may already be restarting recognition. */ }
    }
  };
}

function updateMicState() {
  elements.micButton.classList.toggle("listening", listening);
  elements.micButton.setAttribute("aria-label", listening ? "Stop voice listening" : "Start voice listening");
  elements.micLabel.textContent = listening ? "Stop listening" : "Start listening";
  setOrbState(listening ? "listening" : "ready", listening ? "LISTENING FOR WAKE WORD" : "SYSTEM ONLINE");
}

function toggleListening() {
  if (!recognition) return;
  if (listening) {
    listening = false;
    awakeUntil = 0;
    recognition.stop();
    updateMicState();
  } else {
    activeLanguage = $("#language-select").value;
    recognition.lang = activeLanguage;
    listening = true;
    try {
      recognition.start();
      updateMicState();
    } catch (error) {
      listening = false;
      updateMicState();
      toast(`Could not start voice recognition: ${error.message}`, true);
    }
  }
}

async function analyzeScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Screen sharing is not available in this browser.", true);
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = $("#screen-video");
    video.srcObject = screenStream;
    await video.play();
    await new Promise((resolve) => {
      if (video.videoWidth) resolve();
      else video.addEventListener("loadedmetadata", resolve, { once: true });
    });
    const scale = Math.min(1, 1280 / video.videoWidth, 900 / video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.72);
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
    video.srcObject = null;
    addMessage("user", "Analyze my shared screen");
    setOrbState("thinking", "ANALYZING SCREEN");
    const response = await api("/api/screen", {
      method: "POST",
      body: JSON.stringify({ image, question: "Describe what is visible on this screen and help me understand it. Do not assume or perform any action." }),
    });
    addMessage("assistant", response.text);
  } catch (error) {
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = null;
    $("#screen-video").srcObject = null;
    if (error.name !== "NotAllowedError") toast(`Screen analysis: ${error.message}`, true);
  } finally {
    setOrbState(listening ? "listening" : "ready", listening ? "LISTENING FOR WAKE WORD" : "SYSTEM ONLINE");
  }
}

function setup() {
  const now = new Date();
  const hour = now.getHours();
  $("#page-title").textContent = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
  $("#today-label").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
  activeLanguage = $("#language-select").value;
  setupRecognition();
  elements.micButton.addEventListener("click", toggleListening);
  $("#language-select").addEventListener("change", (event) => {
    activeLanguage = event.target.value;
    if (listening && recognition) {
      recognition.stop();
      recognition.lang = activeLanguage;
    }
  });
  $("#command-form").addEventListener("submit", (event) => {
    event.preventDefault();
    executeCommand(elements.input.value);
  });
  $("#agent-mode-button").addEventListener("click", (event) => {
    agentMode = !agentMode;
    event.currentTarget.setAttribute("aria-pressed", String(agentMode));
    event.currentTarget.textContent = agentMode ? "AGENT ON" : "AGENT OFF";
    event.currentTarget.title = agentMode
      ? "Agent mode uses local AI to plan and run up to three safe, read-only tools"
      : "Direct mode runs explicit built-in commands";
    toast(agentMode
      ? "Agent mode on. MAYA can search, inspect system health, and find file names."
      : "Direct mode on. Existing voice commands continue to work.");
  });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-skill-start]").forEach((button) => button.addEventListener("click", () => {
    const starters = {
      research: "research ",
      coding: "help me code ",
      debugging: "Fix this bug: ",
      writing: "help me write ",
      summarize: null,
      translate: "translate ",
      planner: "plan ",
      study: "teach me ",
      brainstorm: "brainstorm ",
      productivity: null,
      system: "What's my system status?",
      self_recovery: "Run MAYA self-check",
      smart_home: null,
      vision: null,
    };
    const skill = button.dataset.skillStart;
    if (skill === "summarize" || skill === "productivity") {
      switchView("files");
      if (skill === "productivity") $("#note-input").focus();
      else toast("Choose a document and select Summarize.");
    } else if (skill === "smart_home") {
      switchView("devices");
    } else if (skill === "vision") {
      switchView("assistant");
      analyzeScreen();
    } else if (skill === "self_recovery") {
      switchView("assistant");
      executeCommand(starters[skill]);
    } else {
      switchView("assistant");
      if (skill === "system") executeCommand(starters[skill]);
      else {
        elements.input.value = starters[skill];
        elements.input.focus();
      }
    }
  }));
  $("#analyze-screen-button").addEventListener("click", analyzeScreen);
  $$("[data-command]").forEach((button) => button.addEventListener("click", () => {
    const command = button.dataset.command;
    if (command.endsWith(": ")) {
      switchView("files");
      $("#note-input").focus();
    } else {
      executeCommand(command);
    }
  }));
  $("#add-reminder-button").addEventListener("click", () => {
    $("#reminder-form").classList.toggle("hidden");
    $("#reminder-text").focus();
  });
  $("#reminder-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#reminder-text").value.trim();
    const minutes = Number($("#reminder-minutes").value);
    if (!text || !Number.isInteger(minutes) || minutes < 1) return;
    try {
      const result = await api("/api/reminders", {
        method: "POST",
        body: JSON.stringify({ text, seconds: minutes * 60 }),
      });
      $("#reminder-text").value = "";
      $("#reminder-form").classList.add("hidden");
      addMessage("assistant", `Reminder set for ${timeUntil(result.reminder.due_at)}.`);
      refreshReminders();
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("#notification-button").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      toast("Desktop notifications are not supported in this browser.", true);
      return;
    }
    const permission = await Notification.requestPermission();
    toast(permission === "granted" ? "Reminder notifications enabled." : "Notification permission was not granted.");
  });
  $("#file-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshFiles($("#file-search-input").value.trim());
  });
  $("#file-search-input").addEventListener("input", (event) => {
    window.clearTimeout(event.target.searchTimer);
    event.target.searchTimer = window.setTimeout(() => refreshFiles(event.target.value.trim()), 250);
  });
  $("#note-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#note-input").value.trim();
    if (!text) return;
    try {
      const result = await api("/api/command", {
        method: "POST",
        body: JSON.stringify({ text: `take a note: ${text}` }),
      });
      $("#note-input").value = "";
      toast(result.text);
      addMessage("assistant", result.text);
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("#clear-display-button").addEventListener("click", () => {
    elements.conversation.replaceChildren();
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    welcome.textContent = "Conversation view cleared. Saved memory remains in the local database.";
    elements.conversation.append(welcome);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshStatus();
      refreshReminders();
    }
  });
  refreshStatus();
  refreshReminders();
  refreshSettings();
  refreshFiles();
  refreshMemory();
  window.setInterval(refreshStatus, 5000);
  window.setInterval(refreshReminders, 15000);
  window.setInterval(refreshSettings, 30000);
  window.setInterval(() => {
    if ($("#view-memory").classList.contains("active")) refreshMemory();
  }, 30000);
}

setup();
