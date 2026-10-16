// server.js
// Relay server: connects the web "remote control" page to the agent
// running on the target computer, over the internet, using Socket.IO.
//
// How it works:
// - The agent (agent/agent.js) connects here and "registers" itself
//   under a deviceId + secret (its pairing code).
// - The web page connects here and "joins" a deviceId + secret.
// - When a web client clicks a button, the command is forwarded to the
//   matching agent, which executes the real click or plays a sound.
//
// Nothing is persisted to disk: everything lives in memory while the
// server process is running (fine for a small personal relay).

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// deviceId -> { secret, socketId }
const agents = new Map();

function agentRoom(deviceId) {
  return `device:${deviceId}`;
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
    socket.join(agentRoom(deviceId));

    io.to(agentRoom(deviceId)).emit("device:status", { deviceId, online: true });
    console.log(`[agent] registrado: ${deviceId}`);
    ack && ack({ ok: true });
  });

  // --- Web (browser) side ----------------------------------------------
  socket.on("web:join", ({ deviceId, secret }, ack) => {
    if (!deviceId || !secret) {
      return ack && ack({ ok: false, error: "deviceId e secret são obrigatórios" });
    }

    const agent = agents.get(deviceId);
    // We allow joining even if the agent isn't online yet, but the secret
    // must match once we know it, so random people can't guess their way in
    // after an agent has claimed that deviceId.
    if (agent && agent.secret !== secret) {
      return ack && ack({ ok: false, error: "Código ou chave incorretos" });
    }

    socket.data.role = "web";
    socket.join(agentRoom(deviceId));

    ack && ack({ ok: true, online: !!agent });
  });

  // A web client may control several devices at once (one "web:join" per
  // device, all on the same socket) - this lets it stop listening for a
  // specific device's events (e.g. after the user removes it from "Meus
  // PCs") without disconnecting the whole socket.
  socket.on("web:leave", ({ deviceId }) => {
    if (deviceId) socket.leave(agentRoom(deviceId));
  });

  socket.on("command", ({ deviceId, secret, action, sentAt, cmdId }, ack) => {
    const agent = agents.get(deviceId);
    if (!agent || agent.secret !== secret) {
      return ack && ack({ ok: false, error: "Agente offline ou credenciais inválidas" });
    }

    // sentAt/cmdId are just passed through untouched - they let the browser
    // and the agent measure latency (see README "Medindo a latência").
    io.to(agent.socketId).emit("command", { action, sentAt, cmdId });
    ack && ack({ ok: true });
  });

  socket.on("agent:result", (payload) => {
    const { deviceId } = payload || {};
    // Forward the full payload (deviceId included) so a web client that's
    // controlling several devices at once can tell which device a given
    // result belongs to.
    io.to(agentRoom(deviceId)).emit("command:result", payload);
  });

  socket.on("disconnect", () => {
    if (socket.data.role === "agent" && socket.data.deviceId) {
      const deviceId = socket.data.deviceId;
      const agent = agents.get(deviceId);
      if (agent && agent.socketId === socket.id) {
        agents.delete(deviceId);
        io.to(agentRoom(deviceId)).emit("device:status", { deviceId, online: false });
        console.log(`[agent] desconectado: ${deviceId}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
