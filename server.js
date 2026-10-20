// server.js
// Relay server with two separate roles:
//
// - ADMIN (password-protected, public/admin.html): controls which license
//   keys exist and are active, and manages two kinds of presets - "alert"
//   buttons and "message" presets. Both work the same way under the hood
//   (a sound command broadcast to every active license), just shown in
//   separate sections so operators don't confuse them; each can use a
//   beep tone, a Windows system sound, or a custom uploaded audio file.
//   Licenses and presets are stored server-side (server/data/store.json),
//   NOT in the operator's browser.
// - OPERATOR (public/index.html, password-protected with a SEPARATE,
//   lower-stakes password): just sees the alert buttons and message
//   presets and can click them. Clicking asks the SERVER to relay the
//   command to every active license's connected agent - the operator's
//   browser never talks to an agent directly and never handles any
//   license key or raw audio data.
//
// The agent (agent/agent.js) connects here and "registers" itself with a
// fixed license key (see DEFAULT_LICENSES below) - no expiring pairing
// code and no separate deviceId/secret pair. Whoever installs the agent on
// a PC just types in one of the license keys an admin gave them, and it
// connects immediately and keeps reconnecting with that same key forever.
// An admin can deactivate/reactivate or delete a license key at any time
// from /admin.html, without needing to touch anything on the PC itself.
//
// Custom audio: to keep every trigger fast, a command never inlines the
// actual audio bytes - it only carries a content hash. The agent caches
// audio locally by hash and only asks the server for the real bytes
// (via "agent:fetchSound") the first time it sees a new hash.

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
const MAX_BUTTONS = 10; // shared cap across both "alert" and "message" categories
const MAX_CUSTOM_AUDIO_BYTES = 3 * 1024 * 1024; // 3MB raw (before base64)

app.use(express.static(path.join(__dirname, "public")));

// --- Persistent store (licenses + buttons + admin password) --------------
// Written to a local JSON file so an admin's setup survives a simple
// restart. Note: on some free hosting plans local disk doesn't survive a
// full redeploy or a long idle spin-down, so added-on-the-fly data (extra
// licenses, buttons, passwords) may need to be re-added. The 10 DEFAULT
// license keys below are hardcoded in the source (not generated at
// runtime), so they always come back exactly the same even if the data
// file is lost - nobody needs to be told a new code after that happens.
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

// Fixed, human-friendly license keys. These never change - handing one out
// to someone is a one-time action; the agent stores it locally and
// reconnects with it forever. Add more any time from the admin page
// ("+ Gerar licença"); those extra ones are persisted in store.json like
// everything else.
const DEFAULT_LICENSES = [
  "CLK-FZSN-3MHP",
  "CLK-P6FJ-MHXF",
  "CLK-Y94F-C8NE",
  "CLK-ZAVV-7JKY",
  "CLK-22FM-59A5",
  "CLK-ZTA5-P3MF",
  "CLK-WVPB-E7H5",
  "CLK-DER7-Y3YE",
  "CLK-QUJ8-Z5UZ",
  "CLK-PBZK-HEK8",
];

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { licenses: [], buttons: [], adminPassword: null, operatorPassword: null };
  }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

const store = loadStore();
if (!Array.isArray(store.licenses)) store.licenses = [];
if (!Array.isArray(store.buttons)) store.buttons = [];

// Make sure all 10 default licenses always exist, without touching any
// extra ones an admin added manually (or re-adding one an admin deleted on
// purpose would be surprising - so this only adds keys that are entirely
// missing AND have never been explicitly removed before).
if (!Array.isArray(store.removedDefaultLicenses)) store.removedDefaultLicenses = [];
let seededDefaults = false;
for (const key of DEFAULT_LICENSES) {
  const alreadyRemoved = store.removedDefaultLicenses.includes(key);
  const alreadyPresent = store.licenses.some((l) => l.key === key);
  if (!alreadyPresent && !alreadyRemoved) {
    store.licenses.push({ key, label: null, active: true });
    seededDefaults = true;
  }
}
if (seededDefaults) saveStore();

