// models.js — load the uploaded pirate-ship .glb assets and place them robustly
// regardless of each model's native root transform / orientation / scale.
// Normalization: center on x/z, drop keel to y=0, align the longest horizontal
// axis to +Z, scale so that axis equals `targetLength`, then sink the hull so
// the waterline sits at y=0. The actual walkable DECK height is found by
// raycasting straight down onto the real mesh (so the player stands on the
// model, not on a guessed plane).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const draco = new DRACOLoader();
draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

const cache = new Map();
function loadGLTF(url) {
  if (!cache.has(url)) {
    cache.set(url, new Promise((res, rej) => loader.load(url, res, undefined, rej)));
  }
  return cache.get(url);
}

const DOWN = new THREE.Vector3(0, -1, 0);
const NON_SHIP_NODE = /(?:water|ocean|sea|ground)(?:[\s_-]*plane)?/i;
const WALKABLE_NODE = /(?:floor|stairs|deck)/i;
const STAIRS_NODE = /(?:stairs|ladder)/i;
const MAST_NODE = /(?:mast(?:back|front|mid)?)/i;
// These parts still render, but should not become broad navigation blockers.
// Decks, visible outer fencing, the hull, and explicit mast colliders remain solid.
const NON_SOLID_NODE = /(?:sail|flag|wire|rope|cannon|bracing|support|wall|loophole|window|door)/i;
const CANNON_NODE = /^StylShip_Cannon\d+$/i;
const CANNON_WHEEL_LATERAL_CENTER = 5.7;
const CANNON_WHEEL_MAX_LENGTH = 12;
const MAST_COLLIDER_PADDING = 0.08;
const MAST_GRATE_MARGIN = 4.1;
const MAST_GRATE_MIN_SIZE = 9.2;
const MAST_GRATE_FLOOR_THICKNESS = 0.12;
const MAST_GRATE_SURFACE_LIFT = 0.14;
const DECK_SURFACE_OVERLAP = 0.7;
const DECK_SURFACE_LIFT = 0.12;
const DECK_SURFACE_THICKNESS = 0.1;
const STAIR_RAMP_THICKNESS = 0.16;
const STAIR_RAMP_END_EXTENSION = 0.5;
const STAIR_RAMP_TOP_EXTENSION = 1.25;
const STAIR_RAMP_SURFACE_LIFT = 0.05;

function removeNonShipNodes(parent) {
  for (const child of [...parent.children]) {
    if (NON_SHIP_NODE.test(child.name || "")) {
      parent.remove(child);
      continue;
    }
    removeNonShipNodes(child);
  }
}

function collectNavigationMeshes(root) {
  const walkableMeshes = [];
  const stairMeshes = [];
  const mastMeshes = [];
  const solidMeshes = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (MAST_NODE.test(o.name || "")) {
      mastMeshes.push(o);
      return;
    }
    if (WALKABLE_NODE.test(o.name || "")) {
      walkableMeshes.push(o);
      if (STAIRS_NODE.test(o.name || "")) stairMeshes.push(o);
    } else if (!NON_SOLID_NODE.test(o.name || "")) {
      solidMeshes.push(o);
    }
  });
  return { walkableMeshes, stairMeshes, mastMeshes, solidMeshes };
}

function median(values) {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function percentile(values, fraction) {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function collectWorldVertices(mesh) {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute("position");
  const vertices = [];
  for (let i = 0; i < position.count; i++) {
    vertices.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }
  return vertices;
}

function invisibleNavigationMaterial() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
}

function buildDeckSurfaceNavigation(walkableMeshes) {
  const navigationRoot = new THREE.Group();
  navigationRoot.name = "PlayerNavigation";
  const invisible = invisibleNavigationMaterial();
  for (const deck of [...walkableMeshes]) {
    if (STAIRS_NODE.test(deck.name || "")) continue;
    const box = new THREE.Box3().setFromObject(deck);
    const width = box.max.x - box.min.x;
    const depth = box.max.z - box.min.z;
    if (width < 1 || depth < 1) continue;
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(width + DECK_SURFACE_OVERLAP * 2, DECK_SURFACE_THICKNESS, depth + DECK_SURFACE_OVERLAP * 2),
      invisible
    );
    floor.name = `${deck.name}_DeckSurface`;
    floor.position.set(
      (box.min.x + box.max.x) / 2,
      box.max.y + DECK_SURFACE_LIFT - DECK_SURFACE_THICKNESS / 2,
      (box.min.z + box.max.z) / 2
    );
    navigationRoot.add(floor);
    walkableMeshes.push(floor);
  }
  return navigationRoot;
}

