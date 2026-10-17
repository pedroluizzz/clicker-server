// admin.js - admin page logic.
// Password-protected (server-side check via "admin:login"). After login,
// the admin can add/remove registered devices (PCs) and alert buttons -
// this is the ONLY place that ever handles a device's deviceId/secret
// pair, besides the agent itself. Operators (index.html/app.js) never see
// this data; they only get a device's nickname + online status.

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  loginSection: document.getElementById("loginSection"),
  passwordInput: document.getElementById("passwordInput"),
  loginBtn: document.getElementById("loginBtn"),
  loginHint: document.getElementById("loginHint"),
  adminSection: document.getElementById("adminSection"),
  buttonsAdminSection: document.getElementById("buttonsAdminSection"),
  devicesList: document.getElementById("devicesList"),
  addDeviceToggleBtn: document.getElementById("addDeviceToggleBtn"),
  addDeviceForm: document.getElementById("addDeviceForm"),
  newDeviceNickname: document.getElementById("newDeviceNickname"),
  newDeviceId: document.getElementById("newDeviceId"),
  newDeviceSecret: document.getElementById("newDeviceSecret"),
  saveDeviceBtn: document.getElementById("saveDeviceBtn"),
  cancelDeviceBtn: document.getElementById("cancelDeviceBtn"),
  buttonsList: document.getElementById("buttonsList"),
  addButtonToggleBtn: document.getElementById("addButtonToggleBtn"),
  addButtonForm: document.getElementById("addButtonForm"),
  newButtonLabel: document.getElementById("newButtonLabel"),
  newButtonSound: document.getElementById("newButtonSound"),
  saveButtonBtn: document.getElementById("saveButtonBtn"),
  cancelButtonBtn: document.getElementById("cancelButtonBtn"),
  toast: document.getElementById("toast"),
};

let socket = io();
let token = sessionStorage.getItem("clicker.adminToken") || null;
let devices = [];
let buttons = [];

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

function showLoggedIn() {
  els.loginSection.classList.add("hidden");
  els.adminSection.classList.remove("hidden");
  els.buttonsAdminSection.classList.remove("hidden");
}

function showLoggedOut(message) {
  token = null;
  sessionStorage.removeItem("clicker.adminToken");
  els.loginSection.classList.remove("hidden");
  els.adminSection.classList.add("hidden");
  els.buttonsAdminSection.classList.add("hidden");
  if (message) els.loginHint.textContent = message;
}

// --- Login --------------------------------------------------------------

els.loginBtn.addEventListener("click", () => {
  const password = els.passwordInput.value;
  if (!password) {
    els.loginHint.textContent = "Digite a senha";
    return;
  }
  socket.emit("admin:login", { password }, (res) => {
    if (!res || !res.ok) {
      els.loginHint.textContent = (res && res.error) || "Falha ao entrar";
      return;
    }
    token = res.token;
    sessionStorage.setItem("clicker.adminToken", token);
    els.loginHint.textContent = "";
    els.passwordInput.value = "";
    showLoggedIn();
    refreshState();
  });
});

els.passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.loginBtn.click();
});

function refreshState() {
  socket.emit("admin:getState", { token }, (res) => {
    if (!res || !res.ok) {
      showLoggedOut(res && res.error);
      return;
    }
    applyState(res);
  });
}

function applyState(state) {
  devices = state.devices || [];
  buttons = state.buttons || [];
  renderDevices();
  renderButtonsList();

  const onlineCount = devices.filter((d) => d.online).length;
  setStatus(devices.length === 0 ? "offline" : onlineCount === devices.length ? "online" : "connecting", `${onlineCount}/${devices.length} PCs online`);
}

socket.on("connect", () => {
  if (token) {
    showLoggedIn();
    refreshState();
  }
});

// state:update is broadcast to everyone (operators + admins) whenever
// devices/buttons change or an agent connects/disconnects - keep the admin
// view live without needing to poll.
socket.on("state:update", (state) => {
  if (token) applyState(state);
});

socket.on("disconnect", () => setStatus("offline", "Desconectado do servidor"));

// --- Devices --------------------------------------------------------------

function renderDevices() {
  els.devicesList.innerHTML = "";
  if (devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhum PC cadastrado ainda. Clique em "+ Adicionar PC".';
    els.devicesList.appendChild(empty);
  }

  devices.forEach((d) => {
    const row = document.createElement("div");
    row.className = "device-row";
    row.innerHTML =
      `<span class="dot ${d.online ? "online" : "offline"}"></span>` +
      `<span class="device-nickname">${escapeHtml(d.nickname)}</span>` +
      `<span class="device-id-badge">${escapeHtml(d.deviceId)}</span>`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      socket.emit("admin:removeDevice", { token, id: d.id }, (res) => {
        if (!res || !res.ok) showToast((res && res.error) || "Erro ao remover", "error");
      });
    });
    row.appendChild(removeBtn);
    els.devicesList.appendChild(row);
  });
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
  const nickname = els.newDeviceNickname.value.trim();
  const deviceId = els.newDeviceId.value.trim();
  const secret = els.newDeviceSecret.value.trim();

  if (!deviceId || !secret) {
    showToast("Preencha Device ID e Secret", "error");
    return;
  }

  socket.emit("admin:addDevice", { token, nickname, deviceId, secret }, (res) => {
    if (!res || !res.ok) {
      showToast((res && res.error) || "Erro ao adicionar", "error");
      return;
    }
    els.newDeviceNickname.value = "";
    els.newDeviceId.value = "";
    els.newDeviceSecret.value = "";
    els.addDeviceForm.classList.add("hidden");
    showToast("PC adicionado!");
  });
});

// --- Buttons --------------------------------------------------------------

function renderButtonsList() {
  els.buttonsList.innerHTML = "";
  if (buttons.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhum botão cadastrado ainda. Clique em "+ Adicionar botão".';
    els.buttonsList.appendChild(empty);
  }

  buttons.forEach((b) => {
    const row = document.createElement("div");
    row.className = "device-row";
    row.innerHTML = `<span class="device-nickname">🔊 ${escapeHtml(b.label)}</span>`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      socket.emit("admin:removeButton", { token, id: b.id }, (res) => {
        if (!res || !res.ok) showToast((res && res.error) || "Erro ao remover", "error");
      });
    });
    row.appendChild(removeBtn);
    els.buttonsList.appendChild(row);
  });
}

els.addButtonToggleBtn.addEventListener("click", () => {
  els.addButtonForm.classList.toggle("hidden");
});

els.cancelButtonBtn.addEventListener("click", () => {
  els.addButtonForm.classList.add("hidden");
  els.newButtonLabel.value = "";
  els.newButtonSound.value = "";
});

els.saveButtonBtn.addEventListener("click", () => {
  const label = els.newButtonLabel.value.trim();
  const systemSound = els.newButtonSound.value || null;

  if (!label) {
    showToast("Dê um nome ao botão", "error");
    return;
  }

  socket.emit("admin:addButton", { token, label, systemSound }, (res) => {
    if (!res || !res.ok) {
      showToast((res && res.error) || "Erro ao adicionar", "error");
      return;
    }
    els.newButtonLabel.value = "";
    els.newButtonSound.value = "";
    els.addButtonForm.classList.add("hidden");
    showToast("Botão adicionado!");
  });
});
