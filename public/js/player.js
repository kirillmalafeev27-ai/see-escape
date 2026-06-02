// player.js — first-person deck controller built on an ANALYTIC navigation
// model (no per-frame raycasting). The ship exports a list of walkable
// surfaces — flat deck rectangles and sloped stair ramps — plus a small set of
// circular blockers for the mast trunks, all in ship-local space. The player
// rig is parented to the ship so it heaves/rolls with it, and every frame we
// just sample the surface height under the feet from plain math. This makes the
// movement predictable: only the masts block you, small decorative meshes never
// do, and steps/ramps are handled by simple height thresholds.
import * as THREE from "three";
import { predictTrajectory } from "./ballistics.js";

const PLAYER_MUZZLE_SPEED = 220;
const WALK_SPEED = 14;
const LOOK_SENS = 0.0022;
const RELOAD = 1.8;
const EYE_HEIGHT = 4.2;
const PLAYER_RADIUS = 0.85;
// Auto-step thresholds. Generous so small ledges, sills and crate-height meshes
// never stop you; ramps carry you the rest of the way.
const MAX_STEP_UP = 2.4;
const MAX_STEP_DOWN = 3.8;
const GROUND_RESPONSE = 18;
const STAIR_GROUND_RESPONSE = 26;
const JUMP_SPEED = 16;
const JUMP_GRAVITY = 32;
const FELL_OFF_DEPTH = 24;
const MIN_CANNON_PITCH = THREE.MathUtils.degToRad(-8);
const MAX_CANNON_PITCH = THREE.MathUtils.degToRad(38);
const CANNON_INTERACTION_RANGE = 7.5;