// Resolve the admin password: an explicit ADMIN_PASSWORD env var always
// wins (for deliberate control); otherwise reuse a previously generated one
// so it stays stable across restarts; otherwise generate a fresh one and
// persist + print it.
let adminPassword = process.env.ADMIN_PASSWORD || store.adminPassword;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(6).toString("hex");
  store.adminPassword = adminPassword;
  saveStore();
}

// Same idea for the operator password - a separate, lower-stakes password
// that just gates "can see and click the alert buttons", independent of the
// admin password.
let operatorPassword = process.env.OPERATOR_PASSWORD || store.operatorPassword;
if (!operatorPassword) {
  operatorPassword = crypto.randomBytes(6).toString("hex");
  store.operatorPassword = operatorPassword;
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
if (!process.env.OPERATOR_PASSWORD) {
  console.log(" Senha de operador (gerada automaticamente): " + operatorPassword);
  console.log(" Dica: defina a variável de ambiente OPERATOR_PASSWORD para escolher a sua própria.");
} else {
  console.log(" Senha de operador: definida via variável de ambiente OPERATOR_PASSWORD");
}
console.log("==============================================");

// license key -> { socketId, hostname } - tracks agents currently connected
// with a valid, active license key.
const agents = new Map();

// token -> true, issued on successful login, cleared on restart.
const adminTokens = new Set();
const operatorTokens = new Set();

// cmdId -> { resolve } - commands the server itself is waiting on an agent
// to finish, triggered on behalf of an operator click.
const pendingCommands = new Map();

function publicState() {
  return {
    licenses: store.licenses.map((l) => {
      const agent = agents.get(l.key);
      const active = l.active !== false;
      return {
        key: l.key,
        label: l.label || null,
        active,
        online: active && !!agent,
        hostname: (agent && agent.hostname) || null,
      };
    }),
    buttons: store.buttons.map((b) => ({
      id: b.id,
      label: b.label,
      category: b.category === "message" ? "message" : "alert",
      systemSound: b.systemSound || null,
      hasCustomAudio: !!b.customAudio,
    })),
  };
}

// Only push state updates to sockets that have actually logged in (as
// operator or admin) - an unauthenticated connection shouldn't be able to
// learn the button labels or device nicknames just by connecting.
function broadcastState() {
  const state = publicState();
  for (const s of io.sockets.sockets.values()) {
    if (s.data.operatorAuthed || s.data.adminAuthed) {
      s.emit("state:update", state);
    }
  }
}

function requireAdmin(socket, token, ack) {
  if (!token || !adminTokens.has(token)) {
    ack && ack({ ok: false, error: "Sessão de admin inválida ou expirada. Faça login novamente." });
    return false;
  }
  socket.data.adminAuthed = true;
  return true;
}

function requireOperator(socket, token, ack) {
  if (!token || !(operatorTokens.has(token) || adminTokens.has(token))) {
    ack && ack({ ok: false, error: "Sessão inválida ou expirada. Faça login novamente." });
    return false;
  }
  socket.data.operatorAuthed = true;
  return true;
}

// Generates a fresh, unique license key in the same human-friendly format
// as the 10 built-in ones (CLK-XXXX-XXXX, avoiding ambiguous characters
// like 0/O/1/I).
const LICENSE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateLicenseKey() {
  let key;
  do {
    let s = "";
    for (let i = 0; i < 8; i++) s += LICENSE_ALPHABET[crypto.randomInt(0, LICENSE_ALPHABET.length)];
    key = `CLK-${s.slice(0, 4)}-${s.slice(4)}`;
  } while (store.licenses.some((l) => l.key === key));
  return key;
}

// Builds the lightweight command payload for a button/message. Custom audio
// is NEVER inlined here - only its hash/extension are sent, so a trigger
// stays small and fast; the agent fetches (and caches) the actual audio
// bytes separately, only the first time it ever sees that hash (see
// "agent:fetchSound" below).
function buildAction(button) {
  if (button.customAudio) {
    return { type: "playAudio", soundId: button.id, hash: button.customAudio.hash, ext: button.customAudio.ext };
  }
  if (button.systemSound) {
    return { type: "sound", systemSound: button.systemSound };
  }
  return { type: "sound", frequency: 880, duration: 400 };
}

// Sends the sound command to one license's connected agent and resolves
// with its result, or resolves with an offline/timeout error if it never
// responds (so one unreachable PC doesn't hang the whole trigger forever).
function sendToLicense(license, action) {
  return new Promise((resolve) => {
    const label = license.label || license.key;
    const agent = agents.get(license.key);
    if (!agent) {
      return resolve({ nickname: label, ok: false, error: "PC offline" });
    }

    const cmdId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingCommands.delete(cmdId);
      resolve({ nickname: label, ok: false, error: "Tempo esgotado" });
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(cmdId, {
      resolve: (payload) => {
        clearTimeout(timeout);
        resolve({
          nickname: label,
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
  // The agent connects with a fixed license key (no expiring code, no
  // separate deviceId/secret) - as long as the key exists and is active,
  // it's accepted immediately and reconnects the same way forever.
  socket.on("agent:register", ({ license, hostname }, ack) => {
    if (!license) {
      return ack && ack({ ok: false, error: "Licença é obrigatória" });
    }

    const entry = store.licenses.find((l) => l.key === license);
    if (!entry) {
      return ack && ack({ ok: false, error: "Licença inválida. Peça uma licença ao admin." });
    }
    if (entry.active === false) {
      return ack && ack({ ok: false, error: "Licença desativada pelo admin. Peça para reativar, se precisar." });
    }

    agents.set(license, { socketId: socket.id, hostname: hostname || null });
    socket.data.role = "agent";
    socket.data.license = license;

    // Auto-fill a friendly label from the hostname the first time this
    // license connects, so it doesn't just show the raw key in the admin
    // list - the admin can still rename it anytime.
    if (!entry.label && hostname) {
      entry.label = hostname;
      saveStore();
    }

    console.log(`[agent] registrado: ${license} (${hostname || "?"})`);
    broadcastState();
    ack && ack({ ok: true, label: entry.label || hostname || license });
  });

  socket.on("agent:result", (payload) => {
    const pending = payload && payload.cmdId && pendingCommands.get(payload.cmdId);
    if (pending) {
      pendingCommands.delete(payload.cmdId);
      pending.resolve(payload);
    }
  });

  // --- Operator side (password-protected, separate from admin) ----------
  socket.on("operator:login", ({ password }, ack) => {
    if (password !== operatorPassword) {
      return ack && ack({ ok: false, error: "Senha incorreta" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    operatorTokens.add(token);
    socket.data.operatorAuthed = true;
    ack && ack({ ok: true, token });
  });

  // Lets a returning client (one that already stored a token locally) skip
  // the password prompt, as long as the server hasn't restarted since.
  socket.on("operator:verifyToken", ({ token }, ack) => {
    if (!token || !operatorTokens.has(token)) return ack && ack({ ok: false });
    socket.data.operatorAuthed = true;
    ack && ack({ ok: true });
  });

  socket.on("operator:getState", ({ token }, ack) => {
    if (!requireOperator(socket, token, ack)) return;
    ack && ack({ ok: true, ...publicState() });
  });

  socket.on("operator:trigger", async ({ token, buttonId }, ack) => {
    if (!requireOperator(socket, token, ack)) return;

    const button = store.buttons.find((b) => b.id === buttonId);
    if (!button) return ack && ack({ ok: false, error: "Botão não encontrado" });

    const activeLicenses = store.licenses.filter((l) => l.active !== false);
    if (activeLicenses.length === 0) return ack && ack({ ok: false, error: "Nenhum PC disponível" });

    const action = buildAction(button);

    const results = await Promise.all(activeLicenses.map((l) => sendToLicense(l, action)));
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
    socket.data.adminAuthed = true;
    ack && ack({ ok: true, token });
  });

  socket.on("admin:getState", ({ token }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    ack && ack({ ok: true, ...publicState() });
  });

  // Creates a brand new license key (beyond the 10 built-in ones) that can
  // be handed out to install the agent on another PC.
  socket.on("admin:addLicense", ({ token, label }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    const key = generateLicenseKey();
    store.licenses.push({ key, label: (label || "").trim() || null, active: true });
    saveStore();
    broadcastState();
    ack && ack({ ok: true, key });
  });

  // Permanently deletes a license key. If it's one of the 10 built-in
  // ones, remember that so it doesn't silently come back on next restart.
  socket.on("admin:removeLicense", ({ token, key }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    store.licenses = store.licenses.filter((l) => l.key !== key);
    agents.delete(key);
    if (DEFAULT_LICENSES.includes(key) && !store.removedDefaultLicenses.includes(key)) {
      store.removedDefaultLicenses.push(key);
    }
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  // Turns a license on/off without deleting it. Deactivating immediately
  // stops it from receiving alerts; reactivating brings it back online
  // right away if the agent is still connected with that key, with
  // nothing to redo on the PC itself.
  socket.on("admin:setLicenseActive", ({ token, key, active }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    const entry = store.licenses.find((l) => l.key === key);
    if (!entry) return ack && ack({ ok: false, error: "Licença não encontrada" });
    entry.active = !!active;
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:renameLicense", ({ token, key, label }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    const entry = store.licenses.find((l) => l.key === key);
    if (!entry) return ack && ack({ ok: false, error: "Licença não encontrada" });
    entry.label = (label || "").trim() || null;
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:addButton", ({ token, label, category, systemSound, customAudio }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    if (!label || !label.trim()) return ack && ack({ ok: false, error: "Informe um nome" });
    if (store.buttons.length >= MAX_BUTTONS) {
      return ack && ack({ ok: false, error: `Máximo de ${MAX_BUTTONS} botões/mensagens no total` });
    }

    let customAudioEntry = null;
    if (customAudio && customAudio.audioBase64) {
      let raw;
      try {
        raw = Buffer.from(customAudio.audioBase64, "base64");
      } catch {
        return ack && ack({ ok: false, error: "Áudio inválido" });
      }
      if (raw.length === 0) return ack && ack({ ok: false, error: "Áudio inválido" });
      if (raw.length > MAX_CUSTOM_AUDIO_BYTES) {
        return ack && ack({ ok: false, error: `Áudio muito grande (máx. ${MAX_CUSTOM_AUDIO_BYTES / 1024 / 1024}MB)` });
      }
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const ext = (customAudio.ext || ".wav").toLowerCase().replace(/[^a-z0-9.]/g, "") || ".wav";
      customAudioEntry = {
        audioBase64: customAudio.audioBase64,
        mimeType: customAudio.mimeType || "audio/wav",
        hash,
        ext: ext.startsWith(".") ? ext : "." + ext,
      };
    }

    store.buttons.push({
      id: crypto.randomUUID(),
      label: label.trim(),
      category: category === "message" ? "message" : "alert",
      systemSound: customAudioEntry ? null : systemSound || null,
      customAudio: customAudioEntry,
    });
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  socket.on("admin:removeButton", ({ token, id }, ack) => {
    if (!requireAdmin(socket, token, ack)) return;
    store.buttons = store.buttons.filter((b) => b.id !== id);
    saveStore();
    broadcastState();
    ack && ack({ ok: true });
  });

  // The agent calls this when it needs to play a custom-audio command but
  // doesn't have that exact audio cached locally yet (first time ever, or
  // the admin replaced the file) - see agent.js's ensureSoundCached(). Kept
  // as a separate on-demand fetch (instead of always inlining audio in
  // every "command") so routine triggers stay small and fast.
  socket.on("agent:fetchSound", ({ soundId }, ack) => {
    if (socket.data.role !== "agent") return ack && ack({ ok: false, error: "Não autorizado" });
    const button = store.buttons.find((b) => b.id === soundId && b.customAudio);
    if (!button) return ack && ack({ ok: false, error: "Áudio não encontrado" });
    ack &&
      ack({
        ok: true,
        audioBase64: button.customAudio.audioBase64,
        mimeType: button.customAudio.mimeType,
        hash: button.customAudio.hash,
        ext: button.customAudio.ext,
      });
  });

  socket.on("disconnect", () => {
    if (socket.data.role === "agent" && socket.data.license) {
      const license = socket.data.license;
      const agent = agents.get(license);
      if (agent && agent.socketId === socket.id) {
        agents.delete(license);
        console.log(`[agent] desconectado: ${license}`);
        broadcastState();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
