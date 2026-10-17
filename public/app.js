// app.js - frontend logic for the remote control web page.
// Talks to the relay server over Socket.IO. Supports pairing with SEVERAL
// PCs at once (one browser page -> many agents), persisted in localStorage.
// Every button always sends its command to ALL currently added PCs - if two
// PCs are paired, every button fires on both automatically.
//
// Buttons only trigger a sound alert on the target PC(s) - no mouse clicks
// or keyboard shortcuts.

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
  btnSound: document.getElementById("btnSound"),
  saveButtonBtn: document.getElementById("saveButtonBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  toast: document.getElementById("toast"),
  latencyBar: document.getElementById("latencyBar"),
};

let socket = null;
let editMode = false;
let editingButtonId = null;

// cmdId -> { sentPerf, batchId, nickname }
const pendingCommands = new Map();
// batchId -> { total, results: [{ nickname, ok, error, roundTripMs }] }
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
// deviceId/secret pairing) into the new multi-device format.
function migrateOldDataIfNeeded() {
  const oldPairingRaw = localStorage.getItem("clicker.pairing");
  if (!oldPairingRaw) return;

  if (devices.length === 0) {
    try {
      const oldPairing = JSON.parse(oldPairingRaw);
      if (oldPairing && oldPairing.deviceId && oldPairing.secret) {
        devices = [{ id: crypto.randomUUID(), nickname: "PC 1", deviceId: oldPairing.deviceId, secret: oldPairing.secret }];
        serverUrl = oldPairing.serverUrl || serverUrl;
        saveDevices();
        saveServerUrl(serverUrl);
      }
    } catch {
      /* ignore malformed old data */
    }
  }

  localStorage.removeItem("clicker.pairing");
}

// Drop any buttons saved by an earlier version that weren't sound alerts
// (click/keypress buttons) - sound is now the only supported action.
if (buttons.some((b) => b.type && b.type !== "sound")) {
  buttons = buttons.filter((b) => !b.type || b.type === "sound");
  saveButtons();
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

  renderDevices();
  renderButtons();
}

// --- Dashboard: rendering buttons ----------------------------------------

function renderButtons() {
  els.buttonsGrid.innerHTML = "";

  buttons.forEach((btn) => {
    const el = document.createElement("div");
    el.className = "action-button";
    el.textContent = `🔊 ${btn.label}`;

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

// --- Edit panel: open/close/save ------------------------------------------

function openEditPanel(btn) {
  editingButtonId = btn ? btn.id : null;
  els.btnLabel.value = btn ? btn.label : "";
  els.btnSound.value = btn && btn.systemSound ? btn.systemSound : "";
  els.editPanel.classList.remove("hidden");
}

els.cancelEditBtn.addEventListener("click", () => {
  els.editPanel.classList.add("hidden");
  editingButtonId = null;
});

els.saveButtonBtn.addEventListener("click", () => {
  const label = els.btnLabel.value.trim();

  if (!label) {
    showToast("Dê um nome ao botão", "error");
    return;
  }
  if (devices.length === 0) {
    showToast("Adicione um PC primeiro", "error");
    return;
  }

  const newBtn = {
    id: editingButtonId || crypto.randomUUID(),
    label,
    type: "sound",
    systemSound: els.btnSound.value || null,
  };

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
  const { ok, error, cmdId } = result;
  const pending = cmdId ? pendingCommands.get(cmdId) : null;
  const roundTripMs = pending ? Math.round(performance.now() - pending.sentPerf) : null;
  if (cmdId) pendingCommands.delete(cmdId);

  if (!pending || !pending.batchId) return; // stray/unrelated result, ignore

  recordBatchResult(pending.batchId, { nickname: pending.nickname, ok, error, roundTripMs });
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

  const action = btn.systemSound
    ? { type: "sound", systemSound: btn.systemSound }
    : { type: "sound", frequency: 880, duration: 400 };

  devices.forEach((device) => {
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
