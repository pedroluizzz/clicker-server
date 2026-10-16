// app.js - frontend logic for the remote control web page.
// Talks to the relay server over Socket.IO and persists pairing +
// button configuration in localStorage so the user doesn't have to
// re-enter everything every time.

const MAX_BUTTONS = 5;

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  pairingSection: document.getElementById("pairingSection"),
  dashboardSection: document.getElementById("dashboardSection"),
  deviceIdInput: document.getElementById("deviceIdInput"),
  secretInput: document.getElementById("secretInput"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  editToggleBtn: document.getElementById("editToggleBtn"),
  buttonsGrid: document.getElementById("buttonsGrid"),
  editPanel: document.getElementById("editPanel"),
  btnLabel: document.getElementById("btnLabel"),
  btnType: document.getElementById("btnType"),
  clickFields: document.getElementById("clickFields"),
  soundFields: document.getElementById("soundFields"),
  btnClickMode: document.getElementById("btnClickMode"),
  coordsFields: document.getElementById("coordsFields"),
  keysFields: document.getElementById("keysFields"),
  btnX: document.getElementById("btnX"),
  btnY: document.getElementById("btnY"),
  modCtrl: document.getElementById("modCtrl"),
  modAlt: document.getElementById("modAlt"),
  modShift: document.getElementById("modShift"),
  modWin: document.getElementById("modWin"),
  btnKey: document.getElementById("btnKey"),
  captureKeyBtn: document.getElementById("captureKeyBtn"),
  captureKeyHint: document.getElementById("captureKeyHint"),
  btnSound: document.getElementById("btnSound"),
  calibrateBtn: document.getElementById("calibrateBtn"),
  calibrateHint: document.getElementById("calibrateHint"),
  saveButtonBtn: document.getElementById("saveButtonBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  toast: document.getElementById("toast"),
  latencyBar: document.getElementById("latencyBar"),
};

let socket = null;
const pendingCommands = new Map(); // cmdId -> { sentPerf }
let editMode = false;
let editingButtonId = null;
let pairing = loadPairing();
let buttons = loadButtons();

function loadPairing() {
  try {
    return JSON.parse(localStorage.getItem("clicker.pairing")) || null;
  } catch {
    return null;
  }
}

function savePairing(p) {
  localStorage.setItem("clicker.pairing", JSON.stringify(p));
}

function loadButtons() {
  try {
    return JSON.parse(localStorage.getItem("clicker.buttons")) || [];
  } catch {
    return [];
  }
}

function saveButtons() {
  localStorage.setItem("clicker.buttons", JSON.stringify(buttons));
}

function showToast(message, type = "success") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), 3000);
}

function setStatus(state, text) {
  els.statusDot.className = `dot ${state}`;
  els.statusText.textContent = text;
}

// --- Pairing / connection -------------------------------------------------

function defaultServerUrl() {
  return window.location.origin;
}

if (pairing) {
  els.deviceIdInput.value = pairing.deviceId;
  els.secretInput.value = pairing.secret;
  els.serverUrlInput.value = pairing.serverUrl || defaultServerUrl();
} else {
  els.serverUrlInput.value = defaultServerUrl();
}

els.connectBtn.addEventListener("click", () => {
  const deviceId = els.deviceIdInput.value.trim();
  const secret = els.secretInput.value.trim();
  const serverUrl = els.serverUrlInput.value.trim() || defaultServerUrl();

  if (!deviceId || !secret) {
    showToast("Preencha Device ID e Secret", "error");
    return;
  }

  pairing = { deviceId, secret, serverUrl };
  savePairing(pairing);
  connect();
});

els.disconnectBtn.addEventListener("click", () => {
  if (socket) socket.disconnect();
  localStorage.removeItem("clicker.pairing");
  pairing = null;
  els.dashboardSection.classList.add("hidden");
  els.pairingSection.classList.remove("hidden");
  setStatus("offline", "Desconectado");
});

