// server.js
// Relay server with two separate roles:
//
// - ADMIN (password-protected, public/admin.html): controls which PCs
//   ("devices") are registered and which alert buttons exist. Devices and
//   buttons are stored server-side (server/data/store.json), NOT in the
//   operator's browser - operators never see a device's secret.
// - OPERATOR (public/index.html, no login): just sees the list of alert
//   buttons and can click them. Clicking asks the SERVER to relay the
//   command to every registered device's agent - the operator's browser
//   never talks to an agent directly and never handles deviceId/secret.
//
// The agent (agent/agent.js) still connects here and "registers" itself
// under a deviceId + secret pairing code, same as before - whether that
// device is actually usable by operators depends on whether an admin has
// added it to the registered device list.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;
const COMMAND_TIMEOUT_MS = 8000;

app.use(express.static(path.join(__dirname, "public")));

// --- Persistent store (devices + buttons + admin password) ---------------
// Written to a local JSON file so an admin's setup survives a simple
// restart. Note: on some free hosting plans local disk doesn't survive a
// full redeploy, so the admin password may be re-generated and devices/
// buttons may need to be re-added after deploying a new version - devices
// just need to be re-added with their existing deviceId/secret (the agent
// keeps the same identity), nothing needs to change on the PC side.
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { devices: [], buttons: [], adminPassword: null };
  }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

const store = loadStore();
if (!Array.isArray(store.devices)) store.devices = [];
if (!Array.isArray(store.buttons)) store.buttons = [];

// Resolve the admin password: an explicit ADMIN_PASSWORD env var always
// wins (for deliberate control); otherwise reuse a previously generated one
// so it stays stable across restarts; otherwise generate a fresh one and
// persist + print it, the same way the agent prints its own deviceId/secret.
let adminPassword = process.env.ADMIN_PASSWORD || store.adminPassword;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(6).toString("hex");
  store.adminPassword = adminPassword;
  saveStore();
}

console.log("==============================================");
console.log(" Clicker Server");
if (!process.env.ADMIN_PASSWORD) {
  console.log(" Senha de admin (gerada automaticamente): " + adminPassword);
  console.log(" Dica: defina a variável de ambiente ADMIN_PASSWORD para escolher a sua própria.");
} else {
  console.log(" Senha de admin: definida via variável de ambiente ADMIN_PASSWORD");
}
console.log("==============================================");

// deviceId -> { secret, socketId } - tracks agents currently connected,
// regardless of whether an admin has added them to the registered list yet.
const agents = new Map();

// adminToken -> true, issued on successful admin:login, cleared on restart.
const adminTokens = new Set();

// cmdId -> { resolve } - commands the server itself is waiting on an agent
// to finish, triggered on behalf of an operator click.
const pendingCommands = new Map();

function isDeviceOnline(device) {
  const agent = agents.get(device.deviceId);
  return !!agent && agent.secret === device.secret;
}

function publicState() {
  return {
    devices: store.devices.map((d) => ({ id: d.id, nickname: d.nickname, deviceId: d.deviceId, online: isDeviceOnline(d) })),
    buttons: store.buttons.map((b) => ({ id: b.id, label: b.label, systemSound: b.systemSound })),
  };
}

function broadcastState() {
  io.emit("state:update", publicState());
}

function requireAdmin(token, ack) {
  if (!token || !adminTokens.has(token)) {
    ack && ack({ ok: false, error: "Sessão de admin inválida ou expirada. Faça login novamente." });
    return false;
  }
  return true;
}

// Sends the sound command to one device's connected agent and resolves with
// its result, or resolves with an offline/timeout error if it never
// responds (so one unreachable PC doesn't hang the whole trigger forever).
function sendToDevice(device, action) {
  return new Promise((resolve) => {
    const agent = agents.get(device.deviceId);
    if (!agent || agent.secret !== device.secret) {
      return resolve({ nickname: device.nickname, ok: false, error: "PC offline" });
    }

    const cmdId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingCommands.delete(cmdId);
      resolve({ nickname: device.nickname, ok: false, error: "Tempo esgotado" });
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(cmdId, {
      resolve: (payload) => {
        clearTimeout(timeout);
        resolve({
          nickname: device.nickname,
          ok: !!payload.ok,
          error: payload.error,
          execMs: payload.execMs,
        });
      },
    });

    io.to(agent.socketId).emit("command", { action, cmdId });
  });
}

