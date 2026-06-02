// damage-control.js - hold navigation, breaches, flooding, repairs and bucket work.
import * as THREE from "three";

const INTERACT_RANGE = 6.5;
const BOARD_COUNT = 14;
const BUCKET_AMOUNT = 13;
const FLOOD_PER_HOLE = 0.3;
const BREACH_COOLDOWN = 2.6;
const MAX_ACTIVE_BREACHES = 6;
const DOOR_RESPONSE = 4.5;
const HOLD_SURFACE_LIFT = 0.14;
const HOLD_SURFACE_THICKNESS = 0.12;

function mat(color, roughness = 0.85, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

function invisibleMaterial() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
}

function boxMesh(width, height, depth, material, name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.name = name;
  return mesh;
}

function distanceXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function localBounds(group, object) {
  group.updateMatrixWorld(true);
  object.updateWorldMatrix(true, true);
  const worldBox = new THREE.Box3().setFromObject(object);
  const localBox = new THREE.Box3();
  for (const x of [worldBox.min.x, worldBox.max.x]) {
    for (const y of [worldBox.min.y, worldBox.max.y]) {
      for (const z of [worldBox.min.z, worldBox.max.z]) {
        localBox.expandByPoint(group.worldToLocal(new THREE.Vector3(x, y, z)));
      }
    }
  }
  return localBox;
}

export class DamageControlSystem {
  constructor({ scene, ship, effects, onMessage }) {
    this.scene = scene;
    this.ship = ship;
    this.effects = effects;
    this.onMessage = onMessage || (() => {});
    this.dims = ship.dims;
    this.breaches = [];
    this.breachCooldown = 0;
    this.planks = [];
    this.waterLevel = 0;
    this.doorProgress = 0;
    this.doorOpening = false;
    this.bucketFull = false;
    this.heldPlank = null;
    this.heldBucket = null;
    this.pour = null;

    this.holdRoot = new THREE.Group();
    this.holdRoot.name = "DamageControlHold";
    this.ship.group.add(this.holdRoot);

    this._findHoldAccess();
    this._buildHold();
    this._findExteriorDoor();
    this._buildHoldAccessNavigation();
    this._buildDoorVisuals();
    this._scatterPlanks();
  }

  _addWalkable(mesh) {
    this.holdRoot.add(mesh);
    this.ship.walkableMeshes.push(mesh);
  }

  // Register a flat walkable rectangle with the analytic navigation model the
  // player controller walks on (ship-local space, top surface at `y`).
  _addNavFlat({ width, depth, x = 0, z, y, onStairs = false, name }) {
    this.ship.navigationSurfaces?.push({
      kind: "flat",
      name,
      minX: x - width / 2,
      maxX: x + width / 2,
      minZ: z - depth / 2,
      maxZ: z + depth / 2,
      y,
      onStairs,
    });
  }

  _findHoldAccess() {
    const ramp = this.ship.walkableMeshes.find((mesh) => /StairsBot.*_StairsRamp$/i.test(mesh.name || ""));
    const low = ramp?.userData.lowLanding;
    const high = ramp?.userData.highLanding;
    this.holdAccess = {
      low: low ? new THREE.Vector3(...low) : new THREE.Vector3(0, this.dims.keelY + 5.2, -this.dims.length * 0.3),
      high: high ? new THREE.Vector3(...high) : new THREE.Vector3(0, this.dims.deckY, -this.dims.length * 0.2),
    };
  }

