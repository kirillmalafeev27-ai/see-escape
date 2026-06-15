// ship.js — the player's ship. The .glb model supplies the looks AND the deck
// you walk on (the player raycasts onto it). This module adds gameplay sized to
// the measured model: a 4-point buoyancy solver (heave/pitch/roll on the waves)
// and a hull hit-test for incoming cannonballs. A simple primitive hull is a
// fallback if the model fails to load.
import * as THREE from "three";

export const SHIP_DEFAULTS = { length: 96, beam: 28, deckY: 12, keelY: -10 };
const BULWARK = 5;
const BUOYANCY_RESPONSE = 4.5;
const FLOODED_BUOYANCY_RESPONSE = 1.85;
const DRAFT_RESPONSE = 1.65;
const WAVE_FLOW_LEAN = 0.00075;
const MAX_PITCH = 0.13;
const MAX_ROLL = 0.15;
const BROADSIDE_Z_SHIFT = 0.0;
const BROADSIDE_X_OUTBOARD = 3.35;
const BROADSIDE_DECK_Y_OFFSET = -0.42;

function mat(color, rough = 0.85, metal = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function buildFallbackHull(group, d) {
  const hullH = d.deckY - d.keelY;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(d.beam, hullH, d.length * 0.96), mat(0x3a2a1a, 0.9));
  hull.position.y = (d.deckY + d.keelY) / 2;
  group.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(d.beam * 0.94, 0.6, d.length * 0.94), mat(0x6b4a2b, 0.85));
  deck.position.y = d.deckY;
  group.add(deck);
  for (const z of [d.length * 0.18, -d.length * 0.16]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 60, 10), mat(0x6b4a2b, 0.9));
    m.position.set(0, d.deckY + 30, z);
    group.add(m);
  }
}

function buildCannons(group, d, cannonTemplate = null) {
  const battery = new THREE.Group();
  battery.name = "PlayerCannons";
  group.add(battery);

  const barrelGeo = new THREE.CylinderGeometry(0.48, 0.72, 6.4, 12);
  const carriageGeo = new THREE.BoxGeometry(3.1, 1.05, 2.2);
  const axleGeo = new THREE.CylinderGeometry(0.2, 0.2, 2.9, 8);
  const wheelGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.28, 12);
  const barrelMat = mat(0x20252b, 0.42, 0.62);
  const woodMat = mat(0x6b351f, 0.82);
  const darkWoodMat = mat(0x452416, 0.88);
  const cannons = [];
  const solidMeshes = [];
  let cannonSerial = 1;

  function addSolid(cannon, mesh) {
    cannon.add(mesh);
    solidMeshes.push(mesh);
  }

  function addModelVisual(yawPivot) {
    const visual = cannonTemplate.clone(true);
    visual.position.y = -yawPivot.position.y;
    yawPivot.add(visual);
    visual.traverse((o) => {
      if (o.isMesh) solidMeshes.push(o);
    });
  }

  function addCannon({ id, x, z, baseYaw, traverse, name, deckYOffset = 0.04, outboardOffset = 0 }) {
    const cannonId = id || `cannon-${cannonSerial}`;
    cannonSerial++;
    const cannon = new THREE.Group();
    cannon.name = `${cannonId} ${name}`;
    cannon.userData.cannonId = cannonId;
    cannon.position.set(x, d.deckY, z);
    cannon.rotation.y = baseYaw - Math.PI / 2;
    battery.add(cannon);

    const yawPivot = new THREE.Group();
    yawPivot.position.y = 1.62;
    cannon.add(yawPivot);

    const pitchPivot = new THREE.Group();
    yawPivot.add(pitchPivot);

    if (cannonTemplate) {
      addModelVisual(yawPivot);
    } else {
      const carriage = new THREE.Mesh(carriageGeo, woodMat);
      carriage.position.set(-0.45, 0.72, 0);
      addSolid(cannon, carriage);

      const axle = new THREE.Mesh(axleGeo, darkWoodMat);
      axle.position.set(-0.45, 0.58, 0);
      axle.rotation.x = Math.PI / 2;
      addSolid(cannon, axle);

      for (const wheelZ of [-1.18, 1.18]) {
        const wheel = new THREE.Mesh(wheelGeo, darkWoodMat);
        wheel.position.set(-0.45, 0.58, wheelZ);
        wheel.rotation.x = Math.PI / 2;
        addSolid(cannon, wheel);
      }

      const barrel = new THREE.Mesh(barrelGeo, barrelMat);
      barrel.position.x = 1.65;
      barrel.rotation.z = -Math.PI / 2;
      pitchPivot.add(barrel);
    }

    const muzzle = new THREE.Object3D();
    muzzle.position.x = 4.85;
    pitchPivot.add(muzzle);

    cannons.push({
      id: cannonId,
      name,
      mount: cannon,
      yawPivot,
      pitchPivot,
      muzzle,
      baseYaw,
      traverse,
      deckYOffset,
      outboardOffset,
      reload: 0,
      disabled: false,
    });
  }

  const cannonTraverse = THREE.MathUtils.degToRad(90);
  for (const side of [-1, 1]) {
    const baseYaw = side * Math.PI / 2;
    const sideName = side < 0 ? "port" : "starboard";
    const zFractions = [-0.38, -0.23, -0.08, 0.06, 0.18, 0.27];
    for (let i = 0; i < zFractions.length; i++) {
      const z = (zFractions[i] + BROADSIDE_Z_SHIFT) * d.length;
      addCannon({
        id: `${sideName}-${i + 1}`,
        x: side * d.beam * 0.43,
        z,
        baseYaw,
        traverse: cannonTraverse,
        deckYOffset: BROADSIDE_DECK_Y_OFFSET,
        outboardOffset: BROADSIDE_X_OUTBOARD,
        name: side < 0 ? "Port broadside cannon" : "Starboard broadside cannon",
      });
    }
  }

  // Swivel chase guns cover the fore and aft blind spots of the broadsides.
  addCannon({
    id: "bow-chase",
    x: 0,
    z: d.length * 0.23,
    baseYaw: 0,
    traverse: cannonTraverse,
    name: "Bow chase cannon",
  });
  addCannon({
    id: "stern-chase",
    x: 0,
    z: -d.length * 0.39,
    baseYaw: Math.PI,
    traverse: cannonTraverse,
    name: "Stern chase cannon",
  });
  return { cannons, solidMeshes };
}

