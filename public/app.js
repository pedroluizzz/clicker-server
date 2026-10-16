// app.js - frontend logic for the remote control web page.
// Talks to the relay server over Socket.IO. Supports pairing with SEVERAL
// PCs at once (one browser page -> many agents), persisted in localStorage.
// Every button always sends its command to ALL currently added PCs - if two
// PCs are paired, every button fires on both automatically.

const MAX_BUTTONS = 5;

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  devicesList: document.getElementById("devicesList"),
  addDeviceToggleBtn: document.getElementById("addDeviceToggleBtn"),
  addDeviceForm: document.getElementById("addDeviceForm"),
  newDeviceNickname: document.getElementById("newDeviceNickname"),
  newDeviceId: document.getElementById("newDeviceId"),
  newDeviceSecret: document.getElementById("newDeviceSecret"),
  saveDeviceBtn: document.getElementById("saveDeviceBtn"),
  cancelDeviceBtn: document.getElementById("cancelDeviceBtn"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  dashboardSection: document.getElementById("dashboardSection"),
  noDevicesHint: document.getElementById("noDevicesHint"),
  multiDeviceHint: document.getElementById("multiDeviceHint"),
  editToggleBtn: document.getElementById("editToggleBtn"),
  buttonsGrid: document.getElementById("buttonsGrid"),
  editPanel: document.getElementById("editPanel"),
  btnLabel: document.getElementById("btnLabel"),
  btnType: document.getElementById("btnType"),
  clickFields: document.getElementById("clickFields"),
  soundFields: document.getElementById("soundFields"),
  btnClickMode: document.getElementById("btnClickMode"),
  coordsFields: document.getElementById("coordsFields"),
  coordsTargetsTable: document.getElementById("coordsTargetsTable"),
  keysFields: document.getElementById("keysFields"),
  modCtrl: document.getElementById("modCtrl"),
  modAlt: document.getElementById("modAlt"),
  modShift: document.getElementById("modShift"),
  modWin: document.getElementById("modWin"),
  btnKey: document.getElementById("btnKey"),
  captureKeyBtn: document.getElementById("captureKeyBtn"),
  captureKeyHint: document.getElementById("captureKeyHint"),
  btnSound: document.getElementById("btnSound"),
  saveButtonBtn: document.getElementById("saveButtonBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  toast: document.getElementById("toast"),
  latencyBar: document.getElementById("latencyBar"),
};

let socket = null;
let editMode = false;
let editingButtonId = null;
let coordsByTargetDraft = {}; // deviceLocalId -> {x, y}, while the edit panel is open

// cmdId -> { sentPerf, batchId?, nickname?, calibrateTargetId? }
const pendingCommands = new Map();
// batchId -> { total, results: [{ nickname, ok, error, execMs, roundTripMs }] }
const batches = new Map();

const deviceStatus = new Map(); // deviceId (from the agent) -> boolean online

let serverUrl = loadServerUrl();
let devices = loadDevices(); // [{ id, nickname, deviceId, secret }]
let buttons = loadButtons();

migrateOldDataIfNeeded();

// --- Persistence ------------------------------------------------------

function loadServerUrl() {
  return localStorage.getItem("clicker.serverUrl") || window.location.origin;
}
function saveServerUrl(url) {
  localStorage.setItem("clicker.serverUrl", url);
}
function loadDevices() {
  try {
    return JSON.parse(localStorage.getItem("clicker.devices")) || [];
  } catch {
    return [];
  }
}
function saveDevices() {
  localStorage.setItem("clicker.devices", JSON.stringify(devices));
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

// Converts data saved by earlier versions of this page (a single
// deviceId/secret pairing, buttons with bare x/y) into the new multi-device
// format, so existing users don't lose their setup.
function migrateOldDataIfNeeded() {
  const oldPairingRaw = localStorage.getItem("clicker.pairing");
  if (!oldPairingRaw) return;

  if (devices.length === 0) {
    try {
      const oldPairing = JSON.parse(oldPairingRaw);
      if (oldPairing && oldPairing.deviceId && oldPairing.secret) {
        const localId = crypto.randomUUID();
        devices = [{ id: localId, nickname: "PC 1", deviceId: oldPairing.deviceId, secret: oldPairing.secret }];
        serverUrl = oldPairing.serverUrl || serverUrl;
        saveDevices();
        saveServerUrl(serverUrl);

        buttons = buttons.map((b) => {
          const nb = { ...b };
          if (b.type === "click" && b.x != null && b.y != null) {
            nb.mode = "coords";
            nb.coordsByTarget = { [localId]: { x: b.x, y: b.y } };
            delete nb.x;
            delete nb.y;
          }
          return nb;
        });
        saveButtons();
      }
    } catch {
      /* ignore malformed old data */
    }
  }

  localStorage.removeItem("clicker.pairing");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showToast(message, type = "success") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), 3500);
}