  _buildHold() {
    const d = this.dims;
    const descend = this.holdAccess.low.clone().sub(this.holdAccess.high).setY(0).normalize();
    this.floorY = this.holdAccess.low.y;
    this.holdHeight = Math.max(5.8, Math.min(8.2, d.deckY - this.floorY - 1.2));
    this.holdWidth = d.beam * 0.64;
    this.holdDepth = d.length * 0.2;
    this.holdCenterZ = this.holdAccess.low.z + descend.z * this.holdDepth * 0.48;
    this.minX = -this.holdWidth / 2;
    this.maxX = this.holdWidth / 2;
    this.minZ = this.holdCenterZ - this.holdDepth / 2;
    this.maxZ = this.holdCenterZ + this.holdDepth / 2;

    const walkable = boxMesh(
      this.holdWidth - 0.4,
      HOLD_SURFACE_THICKNESS,
      this.holdDepth - 0.4,
      invisibleMaterial(),
      "HoldFloor"
    );
    walkable.position.set(
      0,
      this.floorY + HOLD_SURFACE_LIFT - HOLD_SURFACE_THICKNESS / 2,
      this.holdCenterZ
    );
    this._addWalkable(walkable);
    this._addNavFlat({
      width: this.holdWidth - 0.4,
      depth: this.holdDepth - 0.4,
      x: 0,
      z: this.holdCenterZ,
      y: this.floorY + HOLD_SURFACE_LIFT,
      name: "HoldFloor",
    });

    this.water = boxMesh(
      this.holdWidth - 0.7,
      0.12,
      this.holdDepth - 0.7,
      mat(0x3c9fd1, 0.3, 0, { transparent: true, opacity: 0.62 }),
      "HoldWater"
    );
    this.water.position.set(0, this.floorY + 0.06, this.holdCenterZ);
    this.water.visible = false;
    this.holdRoot.add(this.water);

  }

  _addWalkableSurface({ width, depth, x = 0, y, z, name, stairTransition = false }) {
    const surface = boxMesh(width, HOLD_SURFACE_THICKNESS, depth, invisibleMaterial(), name);
    surface.position.set(x, y - HOLD_SURFACE_THICKNESS / 2, z);
    this._addWalkable(surface);
    this._addNavFlat({ width, depth, x, z, y, onStairs: stairTransition, name });
    if (stairTransition) {
      this.ship.stairZones.push(
        new THREE.Box3(
          new THREE.Vector3(x - width / 2, y - 1.4, z - depth / 2),
          new THREE.Vector3(x + width / 2, y + 3.8, z + depth / 2)
        )
      );
    }
    return surface;
  }

  _buildHoldAccessNavigation() {
    const high = this.holdAccess.high;
    const low = this.holdAccess.low;
    const doorwayWidth = Math.min(this.holdWidth - 0.6, Math.max(6.2, this.exteriorDoorSize.x + 1.4));
    const outerThresholdZ = this.exteriorDoorCenter.z - this.exteriorDoorNormal.z * 1.35;
    const innerThresholdZ = high.z + this.exteriorDoorNormal.z * 0.9;

    // Bridge the door sill and the obstructing decorative mesh behind it. The
    // platform stays thin and invisible, like the grate overlays around masts.
    this._addWalkableSurface({
      width: doorwayWidth,
      depth: Math.abs(innerThresholdZ - outerThresholdZ),
      x: this.exteriorDoorCenter.x,
      y: high.y,
      z: (outerThresholdZ + innerThresholdZ) / 2,
      name: "HoldDoorwayStairsThreshold",
      stairTransition: true,
    });

    // Keep both ends of the native lower stair ramp connected to their floors.
    // These pads are invisible and intentionally small so the real hatch stays open.
    this._addWalkableSurface({
      width: Math.min(5.2, this.holdWidth - 0.8),
      depth: 2.4,
      x: high.x,
      y: high.y,
      z: high.z,
      name: "HoldUpperStairsLanding",
      stairTransition: true,
    });
    this._addWalkableSurface({
      width: Math.min(5.2, this.holdWidth - 0.8),
      depth: 2.4,
      x: low.x,
      y: low.y,
      z: low.z,
      name: "HoldLowerStairsLanding",
      stairTransition: true,
    });
  }

