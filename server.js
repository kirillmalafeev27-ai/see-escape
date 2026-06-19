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
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "0.0.0.0";
const JSON_LIMIT = 1024 * 1024;
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
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getCoopRoom(code) {
  const id = String(code || "").trim().toUpperCase() || roomCode();
  if (!coopRooms.has(id)) {
    coopRooms.set(id, {
      id,
      players: new Map(),
      configs: new Map(),
      clients: new Set(),
      wsClients: new Set(),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
  }
  return coopRooms.get(id);
}

function publicCoopRoomState(room) {
  const now = Date.now();
  return {
    room: room.id,
    players: [...room.players.values()].filter((player) => now - player.lastSeen < 15000),
    configs: Object.fromEntries(room.configs.entries()),
  };
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
    broadcastCoopWs(room, {
      type: "event",
      name: String(message.name),
      payload: message.payload || {},
      source: player.id,
      serverTime: Date.now(),
    });
    return;
  }
  if (message.type === "ping") {
    sendCoopWs(socket, { type: "pong", serverTime: Date.now() });
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
  const room = getCoopRoom(url.searchParams.get("room"));
  const player = room.players.get(url.searchParams.get("player"));
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
    for (const [playerId, player] of room.players) {
      if (now - player.lastSeen > 30000) room.players.delete(playerId);
    }
    if (!room.players.size && !room.clients.size && !room.wsClients.size && now - room.lastSeen > 300000) {
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
    const room = getCoopRoom(req.body?.room);
    room.lastSeen = Date.now();
    const playerId = Math.random().toString(36).slice(2, 10);
    const seat = room.players.size + 1;
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

  app.get("/api/coop/events", (req, res) => {
    const room = getCoopRoom(req.query.room);
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
    const room = getCoopRoom(req.body?.room);
    const player = room.players.get(req.body?.playerId);
    if (!player) return res.status(404).json({ ok: false, error: "player not found" });
    player.state = req.body?.state || null;
    player.lastSeen = Date.now();
    room.lastSeen = player.lastSeen;
    broadcastCoop(room, "state", publicCoopRoomState(room));
    res.json({ ok: true });
  });

  app.post("/api/coop/config", (req, res) => {
    const room = getCoopRoom(req.body?.room);
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

const server = http.createServer(async (req, res) => {
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
});

server.on("upgrade", (req, socket) => {
  if (handleCoopWebSocketUpgrade(req, socket)) return;
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`Ocean Sandbox listening on http://${HOST}:${PORT}`);
});
