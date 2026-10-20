// app.js - operator page logic.
// Password-protected (a SEPARATE, lower-stakes password from the admin
// one). After logging in, this page only shows the alert buttons that an
// admin configured on the server, and lets the operator click them to
// trigger a sound alert on every PC with an active license.
// License/button configuration lives entirely on the server (server/data/
// store.json) - this page never sees any license key, and the operator
// password only grants permission to view/click buttons, not to add or
// remove anything.

const TOKEN_KEY = "clicker.operatorToken";

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  loginSection: document.getElementById("loginSection"),
  passwordInput: document.getElementById("passwordInput"),
  loginBtn: document.getElementById("loginBtn"),
  loginHint: document.getElementById("loginHint"),
  dashboardSection: document.getElementById("dashboardSection"),
  noButtonsHint: document.getElementById("noButtonsHint"),
  buttonsGrid: document.getElementById("buttonsGrid"),
  toast: document.getElementById("toast"),
  latencyBar: document.getElementById("latencyBar"),
};

let token = localStorage.getItem(TOKEN_KEY) || null;
let buttons = [];
let licenses = [];
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

function showLoggedIn() {
  els.loginSection.classList.add("hidden");
  els.dashboardSection.classList.remove("hidden");
}

function showLoggedOut(message) {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  els.loginSection.classList.remove("hidden");
  els.dashboardSection.classList.add("hidden");
  if (message) els.loginHint.textContent = message;
}

function updateStatusFromLicenses() {
  const active = licenses.filter((l) => l.active);
  const total = active.length;
  if (total === 0) {
    setStatus("offline", "Nenhum PC cadastrado");
    return;
  }
  const onlineCount = active.filter((l) => l.online).length;
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
  socket.emit("operator:trigger", { token, buttonId: btn.id }, (res) => {
    sending = false;
    const roundTripMs = Math.round(performance.now() - t0);

    if (!res) {
      showToast("Erro ao enviar comando", "error");
      return;
    }
    if (res.error && !res.results) {
      if (/sessão/i.test(res.error)) {
        showLoggedOut(res.error);
      } else {
        showToast(res.error, "error");
      }
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

// --- Login ---------------------------------------------------------------

els.loginBtn.addEventListener("click", () => {
  const password = els.passwordInput.value;
  if (!password) {
    els.loginHint.textContent = "Digite a senha";
    return;
  }
  socket.emit("operator:login", { password }, (res) => {
    if (!res || !res.ok) {
      els.loginHint.textContent = (res && res.error) || "Falha ao entrar";
      return;
    }
    token = res.token;
    localStorage.setItem(TOKEN_KEY, token);
    els.loginHint.textContent = "";
    els.passwordInput.value = "";
    showLoggedIn();
    fetchState();
  });
});

els.passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.loginBtn.click();
});

function fetchState() {
  socket.emit("operator:getState", { token }, (res) => {
    if (!res || !res.ok) {
      showLoggedOut(res && res.error);
      return;
    }
    applyState(res);
  });
}

function applyState(state) {
  if (!state) return;
  licenses = state.licenses || [];
  buttons = state.buttons || [];
  updateStatusFromLicenses();
  renderButtons();
}

// --- Connection -------------------------------------------------------

let socket = io();

socket.on("connect", () => {
  if (token) {
    // Try to reuse a previously stored token instead of asking for the
    // password again - if the server restarted (tokens cleared), this
    // fails and we fall back to the login form.
    socket.emit("operator:verifyToken", { token }, (res) => {
      if (res && res.ok) {
        showLoggedIn();
        fetchState();
      } else {
        showLoggedOut();
      }
    });
  } else {
    showLoggedOut();
    setStatus("offline", "Faça login para continuar");
  }
});

socket.on("state:update", (state) => applyState(state));

socket.on("disconnect", () => {
  setStatus("offline", "Desconectado do servidor");
});

socket.on("connect_error", () => {
  setStatus("offline", "Não foi possível conectar ao servidor");
});