  _findExteriorDoor() {
    const candidates = [];
    this.modelDoorNodes = [];
    this.ship.modelPivot?.traverse((object) => {
      if (!/^StylShip_Door\d+$/i.test(object.name || "")) return;
      const bounds = localBounds(this.ship.group, object);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      candidates.push({ object, bounds, center });
      this.modelDoorNodes.push(object);
    });
    candidates.sort((a, b) => Math.abs(a.center.y - this.dims.deckY) - Math.abs(b.center.y - this.dims.deckY));
    const chosen = candidates[0];
    if (chosen) {
      const bounds = new THREE.Box3();
      for (const candidate of candidates) bounds.union(candidate.bounds);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const towardCenter = center.z >= 0 ? -1 : 1;
      this.exteriorDoorPosition = new THREE.Vector3(center.x, bounds.min.y + 0.12, center.z + towardCenter * 2.4);
      this.exteriorDoorCenter = center;
      this.exteriorDoorSize = new THREE.Vector3(
        Math.max(4.2, size.x),
        Math.max(5.5, size.y),
        Math.max(0.18, size.z)
      );
      this.exteriorDoorNormal = new THREE.Vector3(0, 0, towardCenter);
      return;
    }
    this.exteriorDoorPosition = new THREE.Vector3(0, this.dims.deckY + 0.12, this.dims.length * 0.24);
    this.exteriorDoorCenter = this.exteriorDoorPosition.clone().add(new THREE.Vector3(0, 3.1, 0));
    this.exteriorDoorSize = new THREE.Vector3(6.4, 6.2, 0.18);
    this.exteriorDoorNormal = new THREE.Vector3(0, 0, -1);
  }

  _buildDoorVisuals() {
    // The GLB already contains the visible cabin doors. Once they open, the
    // physical stairway behind them is enough; extra black portal planes only
    // cover the passage and make the floor look broken.
    this.interiorDoorPivots = [];
  }

  _scatterPlanks() {
    const wood = mat(0x8a5a35, 0.92);
    for (let i = 0; i < BOARD_COUNT; i++) {
      const mesh = boxMesh(3.4 + (i % 3) * 0.5, 0.22, 0.62, wood, "RepairPlank");
      mesh.position.set(
        this.minX + 2.2 + (i % 4) * 1.25,
        this.floorY + 0.22 + Math.floor(i / 4) * 0.08,
        this.minZ + 4 + Math.floor(i / 4) * 3.8
      );
      mesh.rotation.y = (i % 2 ? 0.18 : -0.14);
      this.holdRoot.add(mesh);
      this.planks.push({ mesh, available: true });
    }
  }

  _setHeldPlank(camera, plank) {
    plank.available = false;
    plank.mesh.visible = false;
    const held = boxMesh(3.9, 0.28, 0.66, mat(0x8a5a35, 0.92), "HeldRepairPlank");
    held.position.set(0.8, -1.0, -2.5);
    held.rotation.set(0.15, -0.25, 0.04);
    camera.add(held);
    this.heldPlank = held;
  }

