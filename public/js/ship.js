// ship.js — the player's ship built from primitives: hull, deck, bulwarks,
// masts, the hold hatch (big door to below-deck, used by a later iteration)
// and aimable cannons. Plus a buoyancy solver that makes it heave/pitch/roll
// on the Gerstner waves, and a hull hit-test for incoming cannonballs.
import * as THREE from "three";

export const SHIP = {
  length: 96, // along local Z
  beam: 28, // along local X
  deckY: 3, // deck top above waterline (local)
  hullBottom: -10,
  bulwark: 4, // wall height above deck
  barrelLen: 6,
};

function mat(color, rough = 0.85, metal = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function buildHull(group, dims, woodDark, woodMid) {
  const { length: L, beam: W, deckY, hullBottom } = dims;
  const hullH = deckY - hullBottom;
  // Main hull as a slightly tapered box.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(W, hullH, L * 0.96), woodDark);
  hull.position.y = (deckY + hullBottom) / 2;
  group.add(hull);
  // Bow wedge.
  const bow = new THREE.Mesh(new THREE.ConeGeometry(W * 0.5, L * 0.18, 4), woodDark);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.scale.set(1, 1, 0.6);
  bow.position.set(0, (deckY + hullBottom) / 2, L * 0.5);
  group.add(bow);
  // Deck.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, 0.6, L * 0.94), woodMid);
  deck.position.y = deckY;
  group.add(deck);
  return hull;
}

function buildBulwarks(group, dims, woodMid) {
  const { length: L, beam: W, deckY, bulwark } = dims;
  const y = deckY + bulwark / 2;
  const t = 1.2;
  const add = (w, h, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), woodMid);
    m.position.set(x, y, z);
    group.add(m);
  };
  add(t, bulwark, L * 0.94, W * 0.47, 0); // starboard
  add(t, bulwark, L * 0.94, -W * 0.47, 0); // port
  add(W * 0.94, bulwark, t, 0, -L * 0.47); // stern
}

function buildMasts(group, dims) {
  const { deckY } = dims;
  const m = mat(0x6b4a2b, 0.9);
  for (const z of [18, -16]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 64, 10), m);
    mast.position.set(0, deckY + 32, z);
    group.add(mast);
    const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 34, 8), m);
    spar.rotation.z = Math.PI / 2;
    spar.position.set(0, deckY + 48, z);
    group.add(spar);
    // simple sail
    const sail = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 26),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 1, side: THREE.DoubleSide })
    );
    sail.position.set(0, deckY + 34, z);
    group.add(sail);
  }
}

// Big hatch/door down to the hold (used by the interior teleport later).
function buildHatch(group, dims) {
  const { deckY } = dims;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(12, 2, 12), mat(0x5b4026, 0.9));
  frame.position.set(0, deckY + 1, -2);
  group.add(frame);
  const door = new THREE.Mesh(new THREE.BoxGeometry(10.4, 1, 10.4), mat(0x3a2817, 0.8));
  door.position.set(0, deckY + 2.1, -2);
  group.add(door);
  const hatch = new THREE.Object3D();
  hatch.position.set(0, deckY, -2);
  group.add(hatch);
  hatch.userData.radius = 7;
  return hatch;
}

function buildCannon(side) {
  const root = new THREE.Group(); // yaw pivot (fires along local +Z)
  root.userData.isCannon = true;
  const dark = mat(0x2a2a2e, 0.5, 0.6);
  const wood = mat(0x5b4026, 0.9);
  // carriage
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 4), wood);
  carriage.position.y = 0.8;
  root.add(carriage);
  // pitch pivot + barrel
  const pitch = new THREE.Group();
  pitch.position.y = 1.6;
  root.add(pitch);
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.7, SHIP.barrelLen, 14),
    dark
  );
  barrel.rotation.x = Math.PI / 2; // align cylinder to +Z
  barrel.position.z = SHIP.barrelLen / 2;
  pitch.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.position.z = SHIP.barrelLen + 0.4;
  pitch.add(muzzle);

  // face outward: starboard(+X) => +Z maps to +X; port(-X) => +Z maps to -X
  const baseYaw = side === "stbd" ? -Math.PI / 2 : Math.PI / 2;
  root.rotation.y = baseYaw;

  return { root, pitch, muzzle, side, baseYaw, yaw: 0, pitchAngle: 0.18 };
}

export function buildPlayerShip() {
  const group = new THREE.Group();
  group.rotation.order = "YXZ";
  const woodDark = mat(0x3a2a1a, 0.9);
  const woodMid = mat(0x6b4a2b, 0.85);

  buildHull(group, SHIP, woodDark, woodMid);
  buildBulwarks(group, SHIP, woodMid);
  buildMasts(group, SHIP);
  const hatch = buildHatch(group, SHIP);

  // Cannons: 3 per side along the deck.
  const cannons = [];
  const zs = [22, 0, -22];
  for (const z of zs) {
    for (const side of ["stbd", "port"]) {
      const c = buildCannon(side);
      const x = (side === "stbd" ? 1 : -1) * (SHIP.beam * 0.45);
      c.root.position.set(x, SHIP.deckY + 0.6, z);
      c.localPos = new THREE.Vector3(x, SHIP.deckY + 2, z);
      group.add(c.root);
      cannons.push(c);
    }
  }

  // Primitive visual meshes (everything except the cannons) so they can be
  // hidden once the loaded .glb model takes over the looks.
  const primitiveVisuals = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    let p = o;
    let underCannon = false;
    while (p) {
      if (p.userData && p.userData.isCannon) {
        underCannon = true;
        break;
      }
      p = p.parent;
    }
    if (!underCannon) primitiveVisuals.push(o);
  });
  function hidePrimitives() {
    for (const m of primitiveVisuals) m.visible = false;
  }

  // Buoyancy sample offsets (local, on the xz plane).
  const halfL = SHIP.length * 0.42;
  const halfW = SHIP.beam * 0.42;

  function rotY(lx, lz, a) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return [lx * c + lz * s, -lx * s + lz * c];
  }

  // Heave/pitch/roll from 4 sampled wave heights. yaw stays as set by caller.
  function applyBuoyancy(sampleWaveHeight) {
    const a = group.rotation.y;
    const px = group.position.x;
    const pz = group.position.z;
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

  // Approximate hull hit test for an incoming cannonball (world point).
  const _v = new THREE.Vector3();
  function hullTest(worldPoint) {
    _v.copy(worldPoint).sub(group.position);
    const a = -group.rotation.y;
    const [lx, lz] = rotY(_v.x, _v.z, a);
    const ly = _v.y;
    const halfBeam = SHIP.beam * 0.5 + 1.5;
    const halfLen = SHIP.length * 0.5 + 1.5;
    if (
      Math.abs(lx) <= halfBeam &&
      Math.abs(lz) <= halfLen &&
      ly >= SHIP.hullBottom &&
      ly <= SHIP.deckY + SHIP.bulwark
    ) {
      const normal = new THREE.Vector3(_v.x, 0, _v.z);
      if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
      normal.normalize();
      return { point: worldPoint.clone(), normal, local: new THREE.Vector3(lx, ly, lz) };
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
    dims: SHIP,
    hitRadius: SHIP.length * 0.55,
  };
}
