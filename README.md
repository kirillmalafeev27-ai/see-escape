# 🌊 Ocean Sandbox

An interactive **3D ocean simulation** that runs in the browser and is packaged
as a **Render web service** (Node + Express). Inspired by
[Seth-arc/3D-Ocean](https://github.com/Seth-arc/3D-Ocean).

Tune waves, sky and the sun in real time, then explore the seascape in
first-person or orbit around it cinematically.

## Features

- **Real 3D waves** — Gerstner-wave vertex displacement on a subdivided mesh,
  so crests physically rise in 3D (not just a normal map). Adjustable height,
  choppiness and swell size.
- **Photorealistic water** — Three.js `Water` with custom reflections/refraction.
- **Procedural sky & sun** — atmospheric scattering (`Sky`) with adjustable
  turbidity, Rayleigh scattering, sun elevation and azimuth.
- **Live sandbox panel** — `lil-gui` controls for wave size/speed, water color,
  sun position and one-click weather presets (Calm dawn, Bright noon, Stormy dusk).
- **Dual cameras** — orbit (cinematic) and first-person (`WASD` + mouse-look),
  toggle with `C`.
- **Adaptive quality** — live FPS monitor scales pixel ratio to keep it smooth.
- **Production server** — Express with gzip compression, request logging and a
  `/healthz` health check endpoint.

## Controls

| Input | Action |
| --- | --- |
| `C` | Toggle orbit / first-person camera |
| `W A S D` / arrows | Move (first-person) |
| `Shift` | Sprint |
| `Space` / `Ctrl` | Move up / down |
| Click canvas | Capture mouse-look (first-person) |

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Set a custom port with `PORT=8080 npm start`.

## Deploy to Render

This repo ships a [`render.yaml`](./render.yaml) Blueprint, so deployment is one click.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In the [Render dashboard](https://dashboard.render.com), choose
   **New → Blueprint** and select the repo.
3. Render reads `render.yaml` and provisions a web service automatically.

### Option B — Manual web service

1. **New → Web Service**, connect the repo.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/healthz`
3. Deploy. Render injects `PORT`; the server binds to `0.0.0.0:$PORT`.

## Project structure

```
.
├── server.js            # Express server: static hosting, gzip, health check
├── render.yaml          # Render Blueprint (web service)
├── package.json
├── public/
│   ├── index.html       # Landing page
│   └── simulation.html  # The 3D ocean sandbox (Three.js)
└── README.md
```

## How it works

Three.js loads as ES modules from a CDN via an import map (no bundler needed).
`server.js` serves the `public/` directory and listens on `process.env.PORT`,
which is exactly what Render's web-service contract expects.

## License

MIT
