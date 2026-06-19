// damage-control.js - hold navigation, breaches, flooding, repairs and bucket work.
import * as THREE from "three";
import { DEFAULT_HOLD_COLLISION } from "./collision-profile.js?v=20260609-remove-hold-helpers-v1";

const INTERACT_RANGE = 6.5;
const BOARD_PILE_COUNT = 7;
const BOARDS_PER_PILE = 5;
const BOARD_COUNT = BOARD_PILE_COUNT * BOARDS_PER_PILE;
const BOARD_PILE_Y_OFFSET = -0.06;
const BUCKET_AMOUNT = 15;
const FLOOD_PER_HOLE = 0.3;
const FLOOD_CAP = 100;
const BREACH_COOLDOWN = 2.6;
const MAX_ACTIVE_BREACHES = 6;
const DOOR_RESPONSE = 4.5;
const HOLD_SURFACE_THICKNESS = 0.12;
const BREACH_END_MARGIN = 8.0;
const BREACH_LONGITUDINAL_COMPRESSION = 0.58;
const BREACH_WALL_INSET = 0.18;
const DOOR_SIDE_WALL_THICKNESS = 0.5;
const DOOR_SIDE_WALL_HEIGHT = 5.6;
const HOLD_JUMP_CEILING_ABOVE_FLOOR = 5.75;
const FLOOD_SURFACE_MARGIN = 0.48;
const FLOOD_SURFACE_PLAYABLE_HEIGHT = 3.05;
const FLOOD_WATER_SIDE_OVERHANG = 2.4;
const FLOOD_WATER_END_OVERHANG = 4.8;
const INTERIOR_OCCLUDER_NODE = /(?:sail|flag|rope|wire|rigging|bracing)/i;

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

