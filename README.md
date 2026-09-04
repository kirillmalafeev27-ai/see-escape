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

On phones and tablets the same actions run off the on-screen controls: the left
joystick walks the deck, the right half of the screen looks around, and the
buttons on the right edge cover the keyboard actions. Standing at the wheel
brings up **Встать к штурвалу**; tapping it hands you the helm, after which the
same joystick trims the sails (up/down) and steers the course (left/right) —
exactly what `W/S` and `A/D` do on a keyboard.

## Run locally

```bash
npm install
npm start
# open http://localhost:8080
```

Set a custom port with `PORT=3000 npm start`.

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

## Deploy to Northflank

The repo ships a [`Dockerfile`](./Dockerfile), so Northflank can build and run
the service without any buildpack guesswork.

1. **Create new → Service → Combined service**, connect this repo and branch.
2. **Build:** Dockerfile, build context `/`, Dockerfile path `/Dockerfile`.
3. **Run command:** leave it empty (the Dockerfile already runs `node server.js`),
   or set `npm start`. If the service overrides it with `npm run start:northflank`,
   that script exists too — every one of these runs the same `node server.js`.
4. **Ports:** one port, protocol **HTTP**, publicly exposed. Northflank does not
   inject `$PORT`, so with nothing set the server binds **both 8080 and 3000** —
   either number in the port entry reaches the app. For any other number, set
   `PORT` (or `PORTS`, comma-separated) in the service environment to match.
5. **Health checks (optional but recommended):** HTTP, path `/healthz`, on the
   same port, initial delay ~10s.
6. **Environment variables:** add the AI/voice keys below as secrets. None of
   them are required for the service to boot.

### Troubleshooting ingress errors

Both `no healthy upstream` and `upstream connect error ... Connection refused`
come from Northflank's ingress proxy, not from this app. The first means no
container was healthy at all; the second means the container is up but nothing
answered on the port the proxy dialled. Check, in order:

1. **Is a container actually running?** Service → *Observability / Logs*. A
   successful boot prints `Ocean Sandbox listening on http://0.0.0.0:<port>`.
   If the log ends on a stack trace or an `npm` error, the build or start
   command failed and there is nothing to route to.
2. **`npm error Missing script: "..."`** — the run command configured on the
   service names a script this repo does not have. That is a crash loop: the
   container restarts every few minutes and never serves a request. Point the
   run command at `npm start`, or leave it empty to use the Dockerfile's
   `node server.js`. (`start:northflank` is kept as an alias for services that
   were configured with it.)
3. **Does the port match?** The boot log prints its port config first, e.g.
   `Port config: PORT=(unset) PORTS=(unset) -> binding 8080, 3000`. Every number
   in Service → *Ports* must appear in that list. A mismatch is what produces
   `upstream connect error ... Connection refused`: the container is up, but
   nothing is listening on the port the proxy dials. Fix it by matching the port
   entry to a bound port, or by setting `PORT`/`PORTS` to the number you want.
4. **Is the health check pointing somewhere real?** Use `/healthz` (returns
   `{"ok":true}`) or `/`. A health check on a path that 404s marks every
   container unhealthy and removes it from the load balancer.
5. **Are there 0 replicas?** A scaled-to-zero or still-deploying service has no
   upstream yet; wait for the deployment to go green, or scale to at least 1.

## AI and voice env vars

For generated German grammar tasks set one AI key:

- `AITUNNEL_API_KEY` or `AI_TUNNEL_API_KEY` for AI Tunnel
- `OPENAI_API_KEY` for an OpenAI-compatible `/chat/completions` endpoint
- optional `AI_MODELS`, for example `gpt-5.4`
- optional `OPENAI_BASE_URL` or `AI_BASE_URL` for custom gateways

For ElevenLabs speech set:

- `ELEVENLABS_API_KEY`
- optional `ELEVENLABS_VOICE_ID`
- optional `ELEVENLABS_MODEL_ID` (default: `eleven_multilingual_v2`)

Check production config at `/api/quiz/status`. It reports whether generation and
TTS are configured without exposing secrets.

## Project structure

```
.
├── server.js            # HTTP server: static hosting, gzip, health check
├── Dockerfile           # Container build (Northflank / any container host)
├── render.yaml          # Render Blueprint (web service)
├── package.json
├── public/
│   ├── index.html       # Landing page
│   └── simulation.html  # The 3D ocean sandbox (Three.js)
└── README.md
```

## How it works

Three.js loads as ES modules from a CDN via an import map (no bundler needed).
`server.js` serves the `public/` directory and listens on `process.env.PORT`
(falling back to `8080`), which is what Render's web-service contract expects
and what Northflank injects for the service's first port.

## License

MIT
