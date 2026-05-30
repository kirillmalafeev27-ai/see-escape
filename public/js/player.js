// player.js — first-person controller. The player rig is parented to the ship
// so it heaves/rolls with the deck. Walk with WASD + mouse-look (pointer lock),
// press E to man a nearby cannon, aim it with the mouse (a live predicted
// trajectory shows exactly where the shot lands), and fire with click / Space.
import * as THREE from "three";
import { predictTrajectory, GRAVITY } from "./ballistics.js";
import { SHIP } from "./ship.js";

const PLAYER_MUZZLE_SPEED = 235;
const WALK_SPEED = 16;
const LOOK_SENS = 0.0022;
const AIM_SENS = 0.0016;
const RELOAD = 2.2;

export class PlayerController {
  constructor({ scene, camera, ship, domElement, projectiles, effects, getEnv, onMessage }) {
    this.camera = camera;
    this.ship = ship;
    this.dom = domElement;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getEnv = getEnv;
    this.onMessage = onMessage || (() => {});

    this.rig = new THREE.Object3D();
    this.rig.position.set(0, SHIP.deckY, 18);
    ship.group.add(this.rig);
    this.rig.add(camera);
    camera.position.set(0, 6, 0);
    camera.rotation.set(0, 0, 0);

    this.yaw = Math.PI; // face the stern/center initially
    this.pitch = 0;
    this.mode = "walk"; // "walk" | "cannon"
    this.cannon = null;
    this.keys = {};
    this.locked = false;
    this.prompt = "";

    for (const c of ship.cannons) c.pReload = 0;

    // Aim preview line + landing marker (world space).
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.85 })
    );
    this.aimLine.frustumCulled = false;
    this.aimLine.visible = false;
    scene.add(this.aimLine);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(3, 4.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    scene.add(this.marker);

    this._bindInput();
  }

  _bindInput() {
    addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "KeyE") this._interact();
      if (e.code === "Space") {
        if (this.mode === "cannon") this._fire();
        e.preventDefault();
      }
    });
    addEventListener("keyup", (e) => (this.keys[e.code] = false));

    this.dom.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement !== this.dom) {
        this.dom.requestPointerLock();
        return;
      }
      if (this.mode === "cannon" && e.button === 0) this._fire();
      if (e.button === 2 && this.mode === "cannon") this._leaveCannon();
    });
    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
    });

    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      if (this.mode === "walk") {
        this.yaw -= e.movementX * LOOK_SENS;
        this.pitch -= e.movementY * LOOK_SENS;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.2, 1.2);
      } else if (this.cannon) {
        const c = this.cannon;
        c.yaw = THREE.MathUtils.clamp(c.yaw - e.movementX * AIM_SENS, -0.8, 0.8);
        c.pitchAngle = THREE.MathUtils.clamp(
          c.pitchAngle - e.movementY * AIM_SENS,
          0.02,
          0.95
        );
      }
    });
  }

  _interact() {
    if (this.mode === "cannon") {
      this._leaveCannon();
      return;
    }
    // nearest cannon within reach
    let near = null;
    let nd = 9;
    for (const c of this.ship.cannons) {
      const d = c.localPos.distanceTo(this.rig.position);
      if (d < nd) {
        nd = d;
        near = c;
      }
    }
    if (near) {
      this._manCannon(near);
      return;
    }
    // hatch?
    const h = this.ship.hatch;
    if (h && new THREE.Vector3(h.position.x, this.rig.position.y, h.position.z).distanceTo(this.rig.position) < (h.userData.radius || 7)) {
      this.onMessage("Трюм появится в следующем обновлении — спуск пока закрыт.");
    }
  }

  _manCannon(c) {
    this.mode = "cannon";
    this.cannon = c;
    this.onMessage("");
  }

  _leaveCannon() {
    const c = this.cannon;
    this.mode = "walk";
    this.aimLine.visible = false;
    this.marker.visible = false;
    // stand just inboard of the cannon we were manning
    if (c) this.rig.position.x = c.side === "stbd" ? c.localPos.x - 4 : c.localPos.x + 4;
    this.cannon = null;
  }

  _fire() {
    const c = this.cannon;
    if (!c || c.pReload > 0) return;
    c.pReload = RELOAD;
    c.muzzle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3();
    c.muzzle.getWorldPosition(origin);
    const q = new THREE.Quaternion();
    c.muzzle.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const vel = dir.multiplyScalar(PLAYER_MUZZLE_SPEED);
    this.projectiles.spawn(origin, vel, { team: "player" });
    this.effects.muzzleFlash(origin, vel);
  }

  _updateAimPreview() {
    const c = this.cannon;
    c.muzzle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3();
    c.muzzle.getWorldPosition(origin);
    const q = new THREE.Quaternion();
    c.muzzle.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const vel = dir.multiplyScalar(PLAYER_MUZZLE_SPEED);
    const env = this.getEnv();
    const pts = predictTrajectory(origin, vel, env, { steps: 100, dt: 0.05 });
    this.aimLine.geometry.setFromPoints(pts);
    this.aimLine.visible = true;
    const last = pts[pts.length - 1];
    this.marker.position.set(last.x, last.y + 0.5, last.z);
    this.marker.visible = true;
  }

  update(dt) {
    for (const c of this.ship.cannons) if (c.pReload > 0) c.pReload -= dt;

    if (this.mode === "walk") {
      // movement on the deck plane (ship-local)
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
      // keep on deck
      const bx = SHIP.beam * 0.4;
      const bz = SHIP.length * 0.42;
      this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -bx, bx);
      this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -bz, bz);
      this.rig.position.y = SHIP.deckY;
      this.rig.rotation.set(0, this.yaw, 0);
      this.camera.rotation.set(this.pitch, 0, 0);

      // interaction prompt
      this.prompt = "";
      let nd = 9;
      for (const c of this.ship.cannons) {
        const d = c.localPos.distanceTo(this.rig.position);
        if (d < nd) {
          nd = d;
          this.prompt = "E — встать к пушке";
        }
      }
      const h = this.ship.hatch;
      if (h) {
        const hd = new THREE.Vector3(h.position.x, this.rig.position.y, h.position.z).distanceTo(this.rig.position);
        if (hd < (h.userData.radius || 7)) this.prompt = "E — спуститься в трюм (скоро)";
      }
    } else if (this.mode === "cannon" && this.cannon) {
      const c = this.cannon;
      c.root.rotation.y = c.baseYaw + c.yaw;
      c.pitch.rotation.x = -c.pitchAngle;
      // place the eye just behind the breech, looking along the barrel
      this.rig.position.set(c.localPos.x, SHIP.deckY, c.localPos.z);
      this.rig.rotation.set(0, c.baseYaw + c.yaw, 0);
      this.camera.rotation.set(c.pitchAngle, 0, 0);
      this._updateAimPreview();
      this.prompt = "ЛКМ/Space — огонь · ПКМ/E — отойти";
    }
  }

  // For the HUD.
  getState() {
    let reload = 0;
    if (this.mode === "cannon" && this.cannon) {
      reload = 1 - Math.max(0, this.cannon.pReload) / RELOAD;
    }
    return { mode: this.mode, prompt: this.prompt, reload };
  }
}