export function buildPlayerShip(dims, { cannonTemplate = null } = {}) {
  const d = { ...SHIP_DEFAULTS, ...dims };
  const group = new THREE.Group();
  group.rotation.order = "YXZ";

  buildFallbackHull(group, d);

  // Primitive visuals so they can be hidden once the .glb model is attached.
  const primitiveVisuals = [];
  group.traverse((o) => {
    if (o.isMesh) primitiveVisuals.push(o);
  });
  function hidePrimitives() {
    for (const m of primitiveVisuals) m.visible = false;
  }
  const { cannons, solidMeshes: cannonSolidMeshes } = buildCannons(group, d, cannonTemplate);

  function snapCannonsToDeck(walkableMeshes) {
    if (!walkableMeshes?.length) return;
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0).transformDirection(group.matrixWorld);
    const origin = new THREE.Vector3();
    for (const cannon of cannons) {
      let deckY = null;
      let deckX = cannon.mount.position.x;
      const side = Math.sign(cannon.mount.position.x) || 1;
      for (const x of [
        cannon.mount.position.x,
        cannon.mount.position.x * 0.96,
        cannon.mount.position.x * 0.9,
        cannon.mount.position.x * 0.82,
        cannon.mount.position.x * 0.74,
        cannon.mount.position.x * 0.66,
        cannon.mount.position.x * 0.58,
      ]) {
        origin.set(x, d.deckY + d.length, cannon.mount.position.z);
        group.localToWorld(origin);
        ray.set(origin, down);
        ray.far = d.length * 2;
        const hit = ray.intersectObjects(walkableMeshes, false)[0];
        if (!hit) continue;
        deckY = group.worldToLocal(hit.point.clone()).y;
        deckX = x;
        break;
      }
      cannon.disabled = deckY === null;
      cannon.mount.visible = !cannon.disabled;
      cannon.mount.traverse((object) => {
        if (cannon.disabled) object.layers.disable(0);
        else object.layers.enable(0);
      });
      if (!cannon.disabled) {
        cannon.mount.position.x = deckX + side * cannon.outboardOffset;
        cannon.mount.position.y = deckY + cannon.deckYOffset;
      }
    }
    group.updateMatrixWorld(true);
  }

  const halfL = d.length * 0.42;
  const halfW = d.beam * 0.42;
  const buoyancyPoints = [
    { x: 0, z: halfL, weight: 1.16 },
    { x: 0, z: -halfL, weight: 1.08 },
    { x: halfW, z: 0, weight: 1.0 },
    { x: -halfW, z: 0, weight: 1.0 },
    { x: halfW * 0.68, z: halfL * 0.56, weight: 0.72 },
    { x: -halfW * 0.68, z: halfL * 0.56, weight: 0.72 },
  ];
  let buoyancyReady = false;
  let currentDraftOffset = 0;
  function rotY(lx, lz, a) {
    const s = Math.sin(a), c = Math.cos(a);
    return [lx * c + lz * s, -lx * s + lz * c];
  }

  function applyBuoyancy(sampleWaveHeight, dt = 1 / 60, sinkOffset = 0, sampleWaveFrame = null) {
    const safeDt = Math.max(0, dt);
    const draftAlpha = 1 - Math.exp(-DRAFT_RESPONSE * safeDt);
    currentDraftOffset = THREE.MathUtils.lerp(currentDraftOffset, Math.max(0, sinkOffset), draftAlpha);

    const a = group.rotation.y;
    const px = group.position.x, pz = group.position.z;
    const samples = [];
    let weightSum = 0;
    let heightSum = 0;
    let flowWorldX = 0;
    let flowWorldZ = 0;
    for (const point of buoyancyPoints) {
      const [ox, oz] = rotY(point.x, point.z, a);
      const wx = px + ox;
      const wz = pz + oz;
      const frame = sampleWaveFrame
        ? sampleWaveFrame(wx, wz)
        : { height: sampleWaveHeight(wx, wz), flowX: 0, flowZ: 0 };
      const weight = point.weight;
      samples.push({ point, height: frame.height, weight });
      weightSum += weight;
      heightSum += frame.height * weight;
      flowWorldX += (frame.flowX || 0) * weight;
      flowWorldZ += (frame.flowZ || 0) * weight;
    }

    const meanHeight = heightSum / Math.max(0.001, weightSum);
    let slopeXNum = 0;
    let slopeXDen = 0;
    let slopeZNum = 0;
    let slopeZDen = 0;
    for (const sample of samples) {
      const delta = sample.height - meanHeight;
      slopeXNum += sample.point.x * delta * sample.weight;
      slopeXDen += sample.point.x * sample.point.x * sample.weight;
      slopeZNum += sample.point.z * delta * sample.weight;
      slopeZDen += sample.point.z * sample.point.z * sample.weight;
    }

    const slopeX = slopeXNum / Math.max(0.001, slopeXDen);
    const slopeZ = slopeZNum / Math.max(0.001, slopeZDen);
    const [flowLocalX, flowLocalZ] = rotY(
      flowWorldX / Math.max(0.001, weightSum),
      flowWorldZ / Math.max(0.001, weightSum),
      -a
    );
    const hullHeight = Math.max(1, d.deckY - d.keelY);
    const floodT = THREE.MathUtils.clamp(currentDraftOffset / (hullHeight * 0.22), 0, 1);
    const targetY = meanHeight - currentDraftOffset;
    const floodedStiffness = THREE.MathUtils.lerp(0.72, 0.56, floodT);
    let targetPitch = (-Math.atan(slopeZ) * 0.75 - flowLocalZ * WAVE_FLOW_LEAN) * floodedStiffness;
    let targetRoll = (Math.atan(slopeX) * 0.75 + flowLocalX * WAVE_FLOW_LEAN) * floodedStiffness;
    targetPitch = THREE.MathUtils.clamp(targetPitch, -MAX_PITCH, MAX_PITCH);
    targetRoll = THREE.MathUtils.clamp(targetRoll, -MAX_ROLL, MAX_ROLL);

    if (!buoyancyReady) {
      group.position.y = targetY;
      group.rotation.x = targetPitch;
      group.rotation.z = targetRoll;
      buoyancyReady = true;
      return;
    }
    const response = THREE.MathUtils.lerp(BUOYANCY_RESPONSE, FLOODED_BUOYANCY_RESPONSE, floodT);
    const alpha = 1 - Math.exp(-response * safeDt);
    const rotationAlpha = 1 - Math.exp(-(response * 1.12) * safeDt);
    group.position.y = THREE.MathUtils.lerp(group.position.y, targetY, alpha);
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, targetPitch, rotationAlpha);
    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, targetRoll, rotationAlpha);
  }

  const _v = new THREE.Vector3();
  function hullTest(worldPoint) {
    _v.copy(worldPoint).sub(group.position);
    const [lx, lz] = rotY(_v.x, _v.z, -group.rotation.y);
    const ly = _v.y;
    if (
      Math.abs(lx) <= d.beam * 0.5 + 1.5 &&
      Math.abs(lz) <= d.length * 0.5 + 1.5 &&
      ly >= d.keelY &&
      ly <= d.deckY + BULWARK
    ) {
      const normal = new THREE.Vector3(_v.x, 0, _v.z);
      if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
      normal.normalize();
      return { point: worldPoint.clone(), normal };
    }
    return null;
  }

  return {
    group,
    modelPivot: null, // set by game when the .glb attaches
    walkableMeshes: [],
    stairZones: [],
    solidMeshes: cannonSolidMeshes,
    cannonSolidMeshes,
    cannons,
    snapCannonsToDeck,
    applyBuoyancy,
    hullTest,
    hidePrimitives,
    dims: d,
    hitRadius: d.length * 0.55,
  };
}