function connect() {
  if (socket) socket.disconnect();

  setStatus("connecting", "Conectando...");
  socket = io(pairing.serverUrl, { transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    socket.emit("web:join", { deviceId: pairing.deviceId, secret: pairing.secret }, (res) => {
      if (!res || !res.ok) {
        showToast((res && res.error) || "Falha ao parear", "error");
        setStatus("offline", "Erro de pareamento");
        return;
      }
      els.pairingSection.classList.add("hidden");
      els.dashboardSection.classList.remove("hidden");
      setStatus(res.online ? "online" : "offline", res.online ? "PC conectado" : "PC offline (aguardando agente)");
      renderButtons();
    });
  });

  socket.on("device:status", ({ online }) => {
    setStatus(online ? "online" : "offline", online ? "PC conectado" : "PC offline");
  });

  socket.on("command:result", (result) => {
    handleCommandResult(result);
  });

  socket.on("connect_error", () => {
    setStatus("offline", "Não foi possível conectar ao servidor");
  });

  socket.on("disconnect", () => {
    setStatus("offline", "Desconectado do servidor");
  });
}

if (pairing) connect();

// --- Dashboard: rendering buttons ----------------------------------------

function buttonIcon(btn) {
  if (btn.type === "sound") return "🔊";
  if (btn.mode === "keys") return "⌨️";
  return "📍";
}

function renderButtons() {
  els.buttonsGrid.innerHTML = "";

  buttons.forEach((btn) => {
    const el = document.createElement("div");
    el.className = "action-button";
    el.textContent = `${buttonIcon(btn)} ${btn.label}`;

    if (editMode) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        buttons = buttons.filter((b) => b.id !== btn.id);
        saveButtons();
        renderButtons();
      });
      el.appendChild(removeBtn);
      el.addEventListener("click", () => openEditPanel(btn));
    } else {
      el.addEventListener("click", () => sendButtonCommand(btn));
    }

    els.buttonsGrid.appendChild(el);
  });

  if (editMode && buttons.length < MAX_BUTTONS) {
    const addEl = document.createElement("div");
    addEl.className = "action-button empty";
    addEl.textContent = "+ Adicionar botão";
    addEl.addEventListener("click", () => openEditPanel(null));
    els.buttonsGrid.appendChild(addEl);
  }
}

els.editToggleBtn.addEventListener("click", () => {
  editMode = !editMode;
  els.editToggleBtn.textContent = editMode ? "Concluir edição" : "Editar botões";
  if (!editMode) els.editPanel.classList.add("hidden");
  renderButtons();
});

// --- Edit panel -------------------------------------------------------

els.btnType.addEventListener("change", () => {
  const isClick = els.btnType.value === "click";
  els.clickFields.classList.toggle("hidden", !isClick);
  els.soundFields.classList.toggle("hidden", isClick);
});

els.btnClickMode.addEventListener("change", () => {
  const isKeys = els.btnClickMode.value === "keys";
  els.coordsFields.classList.toggle("hidden", isKeys);
  els.keysFields.classList.toggle("hidden", !isKeys);
});

function openEditPanel(btn) {
  editingButtonId = btn ? btn.id : null;
  els.btnLabel.value = btn ? btn.label : "";
  els.btnType.value = btn ? btn.type : "click";
  els.btnClickMode.value = btn && btn.mode === "keys" ? "keys" : "coords";
  els.btnX.value = btn && btn.x != null ? btn.x : "";
  els.btnY.value = btn && btn.y != null ? btn.y : "";
  const mods = (btn && btn.modifiers) || [];
  els.modCtrl.checked = mods.includes("ctrl");
  els.modAlt.checked = mods.includes("alt");
  els.modShift.checked = mods.includes("shift");
  els.modWin.checked = mods.includes("win");
  els.btnKey.value = btn && btn.key ? btn.key : "";
  els.btnSound.value = btn && btn.systemSound ? btn.systemSound : "";
  els.calibrateHint.textContent = "";
  els.captureKeyHint.textContent = 'Dica: clique em "Capturar tecla" e pressione a combinação desejada no seu teclado, ou digite manualmente o nome da tecla (ex: F5, Enter, Tab, Delete, A, Numpad1).';
  els.btnType.dispatchEvent(new Event("change"));
  els.btnClickMode.dispatchEvent(new Event("change"));
  els.editPanel.classList.remove("hidden");
}

