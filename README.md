# 🌊 Ocean Sandbox

An interactive **3D ocean simulation** that runs in the browser and is packaged
as a **Render web service** (Node + Express). Inspired by
[Seth-arc/3D-Ocean](https://github.com/Seth-arc/3D-Ocean).

Tune waves, sky and the sun in real time, then explore the seascape in
first-person or orbit around it cinematically.

## Naval battle (combat core)

`/simulation.html` is now a first-person naval battle prototype built on the
ocean. You stand on a ship that bobs on the Gerstner waves, walk the deck
(`WASD` + mouse), man cannons (`E`) and trade fire with an AI enemy fleet.

- **Realistic ballistics** — cannonballs fly on real parabolas under gravity,
  drifting wind and air drag (`js/ballistics.js`). A live yellow trajectory arc
  shows exactly where your shot lands so you can lead targets and compensate for
  wind before firing.
- **AI enemy fleet** — ships spawn around you, bob on the swell, close to
  range and fire using a ballistic firing solution that leads the target
  (`js/enemy.js`). One solid hit and an enemy lists and sinks to the seabed.
- **Wood debris** — cannonball hits burst into flying splinters, dust and
  plank chunks that settle on the water, following the wood-debris-explosion
  skill's particle + lightweight-debris approach (`js/effects.js`).
- **Buoyant ship** — heave/pitch/roll solved from four wave samples
  (`js/ship.js`); the player rig is parented to the deck so it rides the motion.

Coming next: hull breaches with a rising-water gauge and patching, and the
teleport down into the hold interior.

### Module map

```
js/ocean.js       scene, sky/sun, Gerstner water, sampleWaveHeight
js/effects.js     particle bursts + wood debris chunks
js/ballistics.js  projectiles, firing-solution solver, trajectory predictor
js/ship.js        player ship, cannons, hatch, buoyancy, hull hit-test
js/enemy.js       enemy fleet spawn / AI fire / sinking
js/player.js      first-person deck controller, cannon aiming
js/game.js        orchestration, collisions, wind, HUD, main loop
```

## Sandbox features (waves)

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
- **Wave-riding camera** — in first-person the camera floats and bobs on the
  water surface (the Gerstner sum is mirrored on the CPU to sample surface
  height) instead of clipping through the swells. `Space`/`Ctrl` rise above or
  skim the crests; toggle with **Float on waves**.
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