  _setBucket(camera, full) {
    this.heldBucket?.removeFromParent();
    const bucket = new THREE.Group();
    bucket.name = "HeldBucket";
    const wood = mat(0x77482b, 0.88);
    const water = mat(0x4aa9d9, 0.25, 0, { transparent: true, opacity: 0.75 });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.58, 1.15, 12, 1, true), wood);
    bucket.add(shell);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(0.62, 16), water);
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.5;
    fill.visible = full;
    bucket.add(fill);
    bucket.position.set(1.05, -1.05, -2.3);
    bucket.rotation.z = -0.12;
    camera.add(bucket);
    this.heldBucket = bucket;
    this.bucketFull = full;
  }

  _makeBreachVisual(side, position, exterior = false) {
    const root = new THREE.Group();
    root.position.copy(position);
    if (side.axis === "x") root.rotation.y = side.sign * Math.PI / 2;
    if (side.axis === "z" && side.sign < 0) root.rotation.y = Math.PI;
    const hole = new THREE.Mesh(
      new THREE.CircleGeometry(exterior ? 1.55 : 1.35, 13),
      new THREE.MeshBasicMaterial({ color: 0x070809, side: THREE.DoubleSide })
    );
    hole.name = "HullBreachOpening";
    root.add(hole);
    const splinterMat = mat(0x8a5835, 0.96);
    for (let i = 0; i < 9; i++) {
      const plank = boxMesh(1.4 + Math.random() * 1.5, 0.18, 0.35, splinterMat, "TornHullPlank");
      const a = (i / 9) * Math.PI * 2;
      plank.position.set(Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0.08);
      plank.rotation.z = a + (Math.random() - 0.5) * 0.6;
      root.add(plank);
    }
    this.holdRoot.add(root);
    return root;
  }

  addBreach(hit) {
    if (this.breachCooldown > 0) return false;
    if (this.breaches.filter((breach) => breach.active).length >= MAX_ACTIVE_BREACHES) return false;
    const local = this.ship.group.worldToLocal(hit.point.clone());
    // Interior leaks belong on the port or starboard hull planking. Mapping
    // bow and stern box hits onto end planes creates floating perpendicular holes.
    const side = { axis: "x", sign: Math.sign(local.x) || 1 };
    const inner = new THREE.Vector3();
    if (side.axis === "x") {
      inner.set(
        side.sign * (this.holdWidth / 2 - 0.2),
        this.floorY + 2.2 + Math.random() * 2.6,
        THREE.MathUtils.clamp(local.z, this.minZ + 3, this.maxZ - 3)
      );
    } else {
      inner.set(
        THREE.MathUtils.clamp(local.x, this.minX + 3, this.maxX - 3),
        this.floorY + 2.2 + Math.random() * 2.6,
        side.sign * (this.holdDepth / 2 - 0.2) + this.holdCenterZ
      );
    }
    const inward = side.axis === "x"
      ? new THREE.Vector3(-side.sign, -0.35, 0)
      : new THREE.Vector3(0, -0.35, -side.sign);
    inward.normalize();
    const innerVisual = this._makeBreachVisual(side, inner, false);

    const outer = inner.clone();
    if (side.axis === "x") outer.x = side.sign * this.dims.beam * 0.52;
    else outer.z = side.sign * this.dims.length * 0.48;
    const outerVisual = this._makeBreachVisual(side, outer, true);
    this.breaches.push({ active: true, side, inner, inward, innerVisual, outerVisual });
    this.breachCooldown = BREACH_COOLDOWN;
    return true;
  }

  _nearestActiveBreach(position) {
    let best = null;
    let bestDistance = INTERACT_RANGE;
    for (const breach of this.breaches) {
      if (!breach.active) continue;
      const distance = position.distanceTo(breach.inner);
      if (distance < bestDistance) {
        best = breach;
        bestDistance = distance;
      }
    }
    return best;
  }

  _nearestPlank(position) {
    let best = null;
    let bestDistance = INTERACT_RANGE;
    for (const plank of this.planks) {
      if (!plank.available) continue;
      const distance = position.distanceTo(plank.mesh.position);
      if (distance < bestDistance) {
        best = plank;
        bestDistance = distance;
      }
    }
    return best;
  }

  _insideHold(position) {
    return (
      position.y <= this.floorY + this.holdHeight + 1 &&
      position.x >= this.minX - 1 &&
      position.x <= this.maxX + 1 &&
      position.z >= this.minZ - 1 &&
      position.z <= this.maxZ + 1
    );
  }

  _nearExteriorDoor(position) {
    return position.distanceTo(this.exteriorDoorPosition) <= INTERACT_RANGE + 1;
  }

  _canDumpBucket(position) {
    return (
      this.bucketFull &&
      position.y >= this.dims.deckY - 2.2 &&
      Math.abs(position.x) >= this.dims.beam * 0.28
    );
  }

  getPrompt(rig) {
    const position = rig.position;
    if (this._canDumpBucket(position)) return "E - вылить ведро за борт";
    if (this._insideHold(position)) {
      const breach = this._nearestActiveBreach(position);
      if (breach && this.heldPlank) return "E - заколотить пробоину доской";
      const plank = this._nearestPlank(position);
      if (plank && !this.heldPlank) return "E - взять доску для ремонта";
      if (this.waterLevel >= 1 && !this.bucketFull) return "E - зачерпнуть воду ведром";
      return "";
    }
    if (this._nearExteriorDoor(position)) {
      return this.doorProgress >= 0.96 ? "Проход открыт - спускайся в трюм по лестнице" : "E - открыть двери в трюм";
    }
    return "";
  }

  interact(rig, camera) {
    const position = rig.position;
    if (this._canDumpBucket(position)) {
      const origin = new THREE.Vector3();
      this.heldBucket?.getWorldPosition(origin);
      const side = Math.sign(position.x) || 1;
      const direction = new THREE.Vector3(side, -0.9, 0).transformDirection(this.ship.group.matrixWorld).normalize();
      this.heldBucket?.removeFromParent();
      this.heldBucket = null;
      this.bucketFull = false;
      this.pour = { origin, direction, ttl: 1.1 };
      this.onMessage("Вода вылита за борт.");
      return true;
    }

    if (this._insideHold(position)) {
      const breach = this._nearestActiveBreach(position);
      if (breach && this.heldPlank) {
        breach.active = false;
        breach.innerVisual.visible = false;
        breach.outerVisual.visible = false;
        this.heldPlank.removeFromParent();
        this.heldPlank = null;
        const patch = new THREE.Group();
        patch.position.copy(breach.inner);
        if (breach.side.axis === "x") patch.rotation.y = breach.side.sign * Math.PI / 2;
        const wood = mat(0xa16d42, 0.9);
        for (const y of [-0.72, 0, 0.72]) {
          const board = boxMesh(3.8, 0.45, 0.28, wood, "HullPatchBoard");
          board.position.y = y;
          patch.add(board);
        }
        this.holdRoot.add(patch);
        this.onMessage("Пробоина заколочена.");
        return true;
      }

      const plank = this._nearestPlank(position);
      if (plank && !this.heldPlank) {
        this._setHeldPlank(camera, plank);
        this.onMessage("Доска взята. Подойди к пробоине и нажми E.");
        return true;
      }

      if (this.waterLevel >= 1 && !this.bucketFull) {
        this.waterLevel = Math.max(0, this.waterLevel - BUCKET_AMOUNT);
        this._setBucket(camera, true);
        this.onMessage("Ведро наполнено. Вынеси его на палубу и вылей за борт.");
        return true;
      }

    } else if (this._nearExteriorDoor(position)) {
      if (this.doorProgress < 0.96) {
        this.doorOpening = true;
        this.onMessage("Двери в трюм открываются. Теперь спускайся ногами по лестнице.");
      }
      return true;
    }
    return false;
  }

  update(dt) {
    this.breachCooldown = Math.max(0, this.breachCooldown - dt);
    if (this.doorOpening && this.doorProgress < 1) {
      this.doorProgress = Math.min(1, this.doorProgress + dt * DOOR_RESPONSE);
    }
    const doorAngle = this.doorProgress * Math.PI * 0.48;
    for (const { pivot, side } of this.interiorDoorPivots) pivot.rotation.y = side * doorAngle;
    for (const node of this.modelDoorNodes) node.visible = this.doorProgress < 0.55;

    const active = this.breaches.filter((breach) => breach.active);
    this.waterLevel = Math.min(100, this.waterLevel + active.length * (1 + active.length * 0.16) * FLOOD_PER_HOLE * dt);
    this.water.visible = this.waterLevel > 0.1;
    this.water.position.y = this.floorY + 0.06 + (this.waterLevel / 100) * (this.holdHeight - 0.45);

    for (const breach of active) {
      const source = this.ship.group.localToWorld(breach.inner.clone());
      const direction = breach.inward.clone().transformDirection(this.ship.group.matrixWorld);
      this.effects.waterFlow(source, direction, 0.72);
    }
    if (this.pour) {
      this.effects.waterFlow(this.pour.origin, this.pour.direction, 1.25);
      this.pour.origin.addScaledVector(this.pour.direction, dt * 1.5);
      this.pour.ttl -= dt;
      if (this.pour.ttl <= 0) this.pour = null;
    }
  }

  getState() {
    return {
      waterLevel: this.waterLevel,
      activeBreaches: this.breaches.filter((breach) => breach.active).length,
      carryingPlank: Boolean(this.heldPlank),
      bucketFull: this.bucketFull,
    };
  }
}
