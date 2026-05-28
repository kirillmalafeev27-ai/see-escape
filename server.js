import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Gzip responses (helps with the larger Three.js payloads).
app.use(compression());

// Lightweight request logging.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Health check endpoint for Render.
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// Serve the static sandbox from /public.
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      // The HTML entry points should always revalidate so deploys are picked up.
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

// Fallback: send the landing page for unknown routes.
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Ocean Sandbox listening on http://${HOST}:${PORT}`);
});
