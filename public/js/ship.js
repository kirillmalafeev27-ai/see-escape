// ship.js — the player's ship. The .glb model supplies the looks; this module
// supplies gameplay sized to the *measured* model dimensions: aimable cannon
// stations on deck, the hold hatch, a 4-point buoyancy solver (heave/pitch/
// roll on the waves) and a hull hit-test for incoming cannonballs. A primitive
// hull is built as a fallback in case the model fails to load.
import * as THREE from "three";

export const SHIP_DEFAULTS = { length: 96, beam: 28, deckY: 12, keelY: -10 };
const BULWARK = 4;
const BARREL_LEN = 6;

function mat(color, rough = 0.85, metal = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function buildFallbackHull(group, d) {
  const hullH = d.deckY - d.keelY;
  const woodDark = mat(0x3a2a1a, 0.9);
  const woodMid = mat(0x6b4a2b, 0.85);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(d.beam, hullH, d.length * 0.96), woodDark);
  hull.position.y = (d.deckY + d.keelY) / 2;
  group.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(d.beam * 0.94, 0.6, d.length * 0.94), woodMid);
  deck.position.y = d.deckY;
  group.add(deck);
  for (const z of [d.length * 0.18, -d.length * 0.16]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 60, 10), mat(0x6b4a2b, 0.9));
    mast.position.set(0, d.deckY + 30, z);
    group.add(mast);
  }
}

function buildCannon() {
  const root = new THREE.Group(); // yaw pivot, fires along local +Z
  root.userData.isCannon = true;
  const dark = mat(0x2a2a2e, 0.5, 0.6);
  const wood = mat(0x5b4026, 0.9);
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 3.2), wood);
  carriage.position.y = 0.7;
  root.add(carriage);
  const pitch = new THREE.Group();
  pitch.position.y = 1.4;
  root.add(pitch);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, BARREL_LEN, 14), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = BARREL_LEN / 2;
  pitch.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.position.z = BARREL_LEN + 0.4;
  pitch.add(muzzle);
  return { root, pitch, muzzle };
}

export function buildPlayerShip(dims) {
  const d = { ...SHIP_DEFAULTS, ...dims };
  const group = new THREE.Group();
  group.rotation.order = "YXZ";

  buildFallbackHull(group, d);
  // hatch anchor (visual frame is part of the model / fallback only)
  const hatch = new THREE.Object3D();
  hatch.position.set(0, d.deckY, -d.length * 0.06);
  hatch.userData.radius = 7;
  group.add(hatch);

  // Cannons: 3 per side, mounted on the measured deck just inboard of the rail.
  const cannons = [];
  const xEdge = d.beam * 0.42;
  for (const z of [d.length * 0.24, 0, -d.length * 0.24]) {
    for (const side of ["stbd", "port"]) {
      const c = buildCannon();
      const x = (side === "stbd" ? 1 : -1) * xEdge;
      c.root.position.set(x, d.deckY, z);
      c.side = side;
      c.baseYaw = side === "stbd" ? -Math.PI / 2 : Math.PI / 2;
      c.root.rotation.y = c.baseYaw;
      c.yaw = 0;
      c.pitchAngle = 0.18;
      c.localPos = new THREE.Vector3(x, d.deckY + 1.6, z);
      group.add(c.root);
      cannons.push(c);
    }
  }

  // Collect primitive visuals (everything not part of a cannon) so they can be
  // hidden once the .glb model is attached.
  const primitiveVisuals = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    let p = o;
    let underCannon = false;
    while (p) {
      if (p.userData && p.userData.isCannon) { underCannon = true; break; }
      p = p.parent;
    }
    if (!underCannon) primitiveVisuals.push(o);
  });
  function hidePrimitives() {
    for (const m of primitiveVisuals) m.visible = false;
  }

  const halfL = d.length * 0.42;
  const halfW = d.beam * 0.42;
  function rotY(lx, lz, a) {
    const s = Math.sin(a), c = Math.cos(a);
    return [lx * c + lz * s, -lx * s + lz * c];
  }

  function applyBuoyancy(sampleWaveHeight) {
    const a = group.rotation.y;
    const px = group.position.x, pz = group.position.z;
    const [bx, bz] = rotY(0, halfL, a);
    const [sx, sz] = rotY(0, -halfL, a);
    const [rx, rz] = rotY(halfW, 0, a);
    const [lx, lz] = rotY(-halfW, 0, a);
    const bowH = sampleWaveHeight(px + bx, pz + bz);
    const sternH = sampleWaveHeight(px + sx, pz + sz);
    const stbdH = sampleWaveHeight(px + rx, pz + rz);
    const portH = sampleWaveHeight(px + lx, pz + lz);
    group.position.y = (bowH + sternH + stbdH + portH) / 4;
    group.rotation.x = Math.atan2(sternH - bowH, halfL * 2) * 0.9;
    group.rotation.z = Math.atan2(stbdH - portH, halfW * 2) * 0.9;
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
    cannons,
    hatch,
    applyBuoyancy,
    hullTest,
    hidePrimitives,
    primitiveVisuals,
    dims: d,
    hitRadius: d.length * 0.55,
  };
}
