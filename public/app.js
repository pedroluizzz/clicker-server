// app.js - operator page logic.
// No login, no device management: this page only shows the alert buttons
// that an admin configured on the server, and lets anyone with the link
// click them to trigger a sound alert on every registered PC.
// Device/button configuration lives entirely on the server (server/data/
// store.json) - this page never sees a device's deviceId/secret.

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  dashboardSection: document.getElementById("dashboardSection"),
  noButtonsHint: document.getElementById("noButtonsHint"),
  buttonsGrid: document.getElementById("buttonsGrid"),
  toast: document.getElementById("toast"),
  latencyBar: document.getElementById("latencyBar"),
};

let buttons = [];
let devices = [];
let sending = false;

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

function updateStatusFromDevices() {
  const total = devices.length;
  if (total === 0) {
    setStatus("offline", "Nenhum PC cadastrado");
    return;
  }
  const onlineCount = devices.filter((d) => d.online).length;
  if (onlineCount === total) setStatus("online", `${onlineCount}/${total} PCs online`);
  else if (onlineCount === 0) setStatus("offline", `0/${total} PCs online`);
  else setStatus("connecting", `${onlineCount}/${total} PCs online`);
}

function renderButtons() {
  els.buttonsGrid.innerHTML = "";
  els.noButtonsHint.classList.toggle("hidden", buttons.length > 0);

  buttons.forEach((btn) => {
    const el = document.createElement("div");
    el.className = "action-button";
    el.textContent = `🔊 ${btn.label}`;
    el.addEventListener("click", () => triggerButton(btn));
    els.buttonsGrid.appendChild(el);
  });
}

function triggerButton(btn) {
  if (sending) return;
  if (!socket || !socket.connected) {
    showToast("Não conectado ao servidor", "error");
    return;
  }

  sending = true;
  const t0 = performance.now();
  socket.emit("operator:trigger", { buttonId: btn.id }, (res) => {
    sending = false;
    const roundTripMs = Math.round(performance.now() - t0);

    if (!res) {
      showToast("Erro ao enviar comando", "error");
      return;
    }
    if (res.error && !res.results) {
      showToast(res.error, "error");
      return;
    }

    const results = res.results || [];
    const total = results.length;
    const okCount = results.filter((r) => r.ok).length;

    if (okCount === total && total > 0) showToast(total > 1 ? `Alerta disparado em ${total} PCs ✔` : "Alerta disparado ✔");
    else if (okCount === 0) showToast("Falha em todos os PCs", "error");
    else showToast(`Disparado em ${okCount}/${total} PCs`, "error");

    const multi = total > 1;
    const parts = results.map((r) => {
      const label = multi ? `${escapeHtml(r.nickname)}: ` : "";
      return r.ok ? `${label}✔ ${r.execMs ?? "?"}ms` : `${label}❌ ${escapeHtml(r.error || "erro")}`;
    });
    if (total === 1) parts.push(`total: ${roundTripMs}ms`);
    els.latencyBar.innerHTML = parts.join(" &nbsp;•&nbsp; ");
    els.latencyBar.classList.remove("hidden");
  });
}

// --- Connection -------------------------------------------------------

let socket = io();

socket.on("connect", () => {
  socket.emit("operator:getState", (state) => applyState(state));
});

socket.on("state:update", (state) => applyState(state));

socket.on("disconnect", () => {
  setStatus("offline", "Desconectado do servidor");
});

socket.on("connect_error", () => {
  setStatus("offline", "Não foi possível conectar ao servidor");
});

function applyState(state) {
  if (!state) return;
  devices = state.devices || [];
  buttons = state.buttons || [];
  updateStatusFromDevices();
  renderButtons();
}
