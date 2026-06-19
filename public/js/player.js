// player.js — first-person deck controller. The player rig is parented to the
// ship so it heaves/rolls with it, and each frame it raycasts straight down
// onto the actual .glb deck mesh so you physically stand on the model (steps,
// raised decks and all). A nearby deck cannon follows the mouse within its
// traverse; the yellow arc starts at its muzzle and a quiz-gated action arms it.
import * as THREE from "three";
import { predictTrajectory } from "./ballistics.js?v=20260619-authoritative-coop-v2";
import { pointInsideCollisionHole } from "./collision-profile.js?v=20260609-remove-hold-helpers-v1";

const PLAYER_MUZZLE_SPEED = 220;
const GRAPESHOT_MUZZLE_SPEED = 155;
const WALK_SPEED = 14;
const LOOK_SENS = 0.0022;
const TOUCH_LOOK_SENS = 0.0042;
const TOUCH_JOYSTICK_RADIUS = 58;
const TOUCH_MOVE_DEADZONE = 0.12;
const TOUCH_CONTROLS_QUERY = "(pointer: coarse), (max-width: 900px)";
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
const JUMP_FALLBACK_SUPPORT_DISTANCE = 3.2;
const JUMP_FALLBACK_SUPPORT_HEIGHT = 5.2;
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
  constructor({ scene, camera, ship, domElement, projectiles, effects, getEnv, fireButton, dumpButton, jumpButton, takePlankButton, scoopWaterButton, patchBreachButton, islandTeleportButton, damageControl, sailing, islandQuest, requestActionQuiz, onMessage, onCoopAction }) {
    this.camera = camera;
    this.ship = ship;
    this.dom = domElement;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getEnv = getEnv;
    this.fireButton = fireButton;
    this.dumpButton = dumpButton;
    this.jumpButton = jumpButton;
    this.takePlankButton = takePlankButton;
    this.scoopWaterButton = scoopWaterButton;
    this.patchBreachButton = patchBreachButton;
    this.islandTeleportButton = islandTeleportButton;
    this.damageControl = damageControl || null;
    this.sailing = sailing || null;
    this.islandQuest = islandQuest || null;
    this.requestActionQuiz = requestActionQuiz || null;
    this.onMessage = onMessage || (() => {});
    this.onCoopAction = onCoopAction || (() => {});
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
    this.keyboardKeys = {};
    this.virtualKeys = {};
    this.virtualMove = { forward: 0, side: 0 };
    this.touchControls = null;
    this.touchMoveId = null;
    this.touchLookId = null;
    this.touchLookLast = { x: 0, y: 0 };
    const coarseInput =
      typeof matchMedia === "function" && matchMedia(TOUCH_CONTROLS_QUERY).matches;
    this.isTouchDevice =
      coarseInput || (typeof navigator !== "undefined" && Number(navigator.maxTouchPoints) > 0);
    this.locked = false;
    this.dragLook = false;
    this.prompt = "";
    this.questMode = false;
    this.walkMultiplier = 1;
    this.grapeshotUnlocked = false;
    this.cannonMode = "round";
    this.handCannonCharges = 0;
    this.quizActionPending = false;
    this.fireQuizGrant = null;
    this.deckFireGrants = new Set();
    this.cursorMode = "camera";

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
    this.handCannon = this._buildHandCannon();
    camera.add(this.handCannon);

    this._bindInput();
    this._placeOnDeck();
    this._rememberSafePosition();
  }

  enterCursorMode() {
    this.cursorMode = "ui";
    this.dragLook = false;
    document.body?.classList.add("cursor-mode");
    document.body?.classList.remove("camera-mode");
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
  }

  enterCameraMode() {
    this.cursorMode = "camera";
    document.body?.classList.add("camera-mode");
    document.body?.classList.remove("cursor-mode");
    if (this.questMode || this.islandQuest?.active || this.quizActionPending) return;
    if (document.pointerLockElement !== this.dom) {
      try {
        const lock = this.dom.requestPointerLock?.();
        lock?.catch?.(() => {});
      } catch (_) {
        // Some browsers require direct user activation; the next canvas click will lock.
      }
    }
  }

  _hasGrantedFireFromUnlockedClick() {
    const cannon = this._findNearbyCannon();
    if (cannon) return this._hasFireQuizGrant("deck-cannon", cannon);
    return this.handCannonCharges > 0 && this._hasFireQuizGrant("hand-cannon");
  }

  _setKeyState(code, active, source = "keyboard") {
    const state = source === "virtual" ? this.virtualKeys : this.keyboardKeys;
    if (active) state[code] = true;
    else delete state[code];
    this.keys[code] = Boolean(this.keyboardKeys[code] || this.virtualKeys[code]);
  }

  _applyMoveDeadzone(value) {
    const abs = Math.abs(value);
    if (abs <= TOUCH_MOVE_DEADZONE) return 0;
    return Math.sign(value) * THREE.MathUtils.clamp((abs - TOUCH_MOVE_DEADZONE) / (1 - TOUCH_MOVE_DEADZONE), 0, 1);
  }

  _setVirtualMove(side, forward) {
    this.virtualMove.side = this._applyMoveDeadzone(THREE.MathUtils.clamp(side, -1, 1));
    this.virtualMove.forward = this._applyMoveDeadzone(THREE.MathUtils.clamp(forward, -1, 1));
    this._setKeyState("KeyW", this.virtualMove.forward > 0.18, "virtual");
    this._setKeyState("KeyS", this.virtualMove.forward < -0.18, "virtual");
    this._setKeyState("KeyD", this.virtualMove.side > 0.18, "virtual");
    this._setKeyState("KeyA", this.virtualMove.side < -0.18, "virtual");
  }

  _resetVirtualMove() {
    this.virtualMove.forward = 0;
    this.virtualMove.side = 0;
    for (const code of ["KeyW", "KeyS", "KeyA", "KeyD"]) {
      this._setKeyState(code, false, "virtual");
    }
    this.touchControls?.stick?.style.setProperty("--stick-x", "0px");
    this.touchControls?.stick?.style.setProperty("--stick-y", "0px");
  }

  _touchLookAllowed() {
    return !this.quizActionPending && !this.questMode && !this.islandQuest?.active;
  }

  _enterTouchCameraMode() {
    this.cursorMode = "camera";
    document.body?.classList.add("camera-mode");
    document.body?.classList.remove("cursor-mode");
  }

  _applyTouchLook(dx, dy) {
    this.yaw += dx * TOUCH_LOOK_SENS;
    this.pitch -= dy * TOUCH_LOOK_SENS;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.3, 1.3);
  }

  _createTouchControls() {
    if (!this.isTouchDevice || typeof document === "undefined") return;

    document.getElementById("mobileControls")?.remove();
    const root = document.createElement("div");
    root.id = "mobileControls";
    root.className = "mobile-controls";
    root.setAttribute("aria-hidden", "true");

    const stick = document.createElement("div");
    stick.className = "mobile-stick";
    const knob = document.createElement("div");
    knob.className = "mobile-stick-knob";
    stick.appendChild(knob);

    const lookPad = document.createElement("div");
    lookPad.className = "mobile-look-pad";

    root.append(stick, lookPad);
    document.body.appendChild(root);
    this.touchControls = { root, stick, knob, lookPad };
    document.body?.classList.add("touch-controls");

    const preventHoldGesture = (e) => e.preventDefault();
    for (const element of [root, stick, knob, lookPad]) {
      element?.addEventListener("contextmenu", preventHoldGesture);
      element?.addEventListener("selectstart", preventHoldGesture);
      element?.addEventListener("gesturestart", preventHoldGesture);
    }

    const updateStick = (e) => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const distance = Math.hypot(dx, dy);
      if (distance > TOUCH_JOYSTICK_RADIUS) {
        const scale = TOUCH_JOYSTICK_RADIUS / distance;
        dx *= scale;
        dy *= scale;
      }
      stick.style.setProperty("--stick-x", `${dx}px`);
      stick.style.setProperty("--stick-y", `${dy}px`);
      this._setVirtualMove(dx / TOUCH_JOYSTICK_RADIUS, -dy / TOUCH_JOYSTICK_RADIUS);
    };

    const beginMove = (e) => {
      if (this.touchMoveId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      this.touchMoveId = e.pointerId;
      try {
        stick.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Some WebKit builds can reject capture during system gestures.
      }
      updateStick(e);
    };
    const continueMove = (e) => {
      if (e.pointerId !== this.touchMoveId) return;
      e.preventDefault();
      e.stopPropagation();
      updateStick(e);
    };
    const endMove = (e) => {
      if (e.pointerId !== this.touchMoveId) return;
      e.preventDefault();
      e.stopPropagation();
      this.touchMoveId = null;
      this._resetVirtualMove();
    };

    stick.addEventListener("pointerdown", beginMove);
    stick.addEventListener("pointermove", continueMove);
    stick.addEventListener("pointerup", endMove);
    stick.addEventListener("pointercancel", endMove);
    stick.addEventListener("lostpointercapture", endMove);

    const beginLook = (e) => {
      if (this.touchLookId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (!this._touchLookAllowed()) return;
      e.preventDefault();
      e.stopPropagation();
      this.touchLookId = e.pointerId;
      this.touchLookLast.x = e.clientX;
      this.touchLookLast.y = e.clientY;
      this._enterTouchCameraMode();
      try {
        lookPad.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Touch look still works without capture, it just stops on cancel/up.
      }
    };
    const continueLook = (e) => {
      if (e.pointerId !== this.touchLookId) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - this.touchLookLast.x;
      const dy = e.clientY - this.touchLookLast.y;
      this.touchLookLast.x = e.clientX;
      this.touchLookLast.y = e.clientY;
      this._applyTouchLook(dx, dy);
    };
    const endLook = (e) => {
      if (e.pointerId !== this.touchLookId) return;
      e.preventDefault();
      e.stopPropagation();
      this.touchLookId = null;
    };

    lookPad.addEventListener("pointerdown", beginLook);
    lookPad.addEventListener("pointermove", continueLook);
    lookPad.addEventListener("pointerup", endLook);
    lookPad.addEventListener("pointercancel", endLook);
    lookPad.addEventListener("lostpointercapture", endLook);

    addEventListener("blur", () => {
      this.touchMoveId = null;
      this.touchLookId = null;
      this._resetVirtualMove();
    });
  }

  _bindInput() {
    addEventListener("keydown", (e) => {
      this._setKeyState(e.code, true, "keyboard");
      if (e.code === "KeyE" && !e.repeat) {
        this._interact();
        e.preventDefault();
      }
      if (e.code === "KeyF" && !e.repeat) {
        if (this.damageControl?.canPatchBreach(this.rig) || this.damageControl?.canTakePlank(this.rig)) {
          this._secondaryInteract();
        } else if (this.activeCannon || this.handCannonCharges > 0) {
          this._fire();
        } else {
          this._secondaryInteract();
        }
        e.preventDefault();
      }
      if (e.code === "Space" && !e.repeat) {
        this._jump();
        e.preventDefault();
      }
      if (e.code === "KeyG" && !e.repeat && this.grapeshotUnlocked) {
        this.cannonMode = this.cannonMode === "grapeshot" ? "round" : "grapeshot";
        this.onMessage(this.cannonMode === "grapeshot" ? "Режим пушек: картечь." : "Режим пушек: ядро.");
      }
    });
    addEventListener("keyup", (e) => this._setKeyState(e.code, false, "keyboard"));

    this.dom.addEventListener("mousedown", (e) => {
      if (this.quizActionPending) {
        this.enterCursorMode();
        e.preventDefault();
        return;
      }
      if (this.questMode || this.islandQuest?.active) {
        this.enterCursorMode();
        this.dragLook = e.button === 0;
        return;
      }
      if (document.pointerLockElement !== this.dom) {
        if (e.button === 0) {
          this.enterCameraMode();
          e.preventDefault();
        }
        return;
      } else if (e.button === 0) {
        this._fire();
      }
    });
    addEventListener("mouseup", () => {
      this.dragLook = false;
    });
    const stopUiPointer = (e) => {
      e.stopPropagation();
      this.enterCursorMode();
    };
    const preventHoldMenu = (e) => e.preventDefault();
    for (const button of [
      this.fireButton,
      this.dumpButton,
      this.takePlankButton,
      this.scoopWaterButton,
      this.patchBreachButton,
      this.islandTeleportButton,
      this.jumpButton,
    ]) {
      button?.addEventListener("contextmenu", preventHoldMenu);
      button?.addEventListener("selectstart", preventHoldMenu);
      button?.addEventListener("gesturestart", preventHoldMenu);
    }
    this.fireButton?.addEventListener("pointerdown", stopUiPointer);
    this.fireButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._fire();
    });
    this.dumpButton?.addEventListener("pointerdown", stopUiPointer);
    this.dumpButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._dumpBucket();
    });
    this.takePlankButton?.addEventListener("pointerdown", stopUiPointer);
    this.takePlankButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._takePlank();
    });
    this.scoopWaterButton?.addEventListener("pointerdown", stopUiPointer);
    this.scoopWaterButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._scoopWater();
    });
    this.patchBreachButton?.addEventListener("pointerdown", stopUiPointer);
    this.patchBreachButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._secondaryInteract();
    });
    this.islandTeleportButton?.addEventListener("pointerdown", stopUiPointer);
    this.islandTeleportButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.islandQuest?.forceStart();
    });
    this.jumpButton?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.enterCursorMode();
    });
    this.jumpButton?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._jump();
    });
    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked) {
        this.cursorMode = "camera";
        document.body?.classList.add("camera-mode");
        document.body?.classList.remove("cursor-mode");
      }
    });
    addEventListener("mousemove", (e) => {
      const freeIslandLook = (this.dragLook || Boolean(e.buttons & 1)) && (this.questMode || this.islandQuest?.active);
      if (!this.locked && !freeIslandLook) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch -= e.movementY * LOOK_SENS;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.3, 1.3);
    });
    this._createTouchControls();
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

  _buildHandCannon() {
    const group = new THREE.Group();
    group.name = "HandCannonBonus";
    const metal = new THREE.MeshStandardMaterial({ color: 0x27343a, roughness: 0.42, metalness: 0.62 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b351f, roughness: 0.86 });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 1.45, 12), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.72, -0.72, -1.25);
    group.add(barrel);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.35, 0.72), wood);
    stock.position.set(0.72, -0.92, -0.72);
    group.add(stock);
    group.rotation.set(-0.08, 0.18, -0.08);
    group.visible = false;
    return group;
  }

  addWalkMultiplier(amount = 0.25) {
    this.walkMultiplier *= 1 + amount;
  }

  unlockGrapeshot() {
    this.grapeshotUnlocked = true;
    this.cannonMode = "grapeshot";
  }

  addHandCannonCharges(count = 3) {
    this.handCannonCharges += count;
    if (this.handCannon) this.handCannon.visible = this.handCannonCharges > 0;
  }

  captureWorldPose() {
    this.ship.group.updateMatrixWorld(true);
    this.rig.updateWorldMatrix(true, false);
    return {
      position: this.rig.getWorldPosition(new THREE.Vector3()),
      localPosition: this.rig.position.clone(),
      yaw: this.yaw + this.ship.group.rotation.y,
      pitch: this.pitch,
      eyeHeight: this.camera.position.y,
    };
  }

  resetForRun() {
    this.questMode = false;
    this.activeCannon = null;
    this.aimInTraverse = false;
    this.fireQuizGrant = null;
    this.deckFireGrants.clear();
    this.quizActionPending = false;
    this.walkMultiplier = 1;
    this.grapeshotUnlocked = false;
    this.cannonMode = "round";
    this.handCannonCharges = 0;
    if (this.handCannon) this.handCannon.visible = false;
    for (const cannon of this.cannons) cannon.reload = 0;
    this._resetVirtualMove();
    this.snapToDeck();
  }

  setQuestMode(active) {
    this.questMode = Boolean(active);
    this.activeCannon = null;
    this.aimInTraverse = false;
    this.fireQuizGrant = null;
    this.deckFireGrants.clear();
    this.airborne = false;
    this.verticalVelocity = 0;
    this._failedMoveTime = 0;
    if (this.questMode) {
      this.sailing?.setAnchored(true);
      this.handCannon.visible = false;
      this.enterCursorMode();
    } else if (this.handCannon) {
      this.handCannon.visible = this.handCannonCharges > 0;
    }
  }

  setWorldPose(position, worldYaw = 0, pitch = -0.08, eyeHeight = EYE_HEIGHT) {
    this.ship.group.updateMatrixWorld(true);
    this.rig.position.copy(this.ship.group.worldToLocal(position.clone()));
    this.yaw = worldYaw - this.ship.group.rotation.y;
    this.pitch = pitch;
    const parentWorld = this.ship.group.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), worldYaw);
    this.rig.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
    this.camera.position.y = eyeHeight;
    this.camera.rotation.set(this.pitch, 0, 0);
    this.airborne = false;
    this.verticalVelocity = 0;
    this._lastSafePosition.copy(this.rig.position);
    this._hasSafePosition = true;
  }

  setWorldPosition(position, eyeHeight = this.camera.position.y) {
    this.ship.group.updateMatrixWorld(true);
    this.rig.position.copy(this.ship.group.worldToLocal(position.clone()));
    const worldYaw = this.yaw + this.ship.group.rotation.y;
    const parentWorld = this.ship.group.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), worldYaw);
    this.rig.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
    this.camera.position.y = eyeHeight;
    this.camera.rotation.set(this.pitch, 0, 0);
    this.airborne = false;
    this.verticalVelocity = 0;
    this._lastSafePosition.copy(this.rig.position);
    this._hasSafePosition = true;
  }

  snapToDeck() {
    this._placeOnDeck();
    this._groundFollow(1 / 60);
    this._updateCameraHeight(1 / 60);
    this.camera.rotation.set(this.pitch, 0, 0);
    this.airborne = false;
    this.verticalVelocity = 0;
  }

  _publishCoopAction(action, payload = {}) {
    this.onCoopAction(action, {
      ...payload,
      localPosition: {
        x: this.rig.position.x,
        y: this.rig.position.y,
        z: this.rig.position.z,
      },
    });
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

  async _gateAction(action, context = {}) {
    if (!this.requestActionQuiz) return true;
    if (this.quizActionPending) {
      this.onMessage("Дождись ответа на текущее задание.");
      return false;
    }
    this.quizActionPending = true;
    this.enterCursorMode();
    try {
      return Boolean(await this.requestActionQuiz(action, context));
    } catch (error) {
      console.warn("Action quiz failed:", error);
      this.onMessage("Задание не открылось. Попробуй ещё раз.");
      return false;
    } finally {
      this.quizActionPending = false;
    }
  }

  _hasFireQuizGrant(kind, cannon = null) {
    if (kind === "deck-cannon") return Boolean(cannon && this.deckFireGrants.has(this._cannonGrantKey(cannon)));
    return Boolean(this.fireQuizGrant && this.fireQuizGrant.kind === kind);
  }

  _consumeFireQuizGrant(kind, cannon = null) {
    if (kind === "deck-cannon") {
      if (cannon) this.deckFireGrants.delete(this._cannonGrantKey(cannon));
      return;
    }
    if (this._hasFireQuizGrant(kind, cannon)) this.fireQuizGrant = null;
  }

  _cannonGrantKey(cannon) {
    return cannon?.id || cannon;
  }

  async _ensureFireQuizGrant(kind, context = {}) {
    const cannon = context.cannon || null;
    if (!this.requestActionQuiz || this._hasFireQuizGrant(kind, cannon)) return "ready";
    if (!(await this._gateAction("fire", { source: context.source || kind }))) return "blocked";
    if (kind === "deck-cannon") {
      if (cannon) this.deckFireGrants.add(this._cannonGrantKey(cannon));
      this.onMessage("Р’РµСЂРЅРѕ. РџСѓС€РєР° РіРѕС‚РѕРІР°: РЅР°РІРµРґРё Рё РЅР°Р¶РјРё РІС‹СЃС‚СЂРµР» РµС‰С‘ СЂР°Р·.");
      return "granted";
    }
    this.fireQuizGrant = {
      kind,
      cannon: null,
    };
    this.onMessage(
      kind === "deck-cannon"
        ? "Верно. Пушка готова: наведи и нажми выстрел ещё раз."
        : "Верно. Ручная пушка готова: нажми выстрел ещё раз."
    );
    return "granted";
  }

  async _fire() {
    const cannon = this._findNearbyCannon();
    if (!cannon) {
      if (this.handCannonCharges > 0) {
        const clearance = await this._ensureFireQuizGrant("hand-cannon", { source: "hand-cannon" });
        if (clearance !== "ready") return;
        this._consumeFireQuizGrant("hand-cannon");
        this._fireHandCannon();
        this.enterCameraMode();
        return;
      }
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
    const clearance = await this._ensureFireQuizGrant("deck-cannon", { source: "deck-cannon", cannon });
    if (clearance !== "ready") return;
    const freshAim = this._cannonAim(cannon);
    if (!freshAim?.inTraverse || cannon.reload > 0) {
      this.onMessage("Пушка уже не готова: наведи её заново и попробуй ещё раз.");
      return;
    }
    const { origin, dir } = freshAim;
    this._consumeFireQuizGrant("deck-cannon", cannon);
    if (this.grapeshotUnlocked && this.cannonMode === "grapeshot") {
      cannon.reload = RELOAD * 1.25;
      this._fireGrapeshot(origin, dir);
      this.onMessage("Картечь выпущена широким веером. Она сильна вблизи и может добить повреждённый корпус.");
    } else {
      cannon.reload = RELOAD;
      const vel = dir.clone().multiplyScalar(PLAYER_MUZZLE_SPEED);
      this.projectiles.spawn(origin, vel, { team: "player" });
      this.effects.muzzleFlash(origin, vel);
      this.onMessage("Выстрел из пушки. Смотри, куда падает ядро, и дождись перезарядки.");
    }
    this.enterCameraMode();
  }

  _fireGrapeshot(origin, dir) {
    const count = 13;
    const spread = THREE.MathUtils.degToRad(135);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const yaw = (t - 0.5) * spread + (Math.random() - 0.5) * 0.05;
      const pelletDir = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      pelletDir.y += (Math.random() - 0.5) * 0.055;
      pelletDir.normalize();
      this.projectiles.spawn(origin, pelletDir.multiplyScalar(GRAPESHOT_MUZZLE_SPEED), {
        team: "player",
        radius: 0.58,
        ttl: 4.8,
        kind: "grapeshot",
        damage: 50,
      });
    }
    this.effects.muzzleFlash(origin, dir);
  }

  _fireHandCannon() {
    this.camera.updateWorldMatrix(true, false);
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    origin.addScaledVector(dir, 2.2);
    const vel = dir.multiplyScalar(PLAYER_MUZZLE_SPEED * 0.92);
    this.projectiles.spawn(origin, vel, { team: "player", kind: "hand-cannon", damage: 100 });
    this.effects.muzzleFlash(origin, vel);
    this.handCannonCharges--;
    if (this.handCannon) this.handCannon.visible = this.handCannonCharges > 0;
    this.onMessage(`Ручная пушка: осталось выстрелов ${this.handCannonCharges}.`);
  }

  _interact() {
    if (this.damageControl?.canDumpBucket(this.rig)) {
      if (this.damageControl.dumpBucket(this.rig)) {
        this.verticalVelocity = 0;
        this.airborne = false;
        this._rememberSafePosition();
      }
      return;
    }
    if (this.damageControl?.canScoopWater(this.rig)) {
      if (this.damageControl.scoopWater(this.rig, this.camera)) {
        this._publishCoopAction("scoop-water");
        this.verticalVelocity = 0;
        this.airborne = false;
        this._rememberSafePosition();
      }
      return;
    }
    if (this.damageControl?.interact(this.rig, this.camera)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
      return;
    }
    if (this.islandQuest?.interact(this.rig)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
      return;
    }
    if (this.sailing?.interact(this.rig)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
  }

  async _secondaryInteract() {
    if (this.damageControl?.canPatchBreach(this.rig)) {
      if (!(await this._gateAction("patch", { source: "breach" }))) return;
      if (this.damageControl?.patchNearestBreach(this.rig)) {
        this._publishCoopAction("patch-breach");
        this.verticalVelocity = 0;
        this.airborne = false;
        this._rememberSafePosition();
      }
      return;
    }
    if (this.damageControl?.takePlank(this.rig, this.camera)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
  }

  _dumpBucket() {
    if (this.damageControl?.dumpBucket(this.rig)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
  }

  _takePlank() {
    if (this.damageControl?.takePlank(this.rig, this.camera)) {
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
  }

  _scoopWater() {
    if (this.damageControl?.scoopWater(this.rig, this.camera)) {
      this._publishCoopAction("scoop-water");
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
  }

  async _patchBreach() {
    if (!(await this._gateAction("patch", { source: "breach" }))) return;
    if (this.damageControl?.patchNearestBreach(this.rig)) {
      this._publishCoopAction("patch-breach");
      this.verticalVelocity = 0;
      this.airborne = false;
      this._rememberSafePosition();
    }
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
    for (const hit of hits) {
      this._hitPoint.copy(hit.point);
      this.ship.group.worldToLocal(this._hitPoint);
      if (pointInsideCollisionHole(this._hitPoint, this.ship.collisionHoles)) continue;
      return {
        y: this._hitPoint.y,
        onStairs: STAIR_NODE.test(hit.object.name || ""),
      };
    }
    return null;
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
      (hit) => hit.object.userData.forceSolid || !stairTransition || !STAIR_THRESHOLD_NODE.test(hit.object.name || "")
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

  _hasRecentJumpSupport(position) {
    if (!this._hasSafePosition) return false;
    const horizontal = Math.hypot(position.x - this._lastSafePosition.x, position.z - this._lastSafePosition.z);
    const vertical = Math.abs(position.y - this._lastSafePosition.y);
    return horizontal <= JUMP_FALLBACK_SUPPORT_DISTANCE && vertical <= JUMP_FALLBACK_SUPPORT_HEIGHT;
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
      const supportedByNearbySurface =
        this._inStairZone(this.rig.position, 0.85) || this._hasRecentJumpSupport(this.rig.position);
      if (ground && Math.abs(this.rig.position.y - ground.y) <= MAX_STAIR_STEP_DOWN) {
        this.rig.position.y = ground.y;
      } else if (!supportedByNearbySurface) {
        return;
      }
    }
    let jumpSpeed = JUMP_SPEED;
    const ceilingY = this.damageControl?.jumpCeilingY?.(this.rig.position);
    if (ceilingY !== null && ceilingY !== undefined) {
      const headroom = ceilingY - this.rig.position.y - EYE_HEIGHT - 0.25;
      if (headroom <= 0.35) return;
      jumpSpeed = Math.min(jumpSpeed, Math.sqrt(Math.max(0.1, 2 * JUMP_GRAVITY * headroom)));
    }
    this.airborne = true;
    this.verticalVelocity = jumpSpeed;
    this.rig.position.y += 0.04;
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
      const ceilingY = this.damageControl?.jumpCeilingY?.(this.rig.position);
      if (ceilingY !== null && ceilingY !== undefined) {
        const maxFeetY = ceilingY - EYE_HEIGHT - 0.25;
        if (this.rig.position.y > maxFeetY) {
          this.rig.position.y = maxFeetY;
          this.verticalVelocity = Math.min(0, this.verticalVelocity);
        }
      }

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
    if (this.questMode || this.islandQuest?.active) {
      this.enterCursorMode();
      this.activeCannon = null;
      this.aimInTraverse = false;
      this.prompt = this.islandQuest.getPrompt(this.rig);
      this.camera.rotation.set(this.pitch, 0, 0);
      this.aimLine.visible = false;
      this.marker.visible = false;
      return;
    }

    // movement on the deck plane (ship-local x/z)
    const keyboardForward = (this.keyboardKeys["KeyW"] ? 1 : 0) - (this.keyboardKeys["KeyS"] ? 1 : 0);
    const keyboardSide = (this.keyboardKeys["KeyD"] ? 1 : 0) - (this.keyboardKeys["KeyA"] ? 1 : 0);
    const f = THREE.MathUtils.clamp(keyboardForward + this.virtualMove.forward, -1, 1);
    const s = THREE.MathUtils.clamp(keyboardSide + this.virtualMove.side, -1, 1);
    if (!this.sailing?.controlling && (f || s)) {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(WALK_SPEED * this.walkMultiplier * dt);
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

    const interactionPrompt = this.damageControl?.getPrompt(this.rig) || this.islandQuest?.getPrompt(this.rig) || this.sailing?.getPrompt(this.rig) || "";
    if (interactionPrompt) {
      this.prompt = interactionPrompt;
    } else if (this.activeCannon) {
      const fireReady = !this.requestActionQuiz || this._hasFireQuizGrant("deck-cannon", this.activeCannon);
      this.prompt = this.aimInTraverse
        ? fireReady
          ? this.grapeshotUnlocked
            ? `ЛКМ или F - выстрелить. Режим: ${this.cannonMode === "grapeshot" ? "картечь" : "ядро"} · G - сменить`
            : "ЛКМ, F или кнопка - выстрелить из этой пушки"
          : this.grapeshotUnlocked
          ? `Нажми ЛКМ. Режим: ${this.cannonMode === "grapeshot" ? "картечь" : "ядро"} · G - сменить`
          : "F или кнопка - встать за пушку и получить задание"
        : "Повернись в сектор наведения этой пушки";
    } else {
      this.prompt = this.locked ? "" : "Кликни, чтобы захватить мышь";
    }
  }

  getState() {
    if (this.questMode || this.islandQuest?.active) {
      return {
        prompt: this.prompt,
        reload: 1,
        nearCannon: false,
        canFire: false,
        fireLabel: "",
        canDumpBucket: false,
        canTakePlank: false,
        canScoopWater: false,
        canPatchBreach: false,
        handCannonCharges: this.handCannonCharges,
        cannonMode: this.cannonMode,
        canJump: false,
      };
    }
    const reload = this.activeCannon?.reload || 0;
    const canUseHandCannon = !this.activeCannon && this.handCannonCharges > 0;
    const hasDeckFireGrant = Boolean(this.activeCannon && this._hasFireQuizGrant("deck-cannon", this.activeCannon));
    const hasHandFireGrant = Boolean(canUseHandCannon && this._hasFireQuizGrant("hand-cannon"));
    const fireReady = !this.requestActionQuiz || hasDeckFireGrant || hasHandFireGrant;
    const canFire = !this.quizActionPending && Boolean((this.activeCannon && this.aimInTraverse && reload <= 0) || canUseHandCannon);
    const actionPrompt = this.activeCannon && this.aimInTraverse
      ? fireReady
        ? `ЛКМ или F - выстрел${this.grapeshotUnlocked ? ` · режим: ${this.cannonMode === "grapeshot" ? "картечь" : "ядро"}` : ""}`
        : `F или кнопка - задание у пушки${this.grapeshotUnlocked ? ` · режим: ${this.cannonMode === "grapeshot" ? "картечь" : "ядро"}` : ""}`
      : canUseHandCannon
      ? fireReady
        ? `F или ЛКМ - выстрел из ручной пушки (${this.handCannonCharges})`
        : `F или кнопка - задание для ручной пушки (${this.handCannonCharges})`
      : this.prompt;
    const fireLabel = canUseHandCannon
      ? fireReady
        ? `Выстрелить [F] (${this.handCannonCharges})`
        : `Задание: ручная пушка [F] (${this.handCannonCharges})`
      : reload > 0
      ? "Перезарядка..."
      : this.aimInTraverse
        ? fireReady
          ? "Выстрелить [F/ЛКМ]"
          : "Встать за пушку [F]"
        : "Вне сектора";
    return {
      prompt: actionPrompt,
      reload: 1 - Math.max(0, reload) / RELOAD,
      nearCannon: Boolean(this.activeCannon || canUseHandCannon),
      canFire,
      fireReady,
      fireLabel,
      canDumpBucket: Boolean(this.damageControl?.canDumpBucket(this.rig)),
      canTakePlank: Boolean(this.damageControl?.canTakePlank(this.rig)),
      canScoopWater: Boolean(this.damageControl?.canScoopWater(this.rig)),
      canPatchBreach: Boolean(this.damageControl?.canPatchBreach(this.rig)),
      handCannonCharges: this.handCannonCharges,
      cannonMode: this.cannonMode,
      canJump: !this.airborne,
    };
  }
}