els.cancelEditBtn.addEventListener("click", () => {
  els.editPanel.classList.add("hidden");
  editingButtonId = null;
});

// --- Key combo capture --------------------------------------------------

const KEY_NAME_MAP = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  " ": "Space",
};
const NUMPAD_CODE_MAP = {
  Numpad0: "Numpad0",
  Numpad1: "Numpad1",
  Numpad2: "Numpad2",
  Numpad3: "Numpad3",
  Numpad4: "Numpad4",
  Numpad5: "Numpad5",
  Numpad6: "Numpad6",
  Numpad7: "Numpad7",
  Numpad8: "Numpad8",
  Numpad9: "Numpad9",
  NumpadAdd: "NumpadAdd",
  NumpadSubtract: "NumpadSubtract",
  NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide",
  NumpadDecimal: "NumpadDecimal",
  NumpadEnter: "NumpadEnter",
};
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

function normalizeKeyName(e) {
  // The browser reports the same e.key ("1") for both the regular number row
  // and the numeric keypad - e.code tells them apart (e.g. "Numpad1" vs
  // "Digit1"), which matters because macro tools often bind shortcuts
  // specifically to numpad keys.
  if (NUMPAD_CODE_MAP[e.code]) return NUMPAD_CODE_MAP[e.code];
  if (KEY_NAME_MAP[e.key]) return KEY_NAME_MAP[e.key];
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key; // e.g. "F5", "Enter", "Tab", "Delete", "Home"...
}

let capturingKey = false;

els.captureKeyBtn.addEventListener("click", () => {
  if (capturingKey) return;
  capturingKey = true;
  els.captureKeyBtn.classList.add("listening");
  els.captureKeyHint.textContent = "Pressione a combinação de teclas agora...";

  const onKeyDown = (e) => {
    if (MODIFIER_KEYS.has(e.key)) return; // wait for the "real" key
    e.preventDefault();
    e.stopPropagation();

    els.modCtrl.checked = e.ctrlKey;
    els.modAlt.checked = e.altKey;
    els.modShift.checked = e.shiftKey;
    els.modWin.checked = e.metaKey;
    els.btnKey.value = normalizeKeyName(e);

    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Win");
    parts.push(els.btnKey.value);
    els.captureKeyHint.textContent = `Capturado: ${parts.join(" + ")}`;

    capturingKey = false;
    els.captureKeyBtn.classList.remove("listening");
    window.removeEventListener("keydown", onKeyDown, true);
  };

  window.addEventListener("keydown", onKeyDown, true);
});

els.saveButtonBtn.addEventListener("click", () => {
  const label = els.btnLabel.value.trim();
  const type = els.btnType.value;

  if (!label) {
    showToast("Dê um nome ao botão", "error");
    return;
  }

  let newBtn;
  if (type === "click" && els.btnClickMode.value === "keys") {
    const key = els.btnKey.value.trim();
    if (!key) {
      showToast('Informe a tecla (ou use "Capturar tecla")', "error");
      return;
    }
    const modifiers = [];
    if (els.modCtrl.checked) modifiers.push("ctrl");
    if (els.modAlt.checked) modifiers.push("alt");
    if (els.modShift.checked) modifiers.push("shift");
    if (els.modWin.checked) modifiers.push("win");
    newBtn = { id: editingButtonId || crypto.randomUUID(), label, type, mode: "keys", modifiers, key };
  } else if (type === "click") {
    const x = Number(els.btnX.value);
    const y = Number(els.btnY.value);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      showToast("Preencha X e Y (ou use Calibrar)", "error");
      return;
    }
    newBtn = { id: editingButtonId || crypto.randomUUID(), label, type, mode: "coords", x, y };
  } else {
    newBtn = {
      id: editingButtonId || crypto.randomUUID(),
      label,
      type,
      systemSound: els.btnSound.value || null,
    };
  }

  const idx = buttons.findIndex((b) => b.id === newBtn.id);
  if (idx >= 0) {
    buttons[idx] = newBtn;
  } else {
    if (buttons.length >= MAX_BUTTONS) {
      showToast(`Máximo de ${MAX_BUTTONS} botões`, "error");
      return;
    }
    buttons.push(newBtn);
  }

  saveButtons();
  els.editPanel.classList.add("hidden");
  editingButtonId = null;
  renderButtons();
  showToast("Botão salvo!");
});

