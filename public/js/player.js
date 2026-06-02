// player.js — first-person deck controller. The player rig is parented to the
// ship so it heaves/rolls with it, and each frame it RAYCASTS straight down
// onto the actual .glb deck mesh so you physically stand on the model (steps,
// raised decks and all). A nearby deck cannon follows the mouse within its
// traverse; the yellow arc starts at its muzzle and E fires that cannon.
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
const MAX_STAIR_STEP_UP = 3.4;
const MAX_STAIR_STEP_DOWN = 4.2;
const SUPPORT_HEIGHT_TOLERANCE = 1.1;
const STAIR_SUPPORT_HEIGHT_TOLERANCE = 3.0;
const GROUND_RESPONSE = 18;
const STAIR_GROUND_RESPONSE = 28;
const JUMP_SPEED = 16;
const JUMP_GRAVITY = 32;
const JUMP_LANDING_SCAN = 9;
const JUMP_LANDING_SNAP = 0.45;
const POSITION_CLEARANCE = PLAYER_RADIUS * 0.72;
const LANDING_CLEARANCE = PLAYER_RADIUS * 0.55;
const UNSTUCK_DELAY = 0.35;
const RAIL_VIEW_DISTANCE = 2.8;
const RAIL_EYE_LIFT = 2.6;
const RAIL_EYE_RESPONSE = 10;
const MIN_CANNON_PITCH = THREE.MathUtils.degToRad(-8);
const MAX_CANNON_PITCH = THREE.MathUtils.degToRad(38);
const CANNON_INTERACTION_RANGE = 7.5;
const BODY_RAY_HEIGHTS = [0.8, 2.5];
const SUPPORT_PROBES = [
  [0, 0],
  [PLAYER_RADIUS, 0],
  [-PLAYER_RADIUS, 0],
  [0, PLAYER_RADIUS],
  [0, -PLAYER_RADIUS],
];
const STAIR_PROBE_RADIUS = 0.42;
const STAIR_SUPPORT_PROBES = [
  [0, 0],
  [STAIR_PROBE_RADIUS, 0],
  [-STAIR_PROBE_RADIUS, 0],
  [0, STAIR_PROBE_RADIUS],
  [0, -STAIR_PROBE_RADIUS],
];
const STAIR_NODE = /(?:stairs|ladder)/i;
const STAIR_THRESHOLD_NODE = /(?:body|wall|rail|fence|grid|grate)/i;
const VIEW_BLOCKING_RAIL_NODE = /(?:fencing|wall|rail|fence|grid|grate)/i;
const LOCAL_DOWN = new THREE.Vector3(0, -1, 0);
const RAIL_PROBE_HEIGHTS = [EYE_HEIGHT - 1.1, EYE_HEIGHT - 0.25, EYE_HEIGHT + 0.4];
const CLEARANCE_DIRECTIONS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(1, 0, 1).normalize(),
  new THREE.Vector3(-1, 0, 1).normalize(),
  new THREE.Vector3(1, 0, -1).normalize(),
  new THREE.Vector3(-1, 0, -1).normalize(),
];

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
    this.walkableMeshes = ship.walkableMeshes || [];
    this.stairZones = ship.stairZones || [];
    this.solidMeshes = ship.solidMeshes || [];
    this.viewBlockingRailMeshes = this.solidMeshes.filter((mesh) =>
      VIEW_BLOCKING_RAIL_NODE.test(mesh.name || "")
    );
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

    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._moveDirection = new THREE.Vector3();
    this._rayDirection = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._candidate = new THREE.Vector3();
    this._landingProbe = new THREE.Vector3();
    this._lastSafePosition = new THREE.Vector3();
    this._hitPoint = new THREE.Vector3();
    this._viewDirection = new THREE.Vector3();
    this._inverseShip = new THREE.Matrix4();
    this.activeCannon = null;
    this.aimInTraverse = false;
    this.airborne = false;
    this.verticalVelocity = 0;
    this._failedMoveTime = 0;
    this._hasSafePosition = false;

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
    this._rememberSafePosition();
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

    this.dom.addEventListener("mousedown", (e) => {
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
      this._rememberSafePosition();
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

  _castLocal(origin, direction, objects, far) {
    this.ship.group.updateWorldMatrix(true, false);
    this._origin.copy(origin);
    this.ship.group.localToWorld(this._origin);
    this._rayDirection.copy(direction).transformDirection(this.ship.group.matrixWorld);
    this._ray.set(this._origin, this._rayDirection);
    this._ray.far = far;
    return this._ray.intersectObjects(objects, false);
  }

  _groundHit(position, dx, dz, stepUp, stepDown) {
      this._origin.set(position.x + dx, position.y + stepUp + 0.05, position.z + dz);
      const hits = this._castLocal(this._origin, LOCAL_DOWN, this.walkableMeshes, stepUp + stepDown + 0.1);
      if (!hits.length) return null;
      const hit = hits[0];
      this._hitPoint.copy(hit.point);
      this.ship.group.worldToLocal(this._hitPoint);
      return {
        y: this._hitPoint.y,
        onStairs: STAIR_NODE.test(hit.object.name || ""),
      };
  }

  _inStairZone(position, padding = 0) {
    return this.stairZones.some(
      (box) =>
        position.x >= box.min.x - padding &&
        position.x <= box.max.x + padding &&
        position.y >= box.min.y - padding &&
        position.y <= box.max.y + padding &&
        position.z >= box.min.z - padding &&
        position.z <= box.max.z + padding
    );
  }

  _stairTransitionZone(from, to, padding = 0.25) {
    return this.stairZones.find((box) => {
      const inside = (position) =>
        position.x >= box.min.x - padding &&
        position.x <= box.max.x + padding &&
        position.y >= box.min.y - padding &&
        position.y <= box.max.y + padding &&
        position.z >= box.min.z - padding &&
        position.z <= box.max.z + padding;
      return inside(from) || inside(to);
    });
  }

  _hasBlockingHit(hits, stairTransition = null) {
    return hits.some(
      (hit) => !stairTransition || !STAIR_THRESHOLD_NODE.test(hit.object.name || "")
    );
  }

  _groundAt(position, stepUp = MAX_STAIR_STEP_UP, stepDown = MAX_STAIR_STEP_DOWN, allowLargeStep = false) {
    const center = this._groundHit(position, 0, 0, stepUp, stepDown);
    if (!center) return null;
    const inStairZone = this._inStairZone(position, 0.35);
    if (inStairZone || center.onStairs) {
      const deltaY = center.y - position.y;
      if (!allowLargeStep && (deltaY > MAX_STAIR_STEP_UP || deltaY < -MAX_STAIR_STEP_DOWN)) return null;
      return { y: center.y, onStairs: true };
    }

    const tryProbes = (probes) => {
      let onStairs = false;
      const samples = [center];
      for (const [dx, dz] of probes) {
        if (!dx && !dz) continue;
        const hit = this._groundHit(position, dx, dz, stepUp, stepDown);
        if (!hit) return null;
        samples.push(hit);
        onStairs ||= hit.onStairs;
      }
      const tolerance = onStairs ? STAIR_SUPPORT_HEIGHT_TOLERANCE : SUPPORT_HEIGHT_TOLERANCE;
      if (samples.some((sample) => Math.abs(sample.y - center.y) > tolerance)) return null;
      const maxStepUp = onStairs ? MAX_STAIR_STEP_UP : MAX_STEP_UP;
      const maxStepDown = onStairs ? MAX_STAIR_STEP_DOWN : MAX_STEP_DOWN;
      const deltaY = center.y - position.y;
      if (!allowLargeStep && (deltaY > maxStepUp || deltaY < -maxStepDown)) return null;
      return { y: center.y, onStairs };
    };

    const regular = tryProbes(SUPPORT_PROBES);
    if (regular) return regular;
    const stairFallback = tryProbes(STAIR_SUPPORT_PROBES);
    return stairFallback?.onStairs ? stairFallback : null;
  }

  _hasObstacle(from, to) {
    if (!this.solidMeshes.length) return false;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-5) return false;
    const stairTransition = this._stairTransitionZone(from, to);

    this._moveDirection.set(dx / distance, 0, dz / distance);
    this._side.set(-this._moveDirection.z, 0, this._moveDirection.x);
    for (const lateral of [-PLAYER_RADIUS, 0, PLAYER_RADIUS]) {
      for (const height of BODY_RAY_HEIGHTS) {
        this._origin.set(
          from.x + this._side.x * lateral,
          from.y + height,
          from.z + this._side.z * lateral
        );
        const hits = this._castLocal(this._origin, this._moveDirection, this.solidMeshes, distance + PLAYER_RADIUS);
        if (this._hasBlockingHit(hits, stairTransition)) {
          return true;
        }
      }
    }
    return false;
  }

  _isPositionClear(position, clearance = POSITION_CLEARANCE, stairTransition = null) {
    if (!this.solidMeshes.length) return true;
    for (const height of BODY_RAY_HEIGHTS) {
      for (const direction of CLEARANCE_DIRECTIONS) {
        this._origin.set(position.x, position.y + height, position.z);
        const hits = this._castLocal(this._origin, direction, this.solidMeshes, clearance);
        if (this._hasBlockingHit(hits, stairTransition)) return false;
      }
    }
    return true;
  }

  _rememberSafePosition() {
    if (this.airborne || this._inStairZone(this.rig.position, 0.25)) return;
    if (this._isPositionClear(this.rig.position)) {
      this._lastSafePosition.copy(this.rig.position);
      this._hasSafePosition = true;
    }
  }

  _recoverFromStuck() {
    this.verticalVelocity = 0;
    this.airborne = false;
    this._failedMoveTime = 0;
    if (this._hasSafePosition) this.rig.position.copy(this._lastSafePosition);
    else this._placeOnDeck();
  }

  _isNearViewBlockingRail() {
    if (!this.viewBlockingRailMeshes.length) return false;
    for (const height of RAIL_PROBE_HEIGHTS) {
      for (const direction of CLEARANCE_DIRECTIONS) {
        this._origin.set(this.rig.position.x, this.rig.position.y + height, this.rig.position.z);
        if (this._castLocal(this._origin, direction, this.viewBlockingRailMeshes, RAIL_VIEW_DISTANCE).length) {
          return true;
        }
      }
    }
    return false;
  }

  _updateCameraHeight(dt) {
    const target = EYE_HEIGHT + (this._isNearViewBlockingRail() ? RAIL_EYE_LIFT : 0);
    const alpha = 1 - Math.exp(-RAIL_EYE_RESPONSE * Math.max(0, dt));
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, target, alpha);
  }

  _hasEscapeRoute() {
    const distance = PLAYER_RADIUS * 1.35;
    for (const direction of CLEARANCE_DIRECTIONS) {
      this._candidate.set(
        this.rig.position.x + direction.x * distance,
        this.rig.position.y,
        this.rig.position.z + direction.z * distance
      );
      const ground = this._groundAt(this._candidate);
      if (!ground) continue;
      this._candidate.y = ground.y;
      const stairTransition = this._stairTransitionZone(this.rig.position, this._candidate);
      if (
        !this._hasObstacle(this.rig.position, this._candidate) &&
        this._isPositionClear(this._candidate, LANDING_CLEARANCE, stairTransition)
      ) {
        return true;
      }
    }
    return false;
  }

  _tryMove(dx, dz) {
    if (!dx && !dz) return false;
    this._candidate.set(this.rig.position.x + dx, this.rig.position.y, this.rig.position.z + dz);
    const stairTransition = this._stairTransitionZone(this.rig.position, this._candidate);
    if (this.airborne) {
      if (this._hasObstacle(this.rig.position, this._candidate)) return false;
      if (!this._isPositionClear(this._candidate, POSITION_CLEARANCE, stairTransition)) return false;
      this.rig.position.x = this._candidate.x;
      this.rig.position.z = this._candidate.z;
      return true;
    }
    const ground = this._groundAt(this._candidate);
    if (!ground) return false;
    this._candidate.y = ground.y;
    if (this._hasObstacle(this.rig.position, this._candidate)) return false;
    if (!this._isPositionClear(this._candidate, POSITION_CLEARANCE, stairTransition)) return false;
    this.rig.position.x = this._candidate.x;
    this.rig.position.z = this._candidate.z;
    return true;
  }

  _jump() {
    if (this.airborne) return;
    if (this.walkableMeshes.length) {
      const ground = this._groundAt(this.rig.position, MAX_STAIR_STEP_UP, MAX_STAIR_STEP_DOWN, true);
      if (!ground || Math.abs(this.rig.position.y - ground.y) > MAX_STAIR_STEP_DOWN) return;
      this.rig.position.y = ground.y;
    }
    this.airborne = true;
    this.verticalVelocity = JUMP_SPEED;
  }

  _placeOnDeck() {
    if (!this.walkableMeshes.length) return;
    this.ship.group.updateMatrixWorld(true);
    for (const z of [this.dims.length * 0.12, 0, -this.dims.length * 0.12, this.dims.length * 0.24]) {
      for (const x of [0, -this.dims.beam * 0.14, this.dims.beam * 0.14]) {
        this._candidate.set(x, this.dims.deckY, z);
        const ground = this._groundAt(this._candidate, 30, 60, true);
        if (ground) {
          this._candidate.y = ground.y;
          if (!this._isPositionClear(this._candidate)) continue;
          this.rig.position.copy(this._candidate);
          this._rememberSafePosition();
          return;
        }
      }
    }
  }

  _landingGroundAt(previousY, currentY) {
    const fallDistance = Math.max(0, previousY - currentY);
    this._landingProbe.set(this.rig.position.x, previousY, this.rig.position.z);
    const scan = Math.max(JUMP_LANDING_SCAN, fallDistance + JUMP_LANDING_SNAP);
    const ground =
      this._groundAt(this._landingProbe, JUMP_LANDING_SNAP, scan, true) ||
      this._groundHit(this._landingProbe, 0, 0, JUMP_LANDING_SNAP, scan);
    if (!ground) return null;
    return ground.y <= previousY + JUMP_LANDING_SNAP && ground.y >= currentY - JUMP_LANDING_SNAP
      ? ground
      : null;
  }

  // Keep the rig on the deck in ship-local space so pitch and roll do not
  // turn world-down into a sideways slide across the model.
  _groundFollow(dt = 1 / 60) {
    this.rig.rotation.set(0, this.yaw, 0);
    if (this.airborne) {
      const previousY = this.rig.position.y;
      this.verticalVelocity -= JUMP_GRAVITY * dt;
      this.rig.position.y += this.verticalVelocity * dt;

      if (this.verticalVelocity <= 0) {
        const ground = this.walkableMeshes.length
          ? this._landingGroundAt(previousY, this.rig.position.y)
          : { y: this.dims.deckY };
        if (ground) {
          this.rig.position.y = ground.y;
          this.verticalVelocity = 0;
          this.airborne = false;
          if (this._isPositionClear(this.rig.position, LANDING_CLEARANCE)) {
            this._rememberSafePosition();
          } else {
            this._recoverFromStuck();
          }
        }
      }

      if (this.rig.position.y < this.dims.keelY - JUMP_LANDING_SCAN) {
        this.verticalVelocity = 0;
        this.airborne = false;
        this.rig.position.copy(this._lastSafePosition);
      }
      return;
    }
    if (!this.walkableMeshes.length) {
      this.rig.position.y = this.dims.deckY;
      return;
    }
    const ground = this._groundAt(this.rig.position);
    if (ground) {
      const response = ground.onStairs ? STAIR_GROUND_RESPONSE : GROUND_RESPONSE;
      const alpha = 1 - Math.exp(-response * Math.max(0, dt));
      this.rig.position.y = THREE.MathUtils.lerp(this.rig.position.y, ground.y, alpha);
      this._rememberSafePosition();
    }
  }

  update(dt) {
    for (const cannon of this.cannons) {
      if (cannon.reload > 0) cannon.reload -= dt;
    }

    // movement on the deck plane (ship-local x/z)
    const f = (this.keys["KeyW"] ? 1 : 0) - (this.keys["KeyS"] ? 1 : 0);
    const s = (this.keys["KeyD"] ? 1 : 0) - (this.keys["KeyA"] ? 1 : 0);
    if (f || s) {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(WALK_SPEED * dt);
      if (this.walkableMeshes.length) {
        let moved = this._tryMove(move.x, move.z);
        if (!moved) {
          moved = this._tryMove(move.x, 0) || this._tryMove(0, move.z);
        }
        if (moved) {
          this._failedMoveTime = 0;
        } else {
          this._failedMoveTime += dt;
          if (
            this._failedMoveTime >= UNSTUCK_DELAY &&
            (!this._isPositionClear(this.rig.position, LANDING_CLEARANCE) || !this._hasEscapeRoute())
          ) {
            this._recoverFromStuck();
          }
        }
      } else {
        this.rig.position.x += move.x;
        this.rig.position.z += move.z;
      }
    } else {
      this._failedMoveTime = 0;
    }
    if (!this.walkableMeshes.length) {
      const bx = this.dims.beam * 0.42;
      const bz = this.dims.length * 0.46;
      this.rig.position.x = THREE.MathUtils.clamp(this.rig.position.x, -bx, bx);
      this.rig.position.z = THREE.MathUtils.clamp(this.rig.position.z, -bz, bz);
    }

    this._groundFollow(dt);
    this._updateCameraHeight(dt);
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
