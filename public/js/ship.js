// ship.js — the player's ship. The .glb model supplies the looks AND the deck
// you walk on (the player raycasts onto it). This module adds gameplay sized to
// the measured model: a 4-point buoyancy solver (heave/pitch/roll on the waves)
// and a hull hit-test for incoming cannonballs. A simple primitive hull is a
// fallback if the model fails to load.
import * as THREE from "three";

export const SHIP_DEFAULTS = { length: 96, beam: 28, deckY: 12, keelY: -10 };
const BULWARK = 5;

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

export function buildPlayerShip(dims) {
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
    modelPivot: null, // set by game when the .glb attaches
    applyBuoyancy,
    hullTest,
    hidePrimitives,
    dims: d,
    hitRadius: d.length * 0.55,
  };
}
