// player.js — first-person deck controller. The player rig is parented to the
// ship so it heaves/rolls with it, and each frame it RAYCASTS straight down
// onto the actual .glb deck mesh so you physically stand on the model (steps,
// raised decks and all). You aim with the mouse — a live yellow trajectory arc
// shows where the cannonball lands — and fire with left click / Space.
import * as THREE from "three";
import { predictTrajectory } from "./ballistics.js";

const PLAYER_MUZZLE_SPEED = 220;
const WALK_SPEED = 14;
const LOOK_SENS = 0.0022;
const RELOAD = 1.8;
const EYE_HEIGHT = 4.2;
const PLAYER_RADIUS = 0.85;
const MAX_STEP_UP = 1.5;
const MAX_STEP_DOWN = 2.6;
const SUPPORT_HEIGHT_TOLERANCE = 1.1;
const BODY_RAY_HEIGHTS = [0.8, 2.5];
const SUPPORT_PROBES = [
  [0, 0],
  [PLAYER_RADIUS, 0],
  [-PLAYER_RADIUS, 0],
  [0, PLAYER_RADIUS],
  [0, -PLAYER_RADIUS],
];
const LOCAL_DOWN = new THREE.Vector3(0, -1, 0);

export class PlayerController {
  constructor({ scene, camera, ship, domElement, projectiles, effects, getEnv, onMessage }) {
    this.camera = camera;
    this.ship = ship;
    this.dom = domElement;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getEnv = getEnv;
    this.onMessage = onMessage || (() => {});
    this.dims = ship.dims;
    this.walkableMeshes = ship.walkableMeshes || [];
    this.solidMeshes = ship.solidMeshes || [];

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
    this.reload = 0;
    this.prompt = "";

    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._moveDirection = new THREE.Vector3();
    this._rayDirection = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._candidate = new THREE.Vector3();
    this._hitPoint = new THREE.Vector3();

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
  }