io.on("connection", (socket) => {
  // --- Agent side -----------------------------------------------------
  socket.on("agent:register", ({ deviceId, secret }, ack) => {
    if (!deviceId || !secret) {
      return ack && ack({ ok: false, error: "deviceId e secret são obrigatórios" });
    }

    const existing = agents.get(deviceId);
    if (existing && existing.secret !== secret) {
      return ack && ack({ ok: false, error: "Já existe um agente com esse deviceId e secret diferente" });
    }

    agents.set(deviceId, { secret, socketId: socket.id });
    socket.data.role = "agent";
    socket.data.deviceId = deviceId;

    console.log(`[agent] registrado: ${deviceId}`);
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("agent:result", (payload) => {
    const pending = payload && payload.cmdId && pendingCommands.get(payload.cmdId);
    if (pending) {
      pendingCommands.delete(payload.cmdId);
      pending.resolve(payload);
    }
  });

  // --- Operator side (no auth; anyone with the link) --------------------
  socket.on("operator:getState", (ack) => {
    ack && ack(publicState());
  });

  socket.on("operator:trigger", async ({ buttonId }, ack) => {
    const button = store.buttons.find((b) => b.id === buttonId);
    if (!button) return ack && ack({ ok: false, error: "Botão não encontrado" });
    if (store.devices.length === 0) return ack && ack({ ok: false, error: "Nenhum PC cadastrado" });

    const action = button.systemSound
      ? { type: "sound", systemSound: button.systemSound }
      : { type: "sound", frequency: 880, duration: 400 };

    const results = await Promise.all(store.devices.map((d) => sendToDevice(d, action)));
    const okCount = results.filter((r) => r.ok).length;
    ack && ack({ ok: okCount === results.length, results });
  });

  // --- Admin side (password-protected) -----------------------------------
  socket.on("admin:login", ({ password }, ack) => {
    if (password !== adminPassword) {
      return ack && ack({ ok: false, error: "Senha incorreta" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    adminTokens.add(token);
    ack && ack({ ok: true, token });
  });

  socket.on("admin:getState", ({ token }, ack) => {
    if (!requireAdmin(token, ack)) return;
    ack && ack({ ok: true, ...publicState() });
  });

  socket.on("admin:addDevice", ({ token, nickname, deviceId, secret }, ack) => {
    if (!requireAdmin(token, ack)) return;
    if (!deviceId || !secret) return ack && ack({ ok: false, error: "deviceId e secret são obrigatórios" });
    if (store.devices.some((d) => d.deviceId === deviceId)) {
      return ack && ack({ ok: false, error: "Esse PC já está cadastrado" });
    }
    store.devices.push({
      id: crypto.randomUUID(),
      nickname: nickname || `PC ${store.devices.length + 1}`,
      deviceId,
      secret,
    });
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:removeDevice", ({ token, id }, ack) => {
    if (!requireAdmin(token, ack)) return;
    store.devices = store.devices.filter((d) => d.id !== id);
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:addButton", ({ token, label, systemSound }, ack) => {
    if (!requireAdmin(token, ack)) return;
    if (!label || !label.trim()) return ack && ack({ ok: false, error: "Informe um nome para o botão" });
    if (store.buttons.length >= 5) return ack && ack({ ok: false, error: "Máximo de 5 botões" });
    store.buttons.push({ id: crypto.randomUUID(), label: label.trim(), systemSound: systemSound || null });
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:removeButton", ({ token, id }, ack) => {
    if (!requireAdmin(token, ack)) return;
    store.buttons = store.buttons.filter((b) => b.id !== id);
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("disconnect", () => {
    if (socket.data.role === "agent" && socket.data.deviceId) {
      const deviceId = socket.data.deviceId;
      const agent = agents.get(deviceId);
      if (agent && agent.socketId === socket.id) {
        agents.delete(deviceId);
        console.log(`[agent] desconectado: ${deviceId}`);
        broadcastState();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