// --- Calibration --------------------------------------------------------

let calibrating = false;

els.calibrateBtn.addEventListener("click", () => {
  if (!socket || calibrating) return;
  calibrating = true;
  let countdown = 4;
  els.calibrateHint.textContent = `Posicione o mouse no local desejado no PC alvo... ${countdown}`;
  const interval = setInterval(() => {
    countdown -= 1;
    if (countdown > 0) {
      els.calibrateHint.textContent = `Posicione o mouse no local desejado no PC alvo... ${countdown}`;
    } else {
      clearInterval(interval);
      els.calibrateHint.textContent = "Capturando posição...";
    }
  }, 1000);

  sendCommand({ type: "calibrate", delayMs: 4000 });
});

function handleCommandResult(result) {
  const { action, ok, error, x, y, cmdId, networkMs, execMs } = result;

  // Round-trip is measured entirely with the browser's own clock (click ->
  // server -> agent -> server -> browser), so it doesn't depend on the two
  // machines' clocks being in sync - unlike networkMs/execMs, which come
  // from the agent and rely on Date.now() being reasonably synced.
  let roundTripMs = null;
  if (cmdId && pendingCommands.has(cmdId)) {
    roundTripMs = Math.round(performance.now() - pendingCommands.get(cmdId).sentPerf);
    pendingCommands.delete(cmdId);
  }

  if (action && action.type === "calibrate") {
    calibrating = false;
    if (ok) {
      els.btnX.value = x;
      els.btnY.value = y;
      els.calibrateHint.textContent = `Posição capturada: X=${x}, Y=${y}`;
    } else {
      els.calibrateHint.textContent = `Erro ao calibrar: ${error}`;
    }
    return;
  }

  if (ok) {
    showToast("Comando executado ✔");
    showLatency({ networkMs, execMs, roundTripMs });
  } else {
    showToast(`Erro: ${error}`, "error");
  }
}

function showLatency({ networkMs, execMs, roundTripMs }) {
  if (networkMs == null && roundTripMs == null) {
    els.latencyBar.classList.add("hidden");
    return;
  }
  const parts = [];
  if (networkMs != null) parts.push(`rede (clique → PC): <strong>${networkMs}ms</strong>`);
  if (execMs != null) parts.push(`execução no PC: <strong>${execMs}ms</strong>`);
  if (roundTripMs != null) parts.push(`total (ida e volta): <strong>${roundTripMs}ms</strong>`);
  els.latencyBar.innerHTML = parts.join(" &nbsp;•&nbsp; ");
  els.latencyBar.classList.remove("hidden");
}

// --- Sending commands -----------------------------------------------------

function sendButtonCommand(btn) {
  let action;
  if (btn.type === "click" && btn.mode === "keys") {
    action = { type: "keypress", modifiers: btn.modifiers || [], key: btn.key };
  } else if (btn.type === "click") {
    action = { type: "click", x: btn.x, y: btn.y };
  } else {
    action = btn.systemSound
      ? { type: "sound", systemSound: btn.systemSound }
      : { type: "sound", frequency: 880, duration: 400 };
  }
  sendCommand(action);
}

function sendCommand(action) {
  if (!socket) {
    showToast("Não conectado", "error");
    return;
  }
  const cmdId = crypto.randomUUID();
  pendingCommands.set(cmdId, { sentPerf: performance.now() });
  socket.emit("command", { deviceId: pairing.deviceId, secret: pairing.secret, action, sentAt: Date.now(), cmdId }, (res) => {
    if (!res || !res.ok) {
      pendingCommands.delete(cmdId);
      showToast((res && res.error) || "Erro ao enviar comando", "error");
    }
  });
}