function smooth01(t) {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function smoothRange(value, start, end) {
  return smooth01((value - start) / Math.max(0.001, end - start));
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
  constructor({ scene, ship, effects, waterMaterial = null, onMessage }) {
    this.scene = scene;
    this.ship = ship;
    this.effects = effects;
    this.waterMaterial = waterMaterial;
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
    this.floodMultiplier = 1;
    this.bailAssistRate = 0;
    this.repairAssistInterval = 0;
    this.repairAssistTimer = 0;
    this.interiorOccluders = [];
    this.interiorOccludersHidden = false;

    this.holdRoot = new THREE.Group();
    this.holdRoot.name = "DamageControlHold";
    this.ship.group.add(this.holdRoot);

    this._findHoldAccess();
    this._buildHold();
    this._findExteriorDoor();
    this._buildHoldAccessNavigation();
    this._buildDoorVisuals();
    this._scatterPlanks();
    this._collectInteriorOccluders();
  }

  _addWalkable(mesh) {
    this.holdRoot.add(mesh);
    this.ship.walkableMeshes.push(mesh);
  }

  _addSolid(mesh) {
    this.holdRoot.add(mesh);
    this.ship.solidMeshes.push(mesh);
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
    this.holdCenterX = DEFAULT_HOLD_COLLISION.x;
    this.floorY = DEFAULT_HOLD_COLLISION.y;
    this.holdHeight = Math.max(5.8, Math.min(8.2, d.deckY - this.floorY - 1.2));
    this.holdWidth = DEFAULT_HOLD_COLLISION.width;
    this.holdDepth = DEFAULT_HOLD_COLLISION.depth;
    this.holdCenterZ = DEFAULT_HOLD_COLLISION.z;
    this.minX = this.holdCenterX - this.holdWidth / 2;
    this.maxX = this.holdCenterX + this.holdWidth / 2;
    this.minZ = this.holdCenterZ - this.holdDepth / 2;
    this.maxZ = this.holdCenterZ + this.holdDepth / 2;
    this.floodMinY = this.floorY + 0.08;
    this.floodMaxY = Math.max(
      this.floodMinY + 0.4,
      Math.min(
        this.floorY + FLOOD_SURFACE_PLAYABLE_HEIGHT,
        this.floorY + this.holdHeight - FLOOD_SURFACE_MARGIN,
        d.deckY - 1.4
      )
    );

    const walkable = boxMesh(
      this.holdWidth - 0.4,
      HOLD_SURFACE_THICKNESS,
      this.holdDepth - 0.4,
      invisibleMaterial(),
      "HoldFloor"
    );
    walkable.position.set(
      this.holdCenterX,
      this.floorY - HOLD_SURFACE_THICKNESS / 2,
      this.holdCenterZ
    );
    this._addWalkable(walkable);

    const floodWater = new THREE.Mesh(
      new THREE.PlaneGeometry(
        Math.max(1, this.holdWidth + FLOOD_WATER_SIDE_OVERHANG),
        Math.max(1, this.holdDepth + FLOOD_WATER_END_OVERHANG),
        24,
        80
      ),
      this._createFloodWaterMaterial()
    );
    floodWater.name = "CalmInternalFloodWater";
    floodWater.rotation.x = -Math.PI / 2;
    floodWater.position.set(this.holdCenterX, this.floodMinY, this.holdCenterZ);
    floodWater.visible = false;
    this.holdRoot.add(floodWater);
    this.water = floodWater;

  }

  _createFloodWaterMaterial() {
    const oceanNormal =
      this.waterMaterial?.uniforms?.normalSampler?.value ||
      this.waterMaterial?.uniforms?.waterNormals?.value ||
      null;
    const normalMap =
      oceanNormal?.clone?.() ||
      new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
    if (normalMap) {
      normalMap.wrapS = THREE.RepeatWrapping;
      normalMap.wrapT = THREE.RepeatWrapping;
      normalMap.needsUpdate = true;
    }
    this.holdWaterNormalMap = normalMap;

    const oceanColor = this.waterMaterial?.uniforms?.waterColor?.value;
    const deepColor = oceanColor?.isColor
      ? oceanColor.clone().lerp(new THREE.Color(0x237694), 0.48)
      : new THREE.Color(0x237694);
    const foamColor = new THREE.Color(0xa9e6f6);

    return new THREE.ShaderMaterial({
      uniforms: {
        uNormalMap: { value: normalMap },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uDeepColor: { value: deepColor },
        uFoamColor: { value: foamColor },
        uRepeat: { value: new THREE.Vector2(2.2, 7.4) },
      },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;

        void main() {
          vUv = uv;
          float waveA = sin((uv.y * 13.0) + uTime * 1.7);
          float waveB = sin((uv.x * 21.0) - uTime * 1.15);
          vWave = waveA * 0.5 + waveB * 0.5;
          vec3 pos = position;
          pos.z += vWave * 0.035;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uNormalMap;
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uDeepColor;
        uniform vec3 uFoamColor;
        uniform vec2 uRepeat;
        varying vec2 vUv;
        varying float vWave;

        void main() {
          vec2 uvA = vUv * uRepeat + vec2(uTime * 0.018, uTime * 0.033);
          vec2 uvB = vUv * (uRepeat * 0.58) + vec2(-uTime * 0.013, uTime * 0.021);
          vec3 nA = texture2D(uNormalMap, uvA).rgb;
          vec3 nB = texture2D(uNormalMap, uvB).rgb;
          float ripple = smoothstep(0.35, 0.88, (nA.g + nB.b) * 0.5);
          float streak = smoothstep(0.08, 0.55, abs(nA.r - nB.g));
          float crest = smoothstep(0.42, 0.95, ripple * 0.75 + streak * 0.35 + vWave * 0.18);
          vec3 water = mix(uDeepColor, uFoamColor, crest);
          water += vec3(streak * 0.08);
          gl_FragColor = vec4(water, uOpacity);
        }
      `,
    });
  }

  _collectInteriorOccluders() {
    this.ship.modelPivot?.traverse((object) => {
      if (!object.isMesh) return;
      let node = object;
      let namePath = "";
      while (node && node !== this.ship.group) {
        namePath += ` ${node.name || ""}`;
        node = node.parent;
      }
      if (!INTERIOR_OCCLUDER_NODE.test(namePath)) return;
      this.interiorOccluders.push({ object, visible: object.visible });
    });
  }

  updateInteriorVisibility(position) {
    if (!this.interiorOccluders.length || !position) return;
    const shouldHide = this._insideHold(position);
    if (shouldHide === this.interiorOccludersHidden) return;
    this.interiorOccludersHidden = shouldHide;
    for (const entry of this.interiorOccluders) {
      entry.object.visible = shouldHide ? false : entry.visible;
    }
  }

  isInsideHold(position) {
    return Boolean(position && this._insideHold(position));
  }

  _addWalkableSurface({ width, depth, x = 0, y, z, name, stairTransition = false }) {
    const surface = boxMesh(width, HOLD_SURFACE_THICKNESS, depth, invisibleMaterial(), name);
    surface.position.set(x, y - HOLD_SURFACE_THICKNESS / 2, z);
    this._addWalkable(surface);
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

  _addWalkableRamp({ x = 0, startY, startZ, endY, endZ, width, name }) {
    const rise = endY - startY;
    const run = endZ - startZ;
    const length = Math.max(0.05, Math.hypot(run, rise));
    const ramp = boxMesh(width, HOLD_SURFACE_THICKNESS, length, invisibleMaterial(), name);
    ramp.position.set(x, (startY + endY) / 2 - HOLD_SURFACE_THICKNESS / 2, (startZ + endZ) / 2);
    ramp.rotation.order = "YXZ";
    ramp.rotation.x = -Math.atan2(rise, run);
    ramp.userData.lowLanding = [x, startY, startZ];
    ramp.userData.highLanding = [x, endY, endZ];
    this._addWalkable(ramp);
    const zone = new THREE.Box3().setFromObject(ramp);
    zone.expandByVector(new THREE.Vector3(0.75, 1.35, 1.4));
    this.ship.stairZones.push(zone);
    return ramp;
  }

  _addSolidBox({ width, height, depth, x = 0, y, z, name }) {
    const solid = boxMesh(width, height, depth, invisibleMaterial(), name);
    solid.position.set(x, y + height / 2, z);
    this._addSolid(solid);
    return solid;
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

    // Keep only the lower end of the native stair ramp connected. The upper
    // helper pads and side bypasses created too many invisible ledges around
    // the hatch, so the real game now relies on the native stair mesh there.
    this._addWalkableSurface({
      width: Math.min(5.2, this.holdWidth - 0.8),
      depth: 2.4,
      x: low.x,
      y: low.y,
      z: low.z,
      name: "HoldLowerStairsLanding",
      stairTransition: true,
    });

    const wallDepth = Math.max(2.2, Math.abs(innerThresholdZ - outerThresholdZ) + 0.6);
    const wallZ = (outerThresholdZ + innerThresholdZ) / 2;
    const sideWallX = doorwayWidth / 2 + DOOR_SIDE_WALL_THICKNESS / 2;
    for (const side of [-1, 1]) {
      this._addSolidBox({
        width: DOOR_SIDE_WALL_THICKNESS,
        height: DOOR_SIDE_WALL_HEIGHT,
        depth: wallDepth,
        x: this.exteriorDoorCenter.x + side * sideWallX,
        y: high.y,
        z: wallZ,
        name: side < 0 ? "HoldDoorPortSideWall" : "HoldDoorStarboardSideWall",
      });
    }
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
    this.doorProgress = 1;
    this.doorOpening = true;
    for (const node of this.modelDoorNodes) node.visible = false;
  }

  _scatterPlanks() {
    const wood = mat(0xb87545, 0.84, 0, { emissive: 0x261006, emissiveIntensity: 0.2 });
    const palletWood = mat(0x74401f, 0.92);
    const pileGap = (this.holdDepth - 13) / Math.max(1, BOARD_PILE_COUNT - 1);
    for (let pile = 0; pile < BOARD_PILE_COUNT; pile++) {
      const side = pile % 2 ? -1 : 1;
      const x = this.holdCenterX + side * (this.holdWidth * 0.25);
      const z = this.minZ + 6.5 + pile * pileGap;
      const pallet = boxMesh(5.1, 0.22, 2.1, palletWood, "RepairPlankPileBase");
      pallet.position.set(x, this.floorY + 0.11 + BOARD_PILE_Y_OFFSET, z);
      this.holdRoot.add(pallet);
    }
    for (let i = 0; i < BOARD_COUNT; i++) {
      const pile = Math.floor(i / BOARDS_PER_PILE);
      const layer = i % BOARDS_PER_PILE;
      const side = pile % 2 ? -1 : 1;
      const mesh = boxMesh(4.1 + (layer % 2) * 0.45, 0.24, 0.7, wood, "RepairPlank");
      mesh.position.set(
        this.holdCenterX + side * (this.holdWidth * 0.25) + (layer % 2 ? 0.18 : -0.18),
        this.floorY + 0.3 + BOARD_PILE_Y_OFFSET + layer * 0.24,
        this.minZ + 6.5 + pile * pileGap + ((layer % 3) - 1) * 0.12
      );
      mesh.rotation.y = side * 0.08 + (layer % 2 ? 0.025 : -0.025);
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
    const side = { axis: "x", sign: Math.sign(local.x - this.holdCenterX) || 1 };
    const inner = new THREE.Vector3();
    if (side.axis === "x") {
      inner.set(
        this.holdCenterX + side.sign * (this.holdWidth / 2 - BREACH_WALL_INSET),
        this.floorY + 2.2 + Math.random() * 2.6,
        THREE.MathUtils.clamp(
          this.holdCenterZ + (local.z - this.holdCenterZ) * BREACH_LONGITUDINAL_COMPRESSION,
          this.minZ + BREACH_END_MARGIN,
          this.maxZ - BREACH_END_MARGIN
        )
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

  _patchBreach(breach) {
    if (!breach?.active) return false;
    breach.active = false;
    breach.innerVisual.visible = false;
    breach.outerVisual.visible = false;
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
    return true;
  }

  _snapshotBreach(breach) {
    return {
      side: { axis: breach.side?.axis || "x", sign: breach.side?.sign || 1 },
      inner: { x: breach.inner.x, y: breach.inner.y, z: breach.inner.z },
      inward: { x: breach.inward.x, y: breach.inward.y, z: breach.inward.z },
    };
  }

  snapshot() {
    return {
      waterLevel: this.waterLevel,
      breachCooldown: this.breachCooldown,
      floodMultiplier: this.floodMultiplier,
      breaches: this.breaches.filter((breach) => breach.active).map((breach) => this._snapshotBreach(breach)),
    };
  }

  syncFromSnapshot(snapshot = {}) {
    if (Number.isFinite(snapshot.waterLevel)) this.waterLevel = snapshot.waterLevel;
    if (Number.isFinite(snapshot.breachCooldown)) this.breachCooldown = snapshot.breachCooldown;
    if (Number.isFinite(snapshot.floodMultiplier)) this.floodMultiplier = snapshot.floodMultiplier;
    const items = Array.isArray(snapshot.breaches) ? snapshot.breaches : [];
    while (this.breaches.length > items.length) {
      const breach = this.breaches.pop();
      breach?.innerVisual?.removeFromParent?.();
      breach?.outerVisual?.removeFromParent?.();
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const side = {
        axis: item.side?.axis === "z" ? "z" : "x",
        sign: item.side?.sign < 0 ? -1 : 1,
      };
      const inner = new THREE.Vector3(
        Number.isFinite(item.inner?.x) ? item.inner.x : this.holdCenterX,
        Number.isFinite(item.inner?.y) ? item.inner.y : this.floorY + 2.2,
        Number.isFinite(item.inner?.z) ? item.inner.z : this.holdCenterZ
      );
      const inward = new THREE.Vector3(
        Number.isFinite(item.inward?.x) ? item.inward.x : -side.sign,
        Number.isFinite(item.inward?.y) ? item.inward.y : -0.35,
        Number.isFinite(item.inward?.z) ? item.inward.z : 0
      ).normalize();
      let breach = this.breaches[i];
      if (!breach) {
        const outer = inner.clone();
        if (side.axis === "x") outer.x = side.sign * this.dims.beam * 0.52;
        else outer.z = side.sign * this.dims.length * 0.48;
        breach = {
          active: true,
          side,
          inner,
          inward,
          innerVisual: this._makeBreachVisual(side, inner, false),
          outerVisual: this._makeBreachVisual(side, outer, true),
        };
        this.breaches.push(breach);
      } else {
        breach.active = true;
        breach.side = side;
        breach.inner.copy(inner);
        breach.inward.copy(inward);
        breach.innerVisual.position.copy(inner);
        if (side.axis === "x") breach.innerVisual.rotation.y = side.sign * Math.PI / 2;
        const outer = inner.clone();
        if (side.axis === "x") outer.x = side.sign * this.dims.beam * 0.52;
        else outer.z = side.sign * this.dims.length * 0.48;
        breach.outerVisual.position.copy(outer);
        if (side.axis === "x") breach.outerVisual.rotation.y = side.sign * Math.PI / 2;
      }
      breach.innerVisual.visible = true;
      breach.outerVisual.visible = true;
    }
    this._updateFloodWater(0);
  }

  reset() {
    this.waterLevel = 0;
    this.breachCooldown = 0;
    this.floodMultiplier = 1;
    this.bailAssistRate = 0;
    this.repairAssistInterval = 0;
    this.repairAssistTimer = 0;
    this.bucketFull = false;
    this.pour = null;
    this.heldBucket?.removeFromParent?.();
    this.heldBucket = null;
    this.heldPlank?.removeFromParent?.();
    this.heldPlank = null;
    for (const plank of this.planks) {
      plank.available = true;
      plank.mesh.visible = true;
    }
    for (const breach of this.breaches) {
      breach.innerVisual?.removeFromParent?.();
      breach.outerVisual?.removeFromParent?.();
    }
    this.breaches = [];
    this._updateFloodWater(0);
  }

  applyRemoteScoopWater(position) {
    if (!position || !this._canCollectWater(position) || this.waterLevel < 1) return false;
    this.waterLevel = Math.max(0, this.waterLevel - BUCKET_AMOUNT);
    this._updateFloodWater(0);
    return true;
  }

  applyRemotePatchBreach(position) {
    if (!position || !this._insideHold(position)) return false;
    const breach = this._nearestActiveBreach(position);
    if (!breach) return false;
    this._patchBreach(breach);
    return true;
  }

  addFloodSlow(amount = 0.25) {
    this.floodMultiplier = Math.max(0.28, this.floodMultiplier * (1 - amount));
  }

  addBailHelper() {
    this.bailAssistRate += 0.75;
  }

  addRepairHelper() {
    this.repairAssistInterval = this.repairAssistInterval
      ? Math.max(5, this.repairAssistInterval - 2.5)
      : 11;
    this.repairAssistTimer = Math.min(this.repairAssistTimer || this.repairAssistInterval, this.repairAssistInterval);
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

  _onHoldAccessStairs(position) {
    const delta = this.holdAccess.low.clone().sub(this.holdAccess.high);
    const lengthSq = delta.lengthSq();
    if (lengthSq < 1e-5) return false;
    const t = THREE.MathUtils.clamp(position.clone().sub(this.holdAccess.high).dot(delta) / lengthSq, 0, 1);
    const closest = this.holdAccess.high.clone().addScaledVector(delta, t);
    return position.distanceTo(closest) <= 4.4;
  }

  _holdJumpCeilingY() {
    return Math.min(this.dims.deckY - 1.15, this.floorY + HOLD_JUMP_CEILING_ABOVE_FLOOR);
  }

  jumpCeilingY(position) {
    if (!position) return null;
    const ceilingY = this._holdJumpCeilingY();
    if (!this._insideHold(position)) return null;
    if (position.y >= ceilingY - 0.2) return null;
    return ceilingY;
  }

  _canCollectWater(position) {
    return (
      position.x >= this.minX &&
      position.x <= this.maxX &&
      position.y >= this.floorY - 0.65 &&
      position.y <= this.floorY + 1.8 &&
      position.z >= this.minZ &&
      position.z <= this.maxZ
    );
  }

  _nearExteriorDoor(position) {
    return position.distanceTo(this.exteriorDoorPosition) <= INTERACT_RANGE + 1;
  }

  _canDumpBucket(position) {
    const sideThreshold = this.holdWidth / 2 - 5.05;
    const deckThreshold = this.floorY + Math.max(4.4, this.holdHeight * 0.62);
    return (
      this.bucketFull &&
      position.y >= deckThreshold &&
      Math.abs(position.x - this.holdCenterX) >= sideThreshold
    );
  }

  canDumpBucket(rig) {
    return Boolean(rig && this._canDumpBucket(rig.position));
  }

  canTakePlank(rig) {
    const position = rig?.position;
    return Boolean(
      position &&
      this._canCollectWater(position) &&
      this._nearestPlank(position) &&
      !this.heldPlank &&
      !this.bucketFull &&
      !this.heldBucket
    );
  }

  takePlank(rig, camera) {
    const position = rig?.position;
    if (!position || !this._canCollectWater(position) || this.heldPlank || this.bucketFull || this.heldBucket) return false;
    const plank = this._nearestPlank(position);
    if (!plank) return false;
    this._setHeldPlank(camera, plank);
    this.onMessage("Доска взята. Подойди к пробоине и нажми кнопку заколотить.");
    return true;
  }

  canScoopWater(rig) {
    const position = rig?.position;
    return Boolean(
      position &&
      this._canCollectWater(position) &&
      this.waterLevel >= 1 &&
      !this.bucketFull &&
      !this.heldBucket &&
      !this.heldPlank
    );
  }

  scoopWater(rig, camera) {
    const position = rig?.position;
    if (!position || !this._canCollectWater(position) || this.waterLevel < 1 || this.bucketFull || this.heldBucket || this.heldPlank) return false;
    this.waterLevel = Math.max(0, this.waterLevel - BUCKET_AMOUNT);
    this._setBucket(camera, true);
    this.onMessage("Ведро наполнено. Вынеси его на палубу и вылей за борт.");
    return true;
  }

  canPatchBreach(rig) {
    const position = rig?.position;
    return Boolean(
      position &&
      this._insideHold(position) &&
      this._nearestActiveBreach(position) &&
      this.heldPlank
    );
  }

  patchNearestBreach(rig) {
    const position = rig?.position;
    if (!position || !this._insideHold(position) || !this.heldPlank) return false;
    const breach = this._nearestActiveBreach(position);
    if (!breach) return false;
    this.heldPlank.removeFromParent();
    this.heldPlank = null;
    this._patchBreach(breach);
    this.onMessage("Пробоина заколочена.");
    return true;
  }

  dumpBucket(rig) {
    const position = rig?.position;
    if (!position || !this._canDumpBucket(position)) return false;
    const origin = new THREE.Vector3();
    this.heldBucket?.getWorldPosition(origin);
    const side = Math.sign(position.x - this.holdCenterX) || 1;
    const direction = new THREE.Vector3(side, -0.9, 0).transformDirection(this.ship.group.matrixWorld).normalize();
    this.heldBucket?.removeFromParent();
    this.heldBucket = null;
    this.bucketFull = false;
    this.pour = { origin, direction, ttl: 1.1 };
    this.onMessage("Вода вылита за борт.");
    return true;
  }

  getPrompt(rig) {
    const position = rig.position;
    if (this._canDumpBucket(position)) return "E - вылить ведро за борт";
    if (this.canPatchBreach(rig)) return "F - заколотить пробоину";
    if (this.canTakePlank(rig)) return "F - взять доску";
    if (this.canScoopWater(rig)) return "E - зачерпнуть воду";
    return "";
  }

  interact(rig, camera) {
    if (this.dumpBucket(rig)) return true;
    if (this.scoopWater(rig, camera)) return true;
    return false;
  }

  secondaryInteract(rig, camera) {
    if (this.patchNearestBreach(rig)) return true;
    if (this.takePlank(rig, camera)) return true;
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
    const pressure = active.length * (1 + active.length * 0.16) * this.floodMultiplier;
    if (active.length) {
      this.waterLevel = Math.min(FLOOD_CAP, this.waterLevel + pressure * FLOOD_PER_HOLE * dt);
    }
    if (this.bailAssistRate > 0 && this.waterLevel > 0) {
      this.waterLevel = Math.max(0, this.waterLevel - this.bailAssistRate * dt);
    }
    if (this.repairAssistInterval > 0 && active.length) {
      this.repairAssistTimer -= dt;
      if (this.repairAssistTimer <= 0) {
        this._patchBreach(active[0]);
        this.onMessage("Плотник заколотил одну пробоину.");
        this.repairAssistTimer = this.repairAssistInterval;
      }
    }
    this._updateFloodWater(dt);
    this._emitInternalFlood(dt);

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

  _floodSurfaceY() {
    const t = THREE.MathUtils.clamp(this.waterLevel / FLOOD_CAP, 0, 1);
    return THREE.MathUtils.lerp(this.floodMinY, this.floodMaxY, smooth01(t));
  }

  _updateFloodWater(dt) {
    if (!this.water) return;
    const t = THREE.MathUtils.clamp(this.waterLevel / FLOOD_CAP, 0, 1);
    this.water.visible = t > 0.01;
    if (!this.water.visible) return;
    const time = performance.now() * 0.001;
    const calmLift = Math.sin(time * 1.25) * 0.035 + Math.sin(time * 0.73 + 1.7) * 0.018;
    this.water.position.y = this._floodSurfaceY() + calmLift;
    this.water.scale.setScalar(THREE.MathUtils.lerp(0.84, 1, smooth01(t)));
    const opacity = THREE.MathUtils.clamp(0.26 + t * 0.3, 0.26, 0.56);
    const uniforms = this.water.material.uniforms;
    if (uniforms?.uTime) {
      uniforms.uTime.value = time;
      uniforms.uOpacity.value = opacity;
      uniforms.uRepeat.value.set(
        THREE.MathUtils.lerp(1.8, 2.7, smooth01(t)),
        THREE.MathUtils.lerp(6.0, 8.4, smooth01(t))
      );
    } else {
      this.water.material.opacity = opacity;
      if (this.holdWaterNormalMap) {
        this.holdWaterNormalMap.offset.set((time * 0.018) % 1, (time * 0.032) % 1);
        const normalStrength = THREE.MathUtils.lerp(0.16, 0.28, smooth01(t));
        this.water.material.normalScale?.set(normalStrength, normalStrength);
      }
    }
    this.water.rotation.z = 0;
  }

  _emitInternalFlood() {
    if (this.waterLevel <= 4 || !this.effects?.calmFlood) return;
    const t = THREE.MathUtils.clamp(this.waterLevel / FLOOD_CAP, 0, 1);
    const pulses = Math.max(1, Math.floor(1 + t * 2));
    const y = this._floodSurfaceY() + 0.02;
    const time = performance.now() * 0.001;
    for (let i = 0; i < pulses; i++) {
      if (Math.random() > 0.11 + t * 0.12) continue;
      const x = this.holdCenterX + Math.sin(time * 0.7 + i * 2.1) * this.holdWidth * 0.22;
      const z = this.holdCenterZ + Math.cos(time * 0.55 + i * 1.6) * this.holdDepth * 0.3;
      const point = this.ship.group.localToWorld(new THREE.Vector3(x, y, z));
      this.effects.calmFlood(point, 0.18 + t * 0.36);
    }
  }

  getFloodSinkOffset() {
    const t = THREE.MathUtils.clamp(this.waterLevel / FLOOD_CAP, 0, 1);
    const hullHeight = Math.max(1, this.dims.deckY - this.dims.keelY);
    const earlyDraft = 0.018 * smoothRange(t, 0.12, 0.58);
    const heavyDraft = 0.055 * smoothRange(t, 0.58, 0.86);
    const failingDraft = 0.17 * smoothRange(t, 0.86, 1.0);
    return hullHeight * (earlyDraft + heavyDraft + failingDraft);
  }

  isDeckFlooded() {
    return this.waterLevel >= FLOOD_CAP;
  }

  isShipLost() {
    return this.isDeckFlooded();
  }

  get dangerLevel() {
    return this.waterLevel;
  }

  getState() {
    const dangerLevel = this.dangerLevel;
    return {
      waterLevel: this.waterLevel,
      dangerLevel,
      dangerPhase: "flood",
      activeBreaches: this.breaches.filter((breach) => breach.active).length,
      carryingPlank: Boolean(this.heldPlank),
      bucketFull: this.bucketFull,
    };
  }
}
