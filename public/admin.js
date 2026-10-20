// admin.js - admin page logic.
// Password-protected (server-side check via "admin:login"). After login,
// the admin can create/rename/activate/deactivate/remove license keys and
// manage alert buttons - this is the ONLY place that ever handles a
// license key besides the agent itself. Operators (index.html/app.js)
// never see this data; they only click buttons.

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  loginSection: document.getElementById("loginSection"),
  passwordInput: document.getElementById("passwordInput"),
  loginBtn: document.getElementById("loginBtn"),
  loginHint: document.getElementById("loginHint"),
  adminSection: document.getElementById("adminSection"),
  buttonsAdminSection: document.getElementById("buttonsAdminSection"),
  licensesList: document.getElementById("licensesList"),
  addLicenseBtn: document.getElementById("addLicenseBtn"),
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
let licenses = [];
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
  licenses = state.licenses || [];
  buttons = state.buttons || [];
  renderLicenses();
  renderButtonsList();

  const activeLicenses = licenses.filter((l) => l.active);
  const onlineCount = activeLicenses.filter((l) => l.online).length;
  setStatus(
    activeLicenses.length === 0 ? "offline" : onlineCount === activeLicenses.length ? "online" : "connecting",
    `${onlineCount}/${activeLicenses.length} PCs online`
  );
}

socket.on("connect", () => {
  if (token) {
    showLoggedIn();
    refreshState();
  }
});

// state:update is broadcast to everyone (operators + admins) whenever
// licenses/buttons change or an agent connects/disconnects - keep the admin
// view live without needing to poll.
socket.on("state:update", (state) => {
  if (token) applyState(state);
});

socket.on("disconnect", () => setStatus("offline", "Desconectado do servidor"));

// --- Licenses --------------------------------------------------------------

function renderLicenses() {
  els.licensesList.innerHTML = "";
  if (licenses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhuma licença cadastrada. Clique em "+ Gerar nova licença".';
    els.licensesList.appendChild(empty);
  }

  licenses.forEach((l) => {
    const row = document.createElement("div");
    row.className = "device-row" + (l.active ? "" : " inactive");

    const dot = document.createElement("span");
    dot.className = `dot ${l.active && l.online ? "online" : "offline"}`;
    row.appendChild(dot);

    const labelInput = document.createElement("input");
    labelInput.className = "license-label-input";
    labelInput.type = "text";
    labelInput.placeholder = "Apelido (ex: PC do Escritório)";
    labelInput.value = l.label || "";
    labelInput.addEventListener("change", () => {
      socket.emit("admin:renameLicense", { token, key: l.key, label: labelInput.value.trim() }, (res) => {
        if (!res || !res.ok) showToast((res && res.error) || "Erro ao renomear", "error");
      });
    });
    row.appendChild(labelInput);

    const keyBadge = document.createElement("span");
    keyBadge.className = "device-id-badge";
    keyBadge.textContent = l.key;
    keyBadge.title = "Clique para copiar";
    keyBadge.style.cursor = "pointer";
    keyBadge.addEventListener("click", () => {
      navigator.clipboard.writeText(l.key).then(() => showToast("Licença copiada!"));
    });
    row.appendChild(keyBadge);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "secondary";
    toggleBtn.textContent = l.active ? "Desativar" : "Ativar";
    toggleBtn.addEventListener("click", () => {
      socket.emit("admin:setLicenseActive", { token, key: l.key, active: !l.active }, (res) => {
        if (!res || !res.ok) showToast((res && res.error) || "Erro ao atualizar", "error");
      });
    });
    row.appendChild(toggleBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      if (!confirm(`Remover a licença ${l.key} de vez? Isso não pode ser desfeito.`)) return;
      socket.emit("admin:removeLicense", { token, key: l.key }, (res) => {
        if (!res || !res.ok) showToast((res && res.error) || "Erro ao remover", "error");
      });
    });
    row.appendChild(removeBtn);

    els.licensesList.appendChild(row);
  });
}

els.addLicenseBtn.addEventListener("click", () => {
  socket.emit("admin:addLicense", { token, label: "" }, (res) => {
    if (!res || !res.ok) {
      showToast((res && res.error) || "Erro ao gerar licença", "error");
      return;
    }
    showToast(`Licença ${res.key} criada!`);
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

