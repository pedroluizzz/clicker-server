// admin.js - admin page logic.
// Password-protected (server-side check via "admin:login"). After login,
// the admin can create/rename/activate/deactivate/remove license keys and
// manage alert buttons + message presets - this is the ONLY place that
// ever handles a license key or raw audio data besides the agent itself.
// Operators (index.html/app.js) never see this data; they only click
// buttons/messages.

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
  messagesList: document.getElementById("messagesList"),
  addButtonToggleBtn: document.getElementById("addButtonToggleBtn"),
  addMessageToggleBtn: document.getElementById("addMessageToggleBtn"),
  addButtonForm: document.getElementById("addButtonForm"),
  addButtonFormTitle: document.getElementById("addButtonFormTitle"),
  newButtonLabel: document.getElementById("newButtonLabel"),
  newButtonSoundType: document.getElementById("newButtonSoundType"),
  systemSoundRow: document.getElementById("systemSoundRow"),
  newButtonSound: document.getElementById("newButtonSound"),
  customAudioRow: document.getElementById("customAudioRow"),
  newButtonAudioFile: document.getElementById("newButtonAudioFile"),
  saveButtonBtn: document.getElementById("saveButtonBtn"),
  cancelButtonBtn: document.getElementById("cancelButtonBtn"),
  toast: document.getElementById("toast"),
};

let socket = io();
let token = sessionStorage.getItem("clicker.adminToken") || null;
let licenses = [];
let buttons = [];
let pendingCategory = "alert";

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

// --- Buttons & Messages ----------------------------------------------------

function renderPresetRow(container, b) {
  const row = document.createElement("div");
  row.className = "device-row";
  const icon = b.hasCustomAudio ? "🎵" : "🔊";
  row.innerHTML = `<span class="device-nickname">${icon} ${escapeHtml(b.label)}</span>`;

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => {
    socket.emit("admin:removeButton", { token, id: b.id }, (res) => {
      if (!res || !res.ok) showToast((res && res.error) || "Erro ao remover", "error");
    });
  });
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function renderButtonsList() {
  els.buttonsList.innerHTML = "";
  els.messagesList.innerHTML = "";

  const alerts = buttons.filter((b) => (b.category || "alert") !== "message");
  const messages = buttons.filter((b) => b.category === "message");

  if (alerts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhum botão cadastrado ainda. Clique em "+ Adicionar botão".';
    els.buttonsList.appendChild(empty);
  }
  alerts.forEach((b) => renderPresetRow(els.buttonsList, b));

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = 'Nenhuma mensagem cadastrada ainda. Clique em "+ Adicionar mensagem".';
    els.messagesList.appendChild(empty);
  }
  messages.forEach((b) => renderPresetRow(els.messagesList, b));
}

function resetAddButtonForm() {
  els.newButtonLabel.value = "";
  els.newButtonSoundType.value = "tone";
  els.newButtonSound.value = "Asterisk";
  els.newButtonAudioFile.value = "";
  els.systemSoundRow.classList.add("hidden");
  els.customAudioRow.classList.add("hidden");
}

function openAddForm(category) {
  pendingCategory = category;
  els.addButtonFormTitle.textContent = category === "message" ? "Adicionar mensagem" : "Adicionar botão";
  resetAddButtonForm();
  els.addButtonForm.classList.remove("hidden");
}

els.addButtonToggleBtn.addEventListener("click", () => {
  if (!els.addButtonForm.classList.contains("hidden") && pendingCategory === "alert") {
    els.addButtonForm.classList.add("hidden");
  } else {
    openAddForm("alert");
  }
});

els.addMessageToggleBtn.addEventListener("click", () => {
  if (!els.addButtonForm.classList.contains("hidden") && pendingCategory === "message") {
    els.addButtonForm.classList.add("hidden");
  } else {
    openAddForm("message");
  }
});

els.newButtonSoundType.addEventListener("change", () => {
  const v = els.newButtonSoundType.value;
  els.systemSoundRow.classList.toggle("hidden", v !== "system");
  els.customAudioRow.classList.toggle("hidden", v !== "custom");
});

els.cancelButtonBtn.addEventListener("click", () => {
  els.addButtonForm.classList.add("hidden");
  resetAddButtonForm();
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

els.saveButtonBtn.addEventListener("click", async () => {
  const label = els.newButtonLabel.value.trim();
  if (!label) {
    showToast("Dê um nome", "error");
    return;
  }

  const soundType = els.newButtonSoundType.value;
  let systemSound = null;
  let customAudio = null;

  if (soundType === "system") {
    systemSound = els.newButtonSound.value || null;
  } else if (soundType === "custom") {
    const file = els.newButtonAudioFile.files[0];
    if (!file) {
      showToast("Escolha um arquivo de áudio", "error");
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      showToast("Áudio muito grande (máx. 3MB)", "error");
      return;
    }
    let audioBase64;
    try {
      audioBase64 = await readFileAsBase64(file);
    } catch (err) {
      showToast(err.message || "Erro ao ler o arquivo", "error");
      return;
    }
    const ext = "." + (file.name.split(".").pop() || "wav").toLowerCase();
    customAudio = { audioBase64, mimeType: file.type || "audio/wav", ext };
  }

  socket.emit("admin:addButton", { token, label, category: pendingCategory, systemSound, customAudio }, (res) => {
    if (!res || !res.ok) {
      showToast((res && res.error) || "Erro ao adicionar", "error");
      return;
    }
    els.addButtonForm.classList.add("hidden");
    resetAddButtonForm();
    showToast(pendingCategory === "message" ? "Mensagem adicionada!" : "Botão adicionado!");
  });
});

