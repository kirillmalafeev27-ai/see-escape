import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "0.0.0.0";

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
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
    const headers = {
      "Content-Type": MIME.get(ext) || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    };

    if (req.method === "HEAD") {
      send(res, 200, "", headers);
      return;
    }

    const stream = fs.createReadStream(filePath);
    res.writeHead(200, headers);
    stream.pipe(res);
    stream.on("error", () => {
      if (!res.headersSent) send(res, 500, "Internal server error");
      else res.destroy();
    });
  });
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  if (req.url === "/healthz") {
    send(res, 200, JSON.stringify({ status: "ok", uptime: process.uptime() }), {
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

server.listen(PORT, HOST, () => {
  console.log(`Ocean Sandbox listening on http://${HOST}:${PORT}`);
});
