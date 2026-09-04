import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { installQuizRoutes } = require("./quiz-generation.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
// Container hosts disagree about which port they route to, and some (Northflank
// among them) do not inject $PORT at all. Accept a comma-separated list, and
// with nothing configured serve both common defaults so the platform's port
// entry matches whatever it was set to.
const DEFAULT_PORTS = [8080, 3000];
const PORTS = resolvePorts();

function resolvePorts() {
  const raw = process.env.PORTS || process.env.PORT || "";
  const ports = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
  return ports.length ? [...new Set(ports)] : [...DEFAULT_PORTS];
}
const HOST = process.env.HOST || "0.0.0.0";
const JSON_LIMIT = 1024 * 1024;
const ACTIVE_PLAYER_TTL = 15000;
const STALE_PLAYER_TTL = 30000;
const coopRooms = new Map();

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".bin", "application/octet-stream"],
]);
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);
const LARGE_ASSET = new Set([".glb", ".gltf", ".bin", ".jpg", ".jpeg", ".png", ".webp"]);

function roomCode() {
  let id = "";
  do {
    id = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (coopRooms.has(id));
  return id;
}

function normalizeRoomId(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function getCoopRoom(code, options = {}) {
  const create = options.create !== false;
  const id = normalizeRoomId(code) || (create ? roomCode() : "");
  if (!id) return null;
  if (!coopRooms.has(id)) {
    if (!create) return null;
    coopRooms.set(id, {
      id,
      players: new Map(),
      spectators: new Map(),
      configs: new Map(),
      clients: new Set(),
      wsClients: new Set(),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
  }
  return coopRooms.get(id);
}

function pruneStalePlayers(room, ttl = STALE_PLAYER_TTL) {
  const now = Date.now();
  for (const [playerId, player] of room.players) {
    if (now - player.lastSeen > ttl) room.players.delete(playerId);
  }
  for (const [spectatorId, spectator] of room.spectators || []) {
    if (now - spectator.lastSeen > ttl) room.spectators.delete(spectatorId);
  }
}

function activePlayers(room) {
  const now = Date.now();
  return [...room.players.values()].filter((player) => now - player.lastSeen < ACTIVE_PLAYER_TTL);
}

function publicCoopRoomState(room) {
  return {
    room: room.id,
    players: activePlayers(room),
    spectators: [...(room.spectators || new Map()).values()].filter((spectator) => Date.now() - spectator.lastSeen < ACTIVE_PLAYER_TTL),
    configs: Object.fromEntries(room.configs.entries()),
  };
}

function getRoomMember(room, id) {
  if (!room || !id) return null;
  return room.players.get(id) || room.spectators?.get(id) || null;
}

function broadcastCoop(room, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...room.clients]) {
    try {
      client.write(payload);
    } catch (_) {
      room.clients.delete(client);
    }
  }
  broadcastCoopWs(room, coopWsPayload(event, data));
}

function coopWsPayload(event, data) {
  if (event === "config") return { type: "config", ...data, serverTime: Date.now() };
  if (event === "event") return { type: "event", ...data, serverTime: Date.now() };
  return { type: event, state: data, data, serverTime: Date.now() };
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendCoopWs(socket, message) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(encodeWsFrame(JSON.stringify(message)));
  } catch (_) {
    socket.destroy();
  }
}

function broadcastCoopWs(room, message, except = null) {
  for (const socket of [...room.wsClients]) {
    if (socket === except) continue;
    if (socket.destroyed) {
      room.wsClients.delete(socket);
      continue;
    }
    sendCoopWs(socket, message);
  }
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const bigLength = buffer.readBigUInt64BE(cursor);
      if (bigLength > BigInt(1024 * 1024)) throw new Error("websocket payload too large");
      length = Number(bigLength);
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: payload.toString("utf8") });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function handleCoopWsMessage(room, player, socket, raw) {
  let message;
  try {
    message = JSON.parse(raw || "{}");
  } catch (_) {
    return;
  }
  player.lastSeen = Date.now();
  room.lastSeen = player.lastSeen;
  if (message.type === "ping") {
    sendCoopWs(socket, { type: "pong", serverTime: Date.now() });
    return;
  }
  if (player.role === "spectator") return;
  if (message.type === "state") {
    player.state = message.state || null;
    broadcastCoop(room, "state", publicCoopRoomState(room));
    return;
  }
  if (message.type === "config") {
    const key = String(message.key || message.floor || "").trim();
    if (!key) return;
    if (message.replace || !room.configs.has(key)) {
      room.configs.set(key, message.config || {});
      broadcastCoop(room, "config", { room: room.id, key, floor: key, config: room.configs.get(key) });
      broadcastCoop(room, "room", publicCoopRoomState(room));
    }
    return;
  }
  if (message.type === "event" && message.name) {
    broadcastCoop(room, "event", {
      id: String(message.id || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
      name: String(message.name),
      payload: message.payload || {},
      source: player.id,
      serverTime: Date.now(),
    });
    return;
  }
}

function handleCoopWebSocketUpgrade(req, socket) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/coop/ws") return false;
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return true;
  }
  const room = getCoopRoom(url.searchParams.get("room"), { create: false });
  const player = getRoomMember(room, url.searchParams.get("player"));
  if (!player) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return true;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  room.wsClients.add(socket);
  player.lastSeen = Date.now();
  room.lastSeen = player.lastSeen;
  sendCoopWs(socket, coopWsPayload("room", publicCoopRoomState(room)));
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    try {
      const decoded = decodeWsFrames(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (frame.opcode === 0x1) handleCoopWsMessage(room, player, socket, frame.text);
      }
    } catch (_) {
      socket.destroy();
    }
  });
  socket.on("close", () => room.wsClients.delete(socket));
  socket.on("error", () => room.wsClients.delete(socket));
  return true;
}