function setStatus(state, text) {
  els.statusDot.className = `dot ${state}`;
  els.statusText.textContent = text;
}

// --- Connection: one socket, joined to every paired device -----------------

els.serverUrlInput.value = serverUrl;

els.serverUrlInput.addEventListener("change", () => {
  serverUrl = els.serverUrlInput.value.trim() || window.location.origin;
  saveServerUrl(serverUrl);
  connect();
});

function connect() {
  if (socket) socket.disconnect();
  deviceStatus.clear();

  if (devices.length === 0) {
    renderDevices();
    return;
  }

  setStatus("connecting", "Conectando...");
  socket = io(serverUrl, { transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    devices.forEach((d) => joinDevice(d));
  });

  socket.on("device:status", ({ deviceId, online }) => {
    deviceStatus.set(deviceId, online);
    renderDevices();
  });

  socket.on("command:result", (result) => handleCommandResult(result));

  socket.on("connect_error", () => {
    setStatus("offline", "Não foi possível conectar ao servidor");
  });

  socket.on("disconnect", () => {
    deviceStatus.clear();
    renderDevices();
    setStatus("offline", "Desconectado do servidor");
  });
}

function joinDevice(device) {
  if (!socket) return;
  socket.emit("web:join", { deviceId: device.deviceId, secret: device.secret }, (res) => {
    if (!res || !res.ok) {
      showToast(`${device.nickname}: ${(res && res.error) || "Falha ao parear"}`, "error");
      return;
    }
    deviceStatus.set(device.deviceId, res.online);
    renderDevices();
  });
}

connect();

// --- Device management --------------------------------------------------

function updateHeaderSummary() {
  const total = devices.length;
  if (total === 0) {
    setStatus("offline", "Nenhum PC adicionado");
    return;
  }
  const onlineCount = devices.filter((d) => deviceStatus.get(d.deviceId)).length;
  if (onlineCount === total) setStatus("online", `${onlineCount}/${total} PCs online`);
  else if (onlineCount === 0) setStatus("offline", `0/${total} PCs online`);
  else setStatus("connecting", `${onlineCount}/${total} PCs online`);
}

function renderDevices() {
  els.devicesList.innerHTML = "";

  if (devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhum PC adicionado ainda. Clique em "+ Adicionar PC".';
    els.devicesList.appendChild(empty);
  }

  devices.forEach((d) => {
    const online = deviceStatus.get(d.deviceId);
    const row = document.createElement("div");
    row.className = "device-row";
    row.innerHTML =
      `<span class="dot ${online ? "online" : "offline"}"></span>` +
      `<span class="device-nickname">${escapeHtml(d.nickname)}</span>` +
      `<span class="device-id-badge">${escapeHtml(d.deviceId)}</span>`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeDevice(d.id));
    row.appendChild(removeBtn);

    els.devicesList.appendChild(row);
  });

  els.noDevicesHint.classList.toggle("hidden", devices.length > 0);
  els.multiDeviceHint.classList.toggle("hidden", devices.length < 2);
  els.buttonsGrid.classList.toggle("hidden", devices.length === 0);
  els.editToggleBtn.disabled = devices.length === 0;

  updateHeaderSummary();
}

els.addDeviceToggleBtn.addEventListener("click", () => {
  els.addDeviceForm.classList.toggle("hidden");
});

