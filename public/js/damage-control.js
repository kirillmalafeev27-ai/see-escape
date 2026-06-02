// damage-control.js - hold navigation, breaches, flooding, repairs and bucket work.
import * as THREE from "three";

const INTERACT_RANGE = 6.5;
const BOARD_COUNT = 14;
const BUCKET_AMOUNT = 13;
const FLOOD_PER_HOLE = 1.05;
const DOOR_RESPONSE = 4.5;

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

    this._buildHold();
    this._findExteriorDoor();
    this._buildDoorVisuals();
    this._scatterPlanks();
  }

  _addWalkable(mesh) {
    this.holdRoot.add(mesh);
    this.ship.walkableMeshes.push(mesh);
  }

  _addSolid(mesh) {
    this.holdRoot.add(mesh);
    this.ship.solidMeshes.push(mesh);
  }

  _buildHold() {
    const d = this.dims;
    this.floorY = d.keelY + 3.4;
    this.holdHeight = Math.max(5.8, Math.min(8.2, d.deckY - this.floorY - 1.2));
    this.holdWidth = d.beam * 0.64;
    this.holdDepth = d.length * 0.54;
    this.holdCenterZ = -d.length * 0.02;
    this.minX = -this.holdWidth / 2;
    this.maxX = this.holdWidth / 2;
    this.minZ = this.holdCenterZ - this.holdDepth / 2;
    this.maxZ = this.holdCenterZ + this.holdDepth / 2;

    const wood = mat(0x56321f, 0.93);
    const darkWood = mat(0x382013, 0.96);
    const floor = boxMesh(this.holdWidth, 0.28, this.holdDepth, wood, "HoldFloorVisual");
    floor.position.set(0, this.floorY - 0.14, this.holdCenterZ);
    this.holdRoot.add(floor);

    const walkable = boxMesh(this.holdWidth - 0.4, 0.12, this.holdDepth - 0.4, invisibleMaterial(), "HoldFloor");
    walkable.position.set(0, this.floorY - 0.06, this.holdCenterZ);
    this._addWalkable(walkable);

    const wallY = this.floorY + this.holdHeight / 2;
    for (const x of [this.minX, this.maxX]) {
      const wall = boxMesh(0.34, this.holdHeight, this.holdDepth, darkWood, "HoldSideWall");
      wall.position.set(x, wallY, this.holdCenterZ);
      this._addSolid(wall);
    }
    for (const z of [this.minZ, this.maxZ]) {
      const wall = boxMesh(this.holdWidth, this.holdHeight, 0.34, darkWood, "HoldEndWall");
      wall.position.set(0, wallY, z);
      this._addSolid(wall);
    }

    const ceiling = boxMesh(this.holdWidth, 0.22, this.holdDepth, darkWood, "HoldCeiling");
    ceiling.position.set(0, this.floorY + this.holdHeight + 0.11, this.holdCenterZ);
    this.holdRoot.add(ceiling);

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

    this.holdSpawn = new THREE.Vector3(0, this.floorY + 0.12, this.maxZ - 3.2);
    this.interiorDoorPosition = new THREE.Vector3(0, this.floorY, this.maxZ - 0.7);
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
      const size = chosen.bounds.getSize(new THREE.Vector3());
      const center = chosen.center;
      const towardCenter = center.z >= 0 ? -1 : 1;
      this.exteriorDoorPosition = new THREE.Vector3(center.x, chosen.bounds.min.y + 0.12, center.z + towardCenter * 2.4);
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
    const dark = mat(0x120b08, 1);
    this.exteriorPortal = boxMesh(
      this.exteriorDoorSize.x,
      this.exteriorDoorSize.y,
      0.12,
      dark,
      "OpenHoldExteriorPortal"
    );
    this.exteriorPortal.position.copy(this.exteriorDoorCenter);
    this.exteriorPortal.visible = false;
    this.ship.group.add(this.exteriorPortal);

    const doorWood = mat(0x69412b, 0.9);
    this.interiorPortal = boxMesh(6.8, 6.3, 0.12, dark, "OpenHoldInteriorPortal");
    this.interiorPortal.position.set(0, this.floorY + 3.15, this.maxZ - 0.5);
    this.holdRoot.add(this.interiorPortal);

    this.interiorDoorPivots = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 3.25, this.floorY + 3.15, this.maxZ - 0.62);
      const panel = boxMesh(3.25, 6.3, 0.24, doorWood, "HoldInteriorDoor");
      panel.position.x = -side * 1.62;
      pivot.add(panel);
      this.holdRoot.add(pivot);
      this.interiorDoorPivots.push({ pivot, side });
    }
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
    if (side.axis === "x") root.rotation.y = Math.PI / 2;
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
    if (this.breaches.filter((breach) => breach.active).length >= 10) return;
    const local = this.ship.group.worldToLocal(hit.point.clone());
    const side = Math.abs(local.x / this.dims.beam) >= Math.abs(local.z / this.dims.length)
      ? { axis: "x", sign: Math.sign(local.x) || 1 }
      : { axis: "z", sign: Math.sign(local.z) || 1 };
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

  _nearInteriorDoor(position) {
    return position.distanceTo(this.interiorDoorPosition) <= INTERACT_RANGE;
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
      if (this._nearInteriorDoor(position)) {
        return this.doorProgress >= 0.96 ? "E - выйти на палубу" : "E - открыть двери трюма";
      }
      return "";
    }
    if (this._nearExteriorDoor(position)) {
      return this.doorProgress >= 0.96 ? "E - войти в трюм" : "E - открыть двери в трюм";
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
        if (breach.side.axis === "x") patch.rotation.y = Math.PI / 2;
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

      if (this._nearInteriorDoor(position)) {
        if (this.doorProgress < 0.96) {
          this.doorOpening = true;
          this.onMessage("Двери трюма открываются.");
        } else {
          rig.position.copy(this.exteriorDoorPosition);
          this.onMessage("Ты вышел на палубу.");
        }
        return true;
      }
    } else if (this._nearExteriorDoor(position)) {
      if (this.doorProgress < 0.96) {
        this.doorOpening = true;
        this.onMessage("Двери в трюм открываются.");
      } else {
        rig.position.copy(this.holdSpawn);
        this.onMessage("Ты вошёл в трюм.");
      }
      return true;
    }
    return false;
  }

  update(dt) {
    if (this.doorOpening && this.doorProgress < 1) {
      this.doorProgress = Math.min(1, this.doorProgress + dt * DOOR_RESPONSE);
    }
    const doorAngle = this.doorProgress * Math.PI * 0.48;
    for (const { pivot, side } of this.interiorDoorPivots) pivot.rotation.y = side * doorAngle;
    this.exteriorPortal.visible = this.doorProgress > 0.4;
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