function cleanupCoopRooms() {
  const now = Date.now();
  for (const [id, room] of coopRooms) {
    pruneStalePlayers(room, STALE_PLAYER_TTL);
    if (!room.players.size && !room.spectators?.size && !room.clients.size && !room.wsClients.size && now - room.lastSeen > 300000) {
      coopRooms.delete(id);
    }
  }
}
setInterval(cleanupCoopRooms, 30000).unref();

function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, headers);
  res.end(body);
}

function decorateResponse(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    const payload = JSON.stringify(body);
    send(res, res.statusCode || 200, payload, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-cache",
    });
  };
  res.send = (body) => {
    if (Buffer.isBuffer(body)) {
      if (!res.getHeader("Content-Length")) res.setHeader("Content-Length", body.length);
      if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/octet-stream");
      send(res, res.statusCode || 200, body, Object.fromEntries(res.getHeaders()));
      return;
    }
    const payload = String(body ?? "");
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(payload));
    send(res, res.statusCode || 200, payload, Object.fromEntries(res.getHeaders()));
  };
}

function createRouteApp() {
  const routes = [];
  return {
    routes,
    get(routePath, handler) {
      routes.push({ method: "GET", routePath, handler });
    },
    post(routePath, handler) {
      routes.push({ method: "POST", routePath, handler });
    },
  };
}

const routeApp = createRouteApp();
installQuizRoutes(routeApp);
installCoopRoutes(routeApp);

