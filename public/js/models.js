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
const NON_SOLID_NODE = /(?:sail|flag|wire|rope)/i;

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
  const solidMeshes = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (WALKABLE_NODE.test(o.name || "")) {
      walkableMeshes.push(o);
    } else if (!NON_SOLID_NODE.test(o.name || "")) {
      solidMeshes.push(o);
    }
  });
  return { walkableMeshes, solidMeshes };
}

export async function loadAndAnalyzeShip(url, { targetLength, flip = false, draftFraction = 0.4 }) {
  const gltf = await loadGLTF(url);
  const root = gltf.scene.clone(true);
  removeNonShipNodes(root);
  const { walkableMeshes, solidMeshes } = collectNavigationMeshes(root);

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
  return { pivot, dims, walkableMeshes, solidMeshes };
}