function buildMastNavigation(mastMeshes, walkableMeshes, navigationRoot) {
  const invisible = invisibleNavigationMaterial();
  const ray = new THREE.Raycaster();
  ray.ray.direction.copy(DOWN);

  function deckYNear(x, z, offset, top) {
    const hitsY = [];
    for (const [dx, dz] of [
      [offset, 0],
      [-offset, 0],
      [0, offset],
      [0, -offset],
      [offset * 0.72, offset * 0.72],
      [-offset * 0.72, offset * 0.72],
      [offset * 0.72, -offset * 0.72],
      [-offset * 0.72, -offset * 0.72],
    ]) {
      ray.ray.origin.set(x + dx, top, z + dz);
      ray.far = 200;
      const hit = ray.intersectObjects(walkableMeshes, false)[0];
      if (hit) hitsY.push(hit.point.y);
    }
    return hitsY.length ? median(hitsY) : null;
  }

  for (const mast of mastMeshes) {
    const vertices = collectWorldVertices(mast);
    if (!vertices.length) continue;
    const box = new THREE.Box3().setFromPoints(vertices);
    const height = box.max.y - box.min.y;
    const lowerBand = vertices.filter((vertex) => vertex.y <= box.min.y + Math.min(3, height * 0.18));
    if (!lowerBand.length) continue;

    const x = median(lowerBand.map((vertex) => vertex.x));
    const z = median(lowerBand.map((vertex) => vertex.z));
    const radius =
      Math.max(
        percentile(lowerBand.map((vertex) => Math.abs(vertex.x - x)), 0.9),
        percentile(lowerBand.map((vertex) => Math.abs(vertex.z - z)), 0.9)
      ) + MAST_COLLIDER_PADDING;

    const collider = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), invisible);
    collider.name = `${mast.name}_TrunkCollider`;
    collider.position.set(x, (box.min.y + box.max.y) / 2, z);
    navigationRoot.add(collider);

    const grateSize = Math.max(MAST_GRATE_MIN_SIZE, (radius + MAST_GRATE_MARGIN) * 2);
    const deckY = deckYNear(x, z, grateSize * 0.38, box.max.y + 4);
    if (deckY === null) continue;
    const grateFloor = new THREE.Mesh(
      new THREE.BoxGeometry(grateSize, MAST_GRATE_FLOOR_THICKNESS, grateSize),
      invisible
    );
    grateFloor.name = `${mast.name}_GrateFloor`;
    grateFloor.position.set(x, deckY + MAST_GRATE_SURFACE_LIFT - MAST_GRATE_FLOOR_THICKNESS / 2, z);
    navigationRoot.add(grateFloor);
    walkableMeshes.push(grateFloor);
  }
  navigationRoot.updateMatrixWorld(true);
  return { mastColliders: navigationRoot.children.filter((o) => /TrunkCollider$/.test(o.name)) };
}