  _bindInput() {
    addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "Space") {
        this._fire();
        e.preventDefault();
      }
    });
    addEventListener("keyup", (e) => (this.keys[e.code] = false));

    this.dom.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement !== this.dom) {
        this.dom.requestPointerLock();
        return;
      }
      if (e.button === 0) this._fire();
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

  _muzzle() {
    // fire from the eye, along the look direction
    this.camera.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    origin.addScaledVector(dir, 2.5); // clear of the camera/ship
    return { origin, dir };
  }

  _fire() {
    if (this.reload > 0) return;
    this.reload = RELOAD;
    const { origin, dir } = this._muzzle();
    const vel = dir.clone().multiplyScalar(PLAYER_MUZZLE_SPEED);
    this.projectiles.spawn(origin, vel, { team: "player" });
    this.effects.muzzleFlash(origin, vel);
  }

  _updateAimPreview() {
    const { origin, dir } = this._muzzle();
    const vel = dir.multiplyScalar(PLAYER_MUZZLE_SPEED);
    const pts = predictTrajectory(origin, vel, this.getEnv(), { steps: 110, dt: 0.05 });
    this.aimLine.geometry.setFromPoints(pts);
    const last = pts[pts.length - 1];
    this.marker.position.set(last.x, last.y + 0.5, last.z);
  }

  _castLocal(origin, direction, objects, far) {
    this.ship.group.updateWorldMatrix(true, false);
    this._origin.copy(origin);
    this.ship.group.localToWorld(this._origin);
    this._rayDirection.copy(direction).transformDirection(this.ship.group.matrixWorld);
    this._ray.set(this._origin, this._rayDirection);
    this._ray.far = far;
    return this._ray.intersectObjects(objects, false);
  }

  _groundAt(position, stepUp = MAX_STEP_UP, stepDown = MAX_STEP_DOWN) {
    let groundY = null;
    for (const [dx, dz] of SUPPORT_PROBES) {
      this._origin.set(position.x + dx, position.y + stepUp + 0.05, position.z + dz);
      const hits = this._castLocal(this._origin, LOCAL_DOWN, this.walkableMeshes, stepUp + stepDown + 0.1);
      if (!hits.length) return null;
      this._hitPoint.copy(hits[0].point);
      this.ship.group.worldToLocal(this._hitPoint);
      if (groundY === null) {
        groundY = this._hitPoint.y;
      } else if (Math.abs(this._hitPoint.y - groundY) > SUPPORT_HEIGHT_TOLERANCE) {
        return null;
      }
    }
    return groundY;
  }

  _hasObstacle(from, to) {
    if (!this.solidMeshes.length) return false;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-5) return false;

    this._moveDirection.set(dx / distance, 0, dz / distance);
    this._side.set(-this._moveDirection.z, 0, this._moveDirection.x);
    for (const lateral of [-PLAYER_RADIUS, 0, PLAYER_RADIUS]) {
      for (const height of BODY_RAY_HEIGHTS) {
        this._origin.set(
          from.x + this._side.x * lateral,
          from.y + height,
          from.z + this._side.z * lateral
        );
        if (this._castLocal(this._origin, this._moveDirection, this.solidMeshes, distance + PLAYER_RADIUS).length) {
          return true;
        }
      }
    }
    return false;
  }

  _tryMove(dx, dz) {
    if (!dx && !dz) return false;
    this._candidate.set(this.rig.position.x + dx, this.rig.position.y, this.rig.position.z + dz);
    const groundY = this._groundAt(this._candidate);
    if (groundY === null) return false;
    this._candidate.y = groundY;
    if (this._hasObstacle(this.rig.position, this._candidate)) return false;
    this.rig.position.copy(this._candidate);
    return true;
  }

  _placeOnDeck() {
    if (!this.walkableMeshes.length) return;
    this.ship.group.updateMatrixWorld(true);
    for (const z of [this.dims.length * 0.12, 0, -this.dims.length * 0.12, this.dims.length * 0.24]) {
      for (const x of [0, -this.dims.beam * 0.14, this.dims.beam * 0.14]) {
        this._candidate.set(x, this.dims.deckY, z);
        const groundY = this._groundAt(this._candidate, 30, 60);
        if (groundY !== null) {
          this.rig.position.set(x, groundY, z);
          return;
        }
      }
    }
  }

  // Keep the rig on the deck in ship-local space so pitch and roll do not
  // turn world-down into a sideways slide across the model.
  _groundFollow() {
    this.rig.rotation.set(0, this.yaw, 0);
    if (!this.walkableMeshes.length) {
      this.rig.position.y = this.dims.deckY;
      return;
    }
    const groundY = this._groundAt(this.rig.position);
    if (groundY !== null) this.rig.position.y = groundY;
  }

  update(dt) {
    if (this.reload > 0) this.reload -= dt;

    // movement on the deck plane (ship-local x/z)
    const f = (this.keys["KeyW"] ? 1 : 0) - (this.keys["KeyS"] ? 1 : 0);
    const s = (this.keys["KeyD"] ? 1 : 0) - (this.keys["KeyA"] ? 1 : 0);
    if (f || s) {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(WALK_SPEED * dt);
      if (this.walkableMeshes.length) {
        if (!this._tryMove(move.x, move.z)) {
          this._tryMove(move.x, 0);
          this._tryMove(0, move.z);
        }
      } else {
        this.rig.position.x += move.x;
        this.rig.position.z += move.z;
      }
    }
    if (!this.walkableMeshes.length) {
      const bx = this.dims.beam * 0.42;
      const bz = this.dims.length * 0.46;
      this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -bx, bx);
      this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -bz, bz);
    }

    this._groundFollow();
    this.camera.rotation.set(this.pitch, 0, 0);
    this._updateAimPreview();

    this.prompt = this.locked ? "" : "Кликни, чтобы захватить мышь";
  }

  getState() {
    return { prompt: this.prompt, reload: 1 - Math.max(0, this.reload) / RELOAD };
  }
}