function installCoopRoutes(app) {
  app.post("/api/coop/join", (req, res) => {
    const requestedRoom = normalizeRoomId(req.body?.room);
    const create = Boolean(req.body?.create) || !requestedRoom;
    const room = getCoopRoom(requestedRoom, { create });
    if (!room) return res.status(404).json({ ok: false, error: "Комната не найдена. Проверь код или попроси первого игрока создать комнату заново." });
    pruneStalePlayers(room, STALE_PLAYER_TTL);
    if (req.body?.spectator) {
      room.lastSeen = Date.now();
      const spectatorId = Math.random().toString(36).slice(2, 10);
      const spectator = {
        id: spectatorId,
        role: "spectator",
        name: String(req.body?.name || "Spectator").slice(0, 24),
        state: null,
        lastSeen: Date.now(),
      };
      room.spectators.set(spectatorId, spectator);
      broadcastCoop(room, "room", publicCoopRoomState(room));
      return res.json({
        ok: true,
        room: room.id,
        playerId: spectatorId,
        spectatorId,
        role: "spectator",
        spectator: true,
        seat: 0,
        color: "#c9f8ed",
        state: publicCoopRoomState(room),
      });
    }
    /* Room size is intentionally unlimited; legacy full-room response disabled.
      return res.status(409).json({ ok: false, error: "Комната уже заполнена: максимум 2 игрока." });
    */
    room.lastSeen = Date.now();
    const playerId = Math.random().toString(36).slice(2, 10);
    const usedSeats = new Set([...room.players.values()].map((player) => player.seat));
    let seat = 1;
    while (usedSeats.has(seat)) seat++;
    const colors = ["#3aa0ff", "#5ce58a", "#ffe27a", "#ff8fc7"];
    const color = colors[(seat - 1) % colors.length];
    const player = {
      id: playerId,
      seat,
      color,
      name: String(req.body?.name || `Игрок ${seat}`).slice(0, 24),
      state: null,
      lastSeen: Date.now(),
    };
    room.players.set(playerId, player);
    broadcastCoop(room, "room", publicCoopRoomState(room));
    res.json({ ok: true, room: room.id, playerId, seat, color, state: publicCoopRoomState(room) });
  });

  app.get("/api/coop/room", (req, res) => {
    const room = getCoopRoom(req.query.room, { create: false });
    if (!room) return res.status(404).json({ ok: false, error: "room not found" });
    pruneStalePlayers(room, STALE_PLAYER_TTL);
    room.lastSeen = Date.now();
    res.json({ ok: true, state: publicCoopRoomState(room) });
  });

  app.get("/api/coop/events", (req, res) => {
    const room = getCoopRoom(req.query.room, { create: false });
    if (!room) return res.status(404).end("room not found");
    room.lastSeen = Date.now();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: room\ndata: ${JSON.stringify(publicCoopRoomState(room))}\n\n`);
    room.clients.add(res);
    req.on("close", () => {
      room.clients.delete(res);
    });
  });

  app.post("/api/coop/state", (req, res) => {
    const room = getCoopRoom(req.body?.room, { create: false });
    const player = room?.players.get(req.body?.playerId);
    if (!player) return res.status(404).json({ ok: false, error: "player not found" });
    player.state = req.body?.state || null;
    player.lastSeen = Date.now();
    room.lastSeen = player.lastSeen;
    broadcastCoop(room, "state", publicCoopRoomState(room));
    res.json({ ok: true });
  });

  app.post("/api/coop/config", (req, res) => {
    const room = getCoopRoom(req.body?.room, { create: false });
    if (!room) return res.status(404).json({ ok: false, error: "room not found" });
    const key = String(req.body?.key || req.body?.floor || "").trim();
    if (!key) return res.status(400).json({ ok: false, error: "bad config key" });
    if (req.body?.replace || !room.configs.has(key)) {
      room.configs.set(key, req.body?.config || {});
      room.lastSeen = Date.now();
      broadcastCoop(room, "config", { room: room.id, key, floor: key, config: room.configs.get(key) });
      broadcastCoop(room, "room", publicCoopRoomState(room));
    }
    res.json({ ok: true, config: room.configs.get(key) });
  });

  app.post("/api/coop/event", (req, res) => {
    const room = getCoopRoom(req.body?.room, { create: false });
    const player = room?.players.get(req.body?.playerId);
    if (!player) return res.status(404).json({ ok: false, error: "player not found" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "bad event name" });
    player.lastSeen = Date.now();
    room.lastSeen = player.lastSeen;
    const event = {
      id: String(req.body?.id || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
      name,
      payload: req.body?.payload || {},
      source: player.id,
      serverTime: Date.now(),
    };
    broadcastCoop(room, "event", event);
    res.json({ ok: true, event });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(error, { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function dispatchRoute(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const route = routeApp.routes.find((item) => item.method === req.method && item.routePath === url.pathname);
  if (!route) return false;

  decorateResponse(res);
  req.query = Object.fromEntries(url.searchParams.entries());
  req.body = req.method === "POST" ? await readJsonBody(req) : {};

  try {
    await route.handler(req, res);
  } catch (error) {
    console.error("API route failed:", error);
    if (!res.writableEnded) {
      res.status(error.statusCode || 500).json({ error: error.message || "Internal server error" });
    }
  }
  return true;
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.normalize(path.join(publicDir, clean));
  return candidate.startsWith(publicDir) ? candidate : null;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      const fallback = path.join(publicDir, "index.html");
      serveFile(req, res, fallback);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = ext === ".html"
      ? "no-cache"
      : (req.url || "").includes("?v=") || LARGE_ASSET.has(ext)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";
    const headers = {
      "Content-Type": MIME.get(ext) || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
    };

    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startRaw, endRaw] = range.replace("bytes=", "").split("-");
      const start = startRaw === "" ? Math.max(0, stat.size - Number(endRaw || 0)) : Number(startRaw);
      const end = endRaw === "" ? stat.size - 1 : Math.min(stat.size - 1, Number(endRaw));
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
        res.writeHead(206, {
          ...headers,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    if (req.method === "HEAD") {
      send(res, 200, "", headers);
      return;
    }

    const stream = fs.createReadStream(filePath);
    const accepts = String(req.headers["accept-encoding"] || "");
    if (COMPRESSIBLE.has(ext) && /\bbr\b/.test(accepts)) {
      const compressedHeaders = { ...headers, "Content-Encoding": "br", Vary: "Accept-Encoding" };
      delete compressedHeaders["Content-Length"];
      res.writeHead(200, compressedHeaders);
      stream.pipe(zlib.createBrotliCompress()).pipe(res);
    } else if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(accepts)) {
      const compressedHeaders = { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" };
      delete compressedHeaders["Content-Length"];
      res.writeHead(200, compressedHeaders);
      stream.pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, headers);
      stream.pipe(res);
    }
    stream.on("error", () => {
      if (!res.headersSent) send(res, 500, "Internal server error");
      else res.destroy();
    });
  });
}

const requestHandler = async (req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  try {
    if (await dispatchRoute(req, res)) return;
  } catch (error) {
    send(res, error.statusCode || 500, JSON.stringify({ error: error.message || "Bad request" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  const filePath = safePublicPath(req.url || "/");
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  serveFile(req, res, filePath);
};

function handleUpgrade(req, socket) {
  if (handleCoopWebSocketUpgrade(req, socket)) return;
  socket.destroy();
}

console.log(
  `Port config: PORT=${process.env.PORT ?? "(unset)"} PORTS=${process.env.PORTS ?? "(unset)"} -> binding ${PORTS.join(", ")}`
);

PORTS.forEach((port, index) => {
  const server = http.createServer(requestHandler);
  server.on("upgrade", handleUpgrade);
  server.on("error", (error) => {
    const reason = `Failed to bind ${HOST}:${port} — ${error.code || error.message}`;
    // The first port is the contract; the extras are best-effort convenience.
    if (index === 0) {
      console.error(reason);
      process.exit(1);
    }
    console.warn(`${reason} (extra port, ignored)`);
  });
  server.listen(port, HOST, () => {
    console.log(`Ocean Sandbox listening on http://${HOST}:${port}`);
  });
});