function buildStairNavigation(stairMeshes, walkableMeshes, navigationRoot) {
  const invisible = invisibleNavigationMaterial();
  const ray = new THREE.Raycaster();
  ray.ray.direction.copy(DOWN);
  const ramps = [];
  const originalStairs = [...stairMeshes];
  const deckMeshes = [...walkableMeshes];

  function surfaceY(objects, x, z, top) {
    const hitsY = [];
    for (const xOffset of [-0.26, 0, 0.26]) {
      ray.ray.origin.set(x + xOffset, top, z);
      ray.far = 200;
      const hit = ray.intersectObjects(objects, false)[0];
      if (hit) hitsY.push(hit.point.y);
    }
    return hitsY.length ? median(hitsY) : null;
  }

  for (const stair of originalStairs) {
    const box = new THREE.Box3().setFromObject(stair);
    const width = box.max.x - box.min.x;
    const run = box.max.z - box.min.z;
    if (width < 0.2 || run < 0.2) continue;

    const x = (box.min.x + box.max.x) / 2;
    const samples = [];
    for (const fraction of [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92]) {
      const z = THREE.MathUtils.lerp(box.min.z, box.max.z, fraction);
      const y = surfaceY([stair], x, z, box.max.y + 2);
      if (y !== null) samples.push({ z, y });
    }
    if (samples.length < 2) continue;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const risePerZ = (last.y - first.y) / Math.max(1e-4, last.z - first.z);
    const highDirection = risePerZ >= 0 ? 1 : -1;
    const lowZ = highDirection > 0 ? box.min.z : box.max.z;
    const highZ = highDirection > 0 ? box.max.z : box.min.z;
    const lowSample = highDirection > 0 ? first : last;
    const highSample = highDirection > 0 ? last : first;
    const lowY = lowSample.y + (lowZ - lowSample.z) * risePerZ;
    let highY = highSample.y + (highZ - highSample.z) * risePerZ;

    const topZ = highZ + highDirection * STAIR_RAMP_TOP_EXTENSION;
    const deckY = surfaceY(
      deckMeshes.filter((mesh) => mesh !== stair),
      x,
      topZ,
      box.max.y + 4
    );
    if (deckY !== null && deckY >= highY - 0.35) highY = deckY;

    const startZ = lowZ - highDirection * STAIR_RAMP_END_EXTENSION;
    const endZ = topZ;
    const startY = lowY - STAIR_RAMP_END_EXTENSION * Math.abs(risePerZ);
    const endY = highY;
    const rampRun = Math.abs(endZ - startZ);
    const angle = Math.atan2(endY - startY, endZ - startZ);
    const slopeLength = Math.hypot(rampRun, endY - startY);
    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.96, STAIR_RAMP_THICKNESS, slopeLength),
      invisible
    );
    ramp.name = `${stair.name}_StairsRamp`;
    ramp.position.set(
      x,
      (startY + endY) / 2 - STAIR_RAMP_THICKNESS / 2 + STAIR_RAMP_SURFACE_LIFT,
      (startZ + endZ) / 2
    );
    ramp.rotation.x = -angle;
    navigationRoot.add(ramp);
    walkableMeshes.push(ramp);
    stairMeshes.push(ramp);
    ramps.push(ramp);
  }

  navigationRoot.updateMatrixWorld(true);
  return ramps;
}

function stripCannonWheels(geometry) {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) return geometry;

  const neighbors = Array.from({ length: position.count }, () => []);
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    neighbors[a].push(b, c);
    neighbors[b].push(a, c);
    neighbors[c].push(a, b);
  }

  const visited = new Uint8Array(position.count);
  const wheelVertex = new Uint8Array(position.count);
  for (let start = 0; start < position.count; start++) {
    if (visited[start] || !neighbors[start].length) continue;
    const stack = [start];
    const component = [];
    let lateralSum = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    visited[start] = 1;
    while (stack.length) {
      const vertex = stack.pop();
      component.push(vertex);
      lateralSum += position.getY(vertex);
      minX = Math.min(minX, position.getX(vertex));
      maxX = Math.max(maxX, position.getX(vertex));
      for (const neighbor of neighbors[vertex]) {
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    if (
      Math.abs(lateralSum / component.length) < CANNON_WHEEL_LATERAL_CENTER ||
      maxX - minX > CANNON_WHEEL_MAX_LENGTH
    ) {
      continue;
    }
    for (const vertex of component) wheelVertex[vertex] = 1;
  }

  const kept = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (!wheelVertex[a] && !wheelVertex[b] && !wheelVertex[c]) kept.push(a, b, c);
  }
  geometry.setIndex(kept);
  return geometry;
}

function extractCannonTemplate(root) {
  let source = null;
  const staticCannons = [];
  root.traverse((o) => {
    if (!CANNON_NODE.test(o.name || "")) return;
    staticCannons.push(o);
    if (!source) source = o;
  });
  if (!source) return null;

  source.updateWorldMatrix(true, true);
  const anchor = source.getWorldPosition(new THREE.Vector3());
  const forward = new THREE.Vector3(-1, 0, 0).transformDirection(source.matrixWorld);
  forward.y = 0;
  if (forward.lengthSq() < 1e-5) forward.set(1, 0, 0);
  forward.normalize();

  const normalize = new THREE.Matrix4()
    .makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(forward, new THREE.Vector3(1, 0, 0)))
    .multiply(new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z));
  const template = new THREE.Group();
  template.name = "PlayerCannonModelTemplate";
  source.traverse((o) => {
    if (!o.isMesh) return;
    const mesh = o.clone();
    mesh.geometry = stripCannonWheels(o.geometry.clone());
    mesh.geometry.applyMatrix4(normalize.clone().multiply(o.matrixWorld));
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
    template.add(mesh);
  });

  const box = new THREE.Box3().setFromObject(template);
  const center = box.getCenter(new THREE.Vector3());
  const floorShift = new THREE.Matrix4().makeTranslation(0, -box.min.y, -center.z);
  template.traverse((o) => {
    if (o.isMesh) o.geometry.applyMatrix4(floorShift);
  });
  for (const cannon of staticCannons) cannon.visible = false;
  return template;
}

