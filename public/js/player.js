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
    this._down = new THREE.Vector3(0, -1, 0);
    this._wp = new THREE.Vector3();

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

  // Stand on the real deck mesh under the player.
  _groundFollow() {
    this.rig.rotation.set(0, this.yaw, 0);
    this.rig.updateWorldMatrix(true, false);
    if (!this.ship.modelPivot) {
      this.rig.position.y = this.dims.deckY;
      return;
    }
    this.rig.getWorldPosition(this._wp);
    this._ray.set(new THREE.Vector3(this._wp.x, this._wp.y + 6, this._wp.z), this._down);
    this._ray.far = 60;
    const hits = this._ray.intersectObject(this.ship.modelPivot, true);
    if (hits.length) {
      const local = this.ship.group.worldToLocal(hits[0].point.clone());
      this.rig.position.y = local.y;
    }
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
      this.rig.position.x += move.x;
      this.rig.position.z += move.z;
    }
    const bx = this.dims.beam * 0.42;
    const bz = this.dims.length * 0.46;
    this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -bx, bx);
    this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -bz, bz);

    this._groundFollow();
    this.camera.rotation.set(this.pitch, 0, 0);
    this._updateAimPreview();

    this.prompt = this.locked ? "" : "Кликни, чтобы захватить мышь";
  }

  getState() {
    return { prompt: this.prompt, reload: 1 - Math.max(0, this.reload) / RELOAD };
  }
}