els.cancelDeviceBtn.addEventListener("click", () => {
  els.addDeviceForm.classList.add("hidden");
  els.newDeviceNickname.value = "";
  els.newDeviceId.value = "";
  els.newDeviceSecret.value = "";
});

els.saveDeviceBtn.addEventListener("click", () => {
  const nickname = els.newDeviceNickname.value.trim() || `PC ${devices.length + 1}`;
  const deviceId = els.newDeviceId.value.trim();
  const secret = els.newDeviceSecret.value.trim();

  if (!deviceId || !secret) {
    showToast("Preencha Device ID e Secret", "error");
    return;
  }
  if (devices.some((d) => d.deviceId === deviceId)) {
    showToast("Esse PC já foi adicionado", "error");
    return;
  }

  const device = { id: crypto.randomUUID(), nickname, deviceId, secret };
  devices.push(device);
  saveDevices();

  els.newDeviceNickname.value = "";
  els.newDeviceId.value = "";
  els.newDeviceSecret.value = "";
  els.addDeviceForm.classList.add("hidden");

  renderDevices();
  if (!socket || !socket.connected) connect();
  else joinDevice(device);
  showToast("PC adicionado!");
});

function removeDevice(localId) {
  const device = devices.find((d) => d.id === localId);
  devices = devices.filter((d) => d.id !== localId);
  saveDevices();

  if (device && socket) {
    socket.emit("web:leave", { deviceId: device.deviceId });
    deviceStatus.delete(device.deviceId);
  }

  // Drop any saved coordinates for this device from click/coords buttons -
  // buttons themselves always target every current device, so no "targets"
  // list needs updating, just the per-device coordinates.
  buttons = buttons.map((b) => {
    if (!b.coordsByTarget || !b.coordsByTarget[localId]) return b;
    const cbt = { ...b.coordsByTarget };
    delete cbt[localId];
    return { ...b, coordsByTarget: cbt };
  });
  saveButtons();

  renderDevices();
  renderButtons();
}

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

  if (editMode && buttons.length < MAX_BUTTONS && devices.length > 0) {
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

// --- Edit panel: coordinates per target -----------------------------------
//
// Every button targets ALL currently added devices, so when the action is a
// screen click, we need one X/Y pair per device (screens/resolutions can
// differ) - this renders one row per device, always.

function renderCoordsTargetsTable() {
  els.coordsTargetsTable.innerHTML = "";

  if (devices.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Adicione um PC primeiro.";
    els.coordsTargetsTable.appendChild(hint);
    return;
  }

  devices.forEach((device) => {
    const targetId = device.id;
    const coords = coordsByTargetDraft[targetId] || {};
    const row = document.createElement("div");
    row.className = "coords-target-row";
    row.innerHTML =
      `<label>${escapeHtml(device.nickname)}</label>` +
      `<input type="number" placeholder="X" data-coord="x" data-target="${targetId}" value="${coords.x ?? ""}" />` +
      `<input type="number" placeholder="Y" data-coord="y" data-target="${targetId}" value="${coords.y ?? ""}" />`;

    const calibrateBtn = document.createElement("button");
    calibrateBtn.type = "button";
    calibrateBtn.className = "secondary";
    calibrateBtn.textContent = "📍 Calibrar (4s)";
    calibrateBtn.addEventListener("click", () => calibrateTarget(device, targetId));
    row.appendChild(calibrateBtn);

    row.querySelectorAll("input[data-coord]").forEach((input) => {
      input.addEventListener("input", () => {
        const tId = input.dataset.target;
        const axis = input.dataset.coord;
        coordsByTargetDraft[tId] = coordsByTargetDraft[tId] || {};
        coordsByTargetDraft[tId][axis] = Number(input.value);
      });
    });

    els.coordsTargetsTable.appendChild(row);
  });

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.id = "coordsCalibrateHint";
  els.coordsTargetsTable.appendChild(hint);
}

function calibrateTarget(device, targetId) {
  if (!socket) {
    showToast("Não conectado", "error");
    return;
  }
  const hint = document.getElementById("coordsCalibrateHint");
  let countdown = 4;
  const updateHint = () => {
    if (!hint) return;
    hint.textContent =
      countdown > 0
        ? `Posicione o mouse no PC "${device.nickname}"... ${countdown}`
        : "Capturando posição...";
  };
  updateHint();
  const interval = setInterval(() => {
    countdown -= 1;
    updateHint();
    if (countdown <= 0) clearInterval(interval);
  }, 1000);

  const cmdId = crypto.randomUUID();
  pendingCommands.set(cmdId, { sentPerf: performance.now(), calibrateTargetId: targetId });
  socket.emit(
    "command",
    { deviceId: device.deviceId, secret: device.secret, action: { type: "calibrate", delayMs: 4000 }, sentAt: Date.now(), cmdId },
    (res) => {
      if (!res || !res.ok) {
        pendingCommands.delete(cmdId);
        if (hint) hint.textContent = `Erro: ${(res && res.error) || "falha ao enviar"}`;
      }
    }
  );
}

// --- Edit panel: open/close/save ------------------------------------------

els.btnType.addEventListener("change", () => {
  const isClick = els.btnType.value === "click";
  els.clickFields.classList.toggle("hidden", !isClick);
  els.soundFields.classList.toggle("hidden", isClick);
});

els.btnClickMode.addEventListener("change", () => {
  const isKeys = els.btnClickMode.value === "keys";
  els.coordsFields.classList.toggle("hidden", isKeys);
  els.keysFields.classList.toggle("hidden", !isKeys);
  if (!isKeys) renderCoordsTargetsTable();
});

function openEditPanel(btn) {
  editingButtonId = btn ? btn.id : null;
  els.btnLabel.value = btn ? btn.label : "";
  els.btnType.value = btn ? btn.type : "click";
  els.btnClickMode.value = btn && btn.mode === "keys" ? "keys" : "coords";

  coordsByTargetDraft = btn && btn.coordsByTarget ? JSON.parse(JSON.stringify(btn.coordsByTarget)) : {};
  renderCoordsTargetsTable();

  const mods = (btn && btn.modifiers) || [];
  els.modCtrl.checked = mods.includes("ctrl");
  els.modAlt.checked = mods.includes("alt");
  els.modShift.checked = mods.includes("shift");
  els.modWin.checked = mods.includes("win");
  els.btnKey.value = btn && btn.key ? btn.key : "";
  els.btnSound.value = btn && btn.systemSound ? btn.systemSound : "";
  els.captureKeyHint.textContent =
    'Dica: clique em "Capturar tecla" e pressione a combinação desejada no seu teclado, ou digite manualmente o nome da tecla (ex: F5, Enter, Tab, Delete, A, Numpad1).';

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

// --- Save button ----------------------------------------------------------

els.saveButtonBtn.addEventListener("click", () => {
  const label = els.btnLabel.value.trim();
  const type = els.btnType.value;

  if (!label) {
    showToast("Dê um nome ao botão", "error");
    return;
  }
  if (devices.length === 0) {
    showToast("Adicione um PC primeiro", "error");
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
    const coordsByTarget = {};
    let missing = false;
    devices.forEach((device) => {
      const xInput = els.coordsTargetsTable.querySelector(`input[data-coord="x"][data-target="${device.id}"]`);
      const yInput = els.coordsTargetsTable.querySelector(`input[data-coord="y"][data-target="${device.id}"]`);
      const x = xInput ? Number(xInput.value) : NaN;
      const y = yInput ? Number(yInput.value) : NaN;
      if (Number.isNaN(x) || Number.isNaN(y)) missing = true;
      coordsByTarget[device.id] = { x, y };
    });
    if (missing) {
      showToast("Preencha X e Y para todos os PCs (ou use Calibrar)", "error");
      return;
    }
    newBtn = { id: editingButtonId || crypto.randomUUID(), label, type, mode: "coords", coordsByTarget };
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

// --- Command results / latency -------------------------------------------

function handleCommandResult(result) {
  const { action, ok, error, x, y, cmdId, execMs } = result;
  const pending = cmdId ? pendingCommands.get(cmdId) : null;
  const roundTripMs = pending ? Math.round(performance.now() - pending.sentPerf) : null;
  if (cmdId) pendingCommands.delete(cmdId);

  if (action && action.type === "calibrate" && pending && pending.calibrateTargetId) {
    const targetId = pending.calibrateTargetId;
    const hint = document.getElementById("coordsCalibrateHint");
    if (ok) {
      coordsByTargetDraft[targetId] = { x, y };
      const xInput = els.coordsTargetsTable.querySelector(`input[data-coord="x"][data-target="${targetId}"]`);
      const yInput = els.coordsTargetsTable.querySelector(`input[data-coord="y"][data-target="${targetId}"]`);
      if (xInput) xInput.value = x;
      if (yInput) yInput.value = y;
      if (hint) hint.textContent = `Posição capturada: X=${x}, Y=${y}`;
    } else if (hint) {
      hint.textContent = `Erro ao calibrar: ${error}`;
    }
    return;
  }

  if (!pending || !pending.batchId) return; // stray/unrelated result, ignore

  recordBatchResult(pending.batchId, { nickname: pending.nickname, ok, error, execMs, roundTripMs });
}

function recordBatchResult(batchId, entry) {
  const batch = batches.get(batchId);
  if (!batch) return;
  batch.results.push(entry);
  if (batch.results.length >= batch.total) finalizeBatch(batchId);
}

function finalizeBatch(batchId) {
  const batch = batches.get(batchId);
  batches.delete(batchId);
  if (!batch) return;

  const total = batch.results.length;
  const okCount = batch.results.filter((r) => r.ok).length;

  if (okCount === total) showToast(total > 1 ? `Comando executado em ${total} PCs ✔` : "Comando executado ✔");
  else if (okCount === 0) showToast("Falha em todos os PCs", "error");
  else showToast(`Executado em ${okCount}/${total} PCs`, "error");

  const multi = total > 1;
  const parts = batch.results.map((r) => {
    const label = multi ? `${escapeHtml(r.nickname)}: ` : "";
    return r.ok ? `${label}✔ ${r.roundTripMs ?? "?"}ms` : `${label}❌ ${escapeHtml(r.error || "erro")}`;
  });
  els.latencyBar.innerHTML = parts.join(" &nbsp;•&nbsp; ");
  els.latencyBar.classList.remove("hidden");
}

// --- Sending commands (always to every added device) -----------------------

function sendButtonCommand(btn) {
  if (devices.length === 0) {
    showToast("Nenhum PC adicionado", "error");
    return;
  }
  if (!socket) {
    showToast("Não conectado", "error");
    return;
  }

  const batchId = crypto.randomUUID();
  batches.set(batchId, { total: devices.length, results: [] });

  devices.forEach((device) => {
    let action;
    if (btn.type === "click" && btn.mode === "keys") {
      action = { type: "keypress", modifiers: btn.modifiers || [], key: btn.key };
    } else if (btn.type === "click") {
      const coords = (btn.coordsByTarget && btn.coordsByTarget[device.id]) || {};
      if (coords.x == null || coords.y == null || Number.isNaN(coords.x) || Number.isNaN(coords.y)) {
        // This device was added after the button was created (or coords
        // were never set for it) - skip sending and report it so the user
        // knows to open the button and calibrate for this PC.
        recordBatchResult(batchId, { nickname: device.nickname, ok: false, error: "falta calibrar para este PC" });
        return;
      }
      action = { type: "click", x: coords.x, y: coords.y };
    } else {
      action = btn.systemSound
        ? { type: "sound", systemSound: btn.systemSound }
        : { type: "sound", frequency: 880, duration: 400 };
    }

    const cmdId = crypto.randomUUID();
    pendingCommands.set(cmdId, { sentPerf: performance.now(), batchId, nickname: device.nickname });
    socket.emit(
      "command",
      { deviceId: device.deviceId, secret: device.secret, action, sentAt: Date.now(), cmdId },
      (res) => {
        if (!res || !res.ok) {
          pendingCommands.delete(cmdId);
          recordBatchResult(batchId, { nickname: device.nickname, ok: false, error: (res && res.error) || "Erro ao enviar" });
        }
      }
    );
  });
}

// --- Initial render ---------------------------------------------------

renderDevices();
renderButtons();