export async function loadAndAnalyzeShip(url, { targetLength, flip = false, draftFraction = 0.4 }) {
  const gltf = await loadGLTF(url);
  const root = gltf.scene.clone(true);
  removeNonShipNodes(root);
  const { walkableMeshes, stairMeshes, mastMeshes, solidMeshes } = collectNavigationMeshes(root);

  // Wrap so we manipulate wrappers, never assume anything about the root's own
  // transform. inner = recenter/orient, pivot = scale + waterline drop.
  const inner = new THREE.Group();
  inner.add(root);
  const pivot = new THREE.Group();
  pivot.add(inner);
  pivot.updateMatrixWorld(true);

  // Orient the longest horizontal axis onto +Z.
  let box = new THREE.Box3().setFromObject(inner);
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) inner.rotation.y = Math.PI / 2;
  if (flip) inner.rotation.y += Math.PI;
  pivot.updateMatrixWorld(true);

  // Recenter on x/z and drop the keel to y = 0.
  box = new THREE.Box3().setFromObject(inner);
  size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  inner.position.x -= center.x;
  inner.position.z -= center.z;
  inner.position.y -= box.min.y;
  pivot.updateMatrixWorld(true);

  // Scale to target length.
  const lengthAxis = Math.max(size.x, size.z) || 1;
  pivot.scale.setScalar(targetLength / lengthAxis);
  pivot.updateMatrixWorld(true);

  // Final scaled footprint (keel still at y = 0).
  const fbox = new THREE.Box3().setFromObject(inner);
  const fsize = fbox.getSize(new THREE.Vector3());
  const beam = Math.min(fsize.x, fsize.z);
  const length = Math.max(fsize.x, fsize.z);

  // Find the walkable deck by raycasting down over the deck footprint, off the
  // centreline so we don't just hit the masts. Median ignores rails/cabins.
  const ray = new THREE.Raycaster();
  const top = fbox.max.y + 5;
  const hitsY = [];
  for (const fx of [-0.32, -0.18, 0.18, 0.32]) {
    for (const fz of [-0.3, -0.12, 0.12, 0.3]) {
      ray.set(new THREE.Vector3(fx * beam, top, fz * length), DOWN);
      const hits = ray.intersectObjects(walkableMeshes, false);
      if (hits.length) hitsY.push(hits[0].point.y);
    }
  }
  hitsY.sort((a, b) => a - b);
  const deckRaw = hitsY.length ? hitsY[Math.floor(hitsY.length / 2)] : fsize.y * 0.4;

  // Sink the hull so the waterline sits at y = 0.
  const draft = draftFraction * deckRaw;
  pivot.position.y = -draft;
  pivot.updateMatrixWorld(true);
  const navigationRoot = buildDeckSurfaceNavigation(walkableMeshes);
  const { mastColliders } = buildMastNavigation(mastMeshes, walkableMeshes, navigationRoot);
  buildStairNavigation(stairMeshes, walkableMeshes, navigationRoot);
  solidMeshes.push(...mastColliders);
  const cannonTemplate = extractCannonTemplate(root);
  const stairZones = stairMeshes.map((mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    box.min.x -= 0.8;
    box.max.x += 0.8;
    box.min.y -= 1.2;
    box.max.y += 1.2;
    box.min.z -= 1.8;
    box.max.z += 1.8;
    return box;
  });

  pivot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = false;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        if (material) material.side = THREE.FrontSide;
      }
    }
  });

  const dims = { length, beam, deckY: deckRaw - draft, keelY: -draft };
  return { pivot, navigationRoot, dims, walkableMeshes, solidMeshes, stairZones, cannonTemplate };
}