function angleDelta(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

export class PlayerController {
  constructor({ scene, camera, ship, domElement, projectiles, effects, getEnv, fireButton, jumpButton, damageControl, onMessage }) {
    this.camera = camera;
    this.ship = ship;
    this.dom = domElement;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getEnv = getEnv;
    this.fireButton = fireButton;
    this.jumpButton = jumpButton;
    this.damageControl = damageControl || null;
    this.onMessage = onMessage || (() => {});
    this.dims = ship.dims;
    // Live references — damage-control may push hold surfaces into these arrays
    // after the model is analyzed; we read them by reference each frame.
    this.surfaces = ship.navigationSurfaces || [];
    this.blockers = ship.navigationBlockers || [];
    this.cannons = ship.cannons || [];

    this.rig = new THREE.Object3D();
    this.rig.position.set(0, this.dims.deckY, this.dims.length * 0.12);
    ship.group.add(this.rig);
    this.rig.add(camera);
    camera.position.set(0, EYE_HEIGHT, 0);
    camera.rotation.set(0, 0, 0);

    this.yaw = Math.PI;
    this.pitch = -0.05;
    this.keys = {};
    this.locked = false;
    this.prompt = "";

    this._viewDirection = new THREE.Vector3();
    this._inverseShip = new THREE.Matrix4();
    this._lastSafePosition = this.rig.position.clone();
    this.activeCannon = null;
    this.aimInTraverse = false;
    this.airborne = false;
    this.verticalVelocity = 0;

    // Aim preview line + landing marker (world space).
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.85 })
    );
    this.aimLine.frustumCulled = false;
    scene.add(this.aimLine);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(3, 4.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    this.marker.rotation.x = -Math.PI / 2;
    scene.add(this.marker);

    this._bindInput();
    this._placeOnDeck();
    this._rememberSafe();
  }

  _bindInput() {
    addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "KeyE" && !e.repeat) {
        this._interactOrFire();
        e.preventDefault();
      }
      if (e.code === "Space" && !e.repeat) {
        this._jump();
        e.preventDefault();
      }
    });
    addEventListener("keyup", (e) => (this.keys[e.code] = false));

    this.dom.addEventListener("mousedown", () => {
      if (document.pointerLockElement !== this.dom) {
        this.dom.requestPointerLock();
      }
    });
    this.fireButton?.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.fireButton?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._fire();
    });
    this.jumpButton?.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.jumpButton?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._jump();
    });
    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
    });
    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch -= e.movementY * LOOK_SENS;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.3, 1.3);
    });
  }

  // ---- analytic navigation -------------------------------------------------

  _surfaceY(surface, x, z) {
    if (surface.kind === "ramp") {
      const span = surface.endZ - surface.startZ;
      const t = Math.abs(span) < 1e-5 ? 0 : THREE.MathUtils.clamp((z - surface.startZ) / span, 0, 1);
      return THREE.MathUtils.lerp(surface.startY, surface.endY, t);
    }
    return surface.y;
  }

  // Highest walkable surface at (x,z) whose top is at or below `ceilingY`.
  // Returns { y, onStairs } or null. This is the whole ground model: standing,
  // stepping up/down, ramps and stacked decks all fall out of "pick the highest
  // surface I can reach from here".
  _supportBelow(x, z, ceilingY) {
    let best = null;
    for (const surface of this.surfaces) {
      if (x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) continue;
      const y = this._surfaceY(surface, x, z);
      if (y > ceilingY) continue;
      if (!best || y > best.y) best = { y, onStairs: !!surface.onStairs };
    }
    return best;
  }

  // Mast trunks are the only movement blockers. Everything else is decoration.
  _blocked(x, z, footY) {
    for (const blocker of this.blockers) {
      if (blocker.active === false) continue;
      if (footY < blocker.minY - 1 || footY > blocker.maxY) continue;
      const dx = x - blocker.x;
      const dz = z - blocker.z;
      const reach = blocker.radius + PLAYER_RADIUS;
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    return false;
  }

  _rememberSafe() {
    if (this.airborne) return;
    this._lastSafePosition.copy(this.rig.position);
  }

  _recoverSafe() {
    this.verticalVelocity = 0;
    this.airborne = false;
    this.rig.position.copy(this._lastSafePosition);
  }

  _tryMove(dx, dz) {
    if (!dx && !dz) return false;
    const footY = this.rig.position.y;
    const nx = this.rig.position.x + dx;
    const nz = this.rig.position.z + dz;
    if (this._blocked(nx, nz, footY)) return false;

    if (this.airborne) {
      this.rig.position.x = nx;
      this.rig.position.z = nz;
      return true;
    }

    if (this.surfaces.length) {
      const ground = this._supportBelow(nx, nz, footY + MAX_STEP_UP);
      // No surface, or a drop bigger than a step (deck edge / open hatch) — stay
      // put so the player can't walk off into the sea or fall through openings.
      if (!ground || footY - ground.y > MAX_STEP_DOWN) return false;
    }
    this.rig.position.x = nx;
    this.rig.position.z = nz;
    return true;
  }

  _jump() {
    if (this.airborne) return;
    this.airborne = true;
    this.verticalVelocity = JUMP_SPEED;
  }

  _placeOnDeck() {
    if (!this.surfaces.length) return;
    const candidates = [];
    for (const z of [this.dims.length * 0.12, 0, -this.dims.length * 0.12, this.dims.length * 0.24]) {
      for (const x of [0, -this.dims.beam * 0.14, this.dims.beam * 0.14]) {
        candidates.push([x, z]);
      }
    }
    for (const [x, z] of candidates) {
      if (this._blocked(x, z, Infinity)) continue;
      const ground = this._supportBelow(x, z, Infinity);
      if (ground) {
        this.rig.position.set(x, ground.y, z);
        return;
      }
    }
  }

  // Keep the rig glued to the deck in ship-local space. Because the rig is a
  // child of the ship, roll/pitch never turn this into a sideways slide.
  _groundFollow(dt) {
    this.rig.rotation.set(0, this.yaw, 0);

    if (this.airborne) {
      const previousY = this.rig.position.y;
      this.verticalVelocity -= JUMP_GRAVITY * dt;
      this.rig.position.y += this.verticalVelocity * dt;
      if (this.verticalVelocity <= 0) {
        const ground = this.surfaces.length
          ? this._supportBelow(this.rig.position.x, this.rig.position.z, previousY + 0.1)
          : { y: this.dims.deckY, onStairs: false };
        if (ground && this.rig.position.y <= ground.y) {
          this.rig.position.y = ground.y;
          this.verticalVelocity = 0;
          this.airborne = false;
          this._rememberSafe();
        }
      }
      if (this.rig.position.y < this.dims.keelY - FELL_OFF_DEPTH) this._recoverSafe();
      return;
    }

    if (!this.surfaces.length) {
      this.rig.position.y = this.dims.deckY;
      return;
    }
    const ground = this._supportBelow(this.rig.position.x, this.rig.position.z, this.rig.position.y + MAX_STEP_UP);
    if (ground) {
      const response = ground.onStairs ? STAIR_GROUND_RESPONSE : GROUND_RESPONSE;
      const alpha = 1 - Math.exp(-response * Math.max(0, dt));
      this.rig.position.y = THREE.MathUtils.lerp(this.rig.position.y, ground.y, alpha);
      this._rememberSafe();
    }
  }

  // ---- cannons -------------------------------------------------------------

  _findNearbyCannon() {
    let best = null;
    let bestDistance = CANNON_INTERACTION_RANGE;
    for (const cannon of this.cannons) {
      if (cannon.disabled) continue;
      const dx = cannon.mount.position.x - this.rig.position.x;
      const dy = (cannon.mount.position.y - this.rig.position.y) * 1.5;
      const dz = cannon.mount.position.z - this.rig.position.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < bestDistance) {
        best = cannon;
        bestDistance = distance;
      }
    }
    return best;
  }

  _cannonAim(cannon) {
    if (!cannon) return null;
    this.camera.updateWorldMatrix(true, false);
    this.ship.group.updateWorldMatrix(true, false);
    this.camera.getWorldDirection(this._viewDirection);
    this._inverseShip.copy(this.ship.group.matrixWorld).invert();
    this._viewDirection.transformDirection(this._inverseShip);

    const desiredYaw = Math.atan2(this._viewDirection.x, this._viewDirection.z);
    const desiredPitch = Math.asin(THREE.MathUtils.clamp(this._viewDirection.y, -1, 1));
    const delta = angleDelta(desiredYaw, cannon.baseYaw);
    const yaw = cannon.baseYaw + THREE.MathUtils.clamp(delta, -cannon.traverse, cannon.traverse);
    const pitch = THREE.MathUtils.clamp(desiredPitch, MIN_CANNON_PITCH, MAX_CANNON_PITCH);
    cannon.yawPivot.rotation.y = angleDelta(yaw, cannon.baseYaw);
    cannon.pitchPivot.rotation.z = pitch;
    this.ship.group.updateMatrixWorld(true);

    const origin = cannon.muzzle.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(1, 0, 0).transformDirection(cannon.pitchPivot.matrixWorld);
    return { cannon, origin, dir, inTraverse: Math.abs(delta) <= cannon.traverse };
  }

  _fire() {
    const cannon = this._findNearbyCannon();
    if (!cannon) {
      this.onMessage("Подойди к пушке, чтобы выстрелить.");
      return;
    }
    const aim = this._cannonAim(cannon);
    if (!aim.inTraverse) {
      this.onMessage("Цель вне сектора наведения этой пушки.");
      return;
    }
    if (cannon.reload > 0) {
      this.onMessage("Пушка перезаряжается.");
      return;
    }
    const { origin, dir } = aim;
    cannon.reload = RELOAD;
    const vel = dir.clone().multiplyScalar(PLAYER_MUZZLE_SPEED);
    this.projectiles.spawn(origin, vel, { team: "player" });
    this.effects.muzzleFlash(origin, vel);
  }

  _interactOrFire() {
    if (this.damageControl?.interact(this.rig, this.camera)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafe();
      return;
    }
    this._fire();
  }

  _updateAimPreview() {
    this.activeCannon = this._findNearbyCannon();
    const aim = this._cannonAim(this.activeCannon);
    this.aimInTraverse = Boolean(aim?.inTraverse);
    this.aimLine.visible = this.marker.visible = this.aimInTraverse;
    if (!this.aimInTraverse) return;
    const { origin, dir } = aim;
    const vel = dir.multiplyScalar(PLAYER_MUZZLE_SPEED);
    const pts = predictTrajectory(origin, vel, this.getEnv(), { steps: 110, dt: 0.05 });
    this.aimLine.geometry.setFromPoints(pts);
    const last = pts[pts.length - 1];
    this.marker.position.set(last.x, last.y + 0.5, last.z);
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt) {
    for (const cannon of this.cannons) {
      if (cannon.reload > 0) cannon.reload -= dt;
    }

    const f = (this.keys["KeyW"] ? 1 : 0) - (this.keys["KeyS"] ? 1 : 0);
    const s = (this.keys["KeyD"] ? 1 : 0) - (this.keys["KeyA"] ? 1 : 0);
    if (f || s) {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(WALK_SPEED * dt);
      // Full move first; if blocked, slide along each axis so we glide past
      // mast trunks and deck edges instead of sticking.
      if (!this._tryMove(move.x, move.z)) {
        this._tryMove(move.x, 0) || this._tryMove(0, move.z);
      }
    }

    if (!this.surfaces.length) {
      const bx = this.dims.beam * 0.42;
      const bz = this.dims.length * 0.46;
      this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -bx, bx);
      this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -bz, bz);
    }

    this._groundFollow(dt);
    this.camera.position.y = EYE_HEIGHT;
    this.camera.rotation.set(this.pitch, 0, 0);
    this._updateAimPreview();

    const interactionPrompt = this.damageControl?.getPrompt(this.rig) || "";
    if (interactionPrompt) {
      this.prompt = interactionPrompt;
    } else if (this.activeCannon) {
      this.prompt = this.aimInTraverse
        ? "Нажми E или кнопку, чтобы выстрелить из этой пушки"
        : "Повернись в сектор наведения этой пушки";
    } else {
      this.prompt = this.locked ? "" : "Кликни, чтобы захватить мышь";
    }
  }

  getState() {
    const reload = this.activeCannon?.reload || 0;
    const canFire = Boolean(this.activeCannon && this.aimInTraverse && reload <= 0);
    const fireLabel = reload > 0
      ? "Перезарядка..."
      : this.aimInTraverse
        ? "Выстрелить [E]"
        : "Вне сектора";
    return {
      prompt: this.prompt,
      reload: 1 - Math.max(0, reload) / RELOAD,
      nearCannon: Boolean(this.activeCannon),
      canFire,
      fireLabel,
      canJump: !this.airborne,
    };
  }
}
