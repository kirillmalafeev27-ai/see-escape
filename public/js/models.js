// models.js — load the uploaded pirate-ship .glb assets and MEASURE them so all
// gameplay (deck height, beam, waterline, cannon stations) fits the actual
// model instead of guessed constants. A normalized model is centered on x/z,
// scaled so its longest horizontal axis equals `targetLength`, aligned
// bow-along +Z, and dropped so its waterline sits at local y = 0.
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

// Sample mesh vertices in the model's final (scaled/rotated) frame.
function sampleVertices(model, maxSamples = 6000) {
  const meshes = [];
  let total = 0;
  model.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.attributes.position) {
      meshes.push(o);
      total += o.geometry.attributes.position.count;
    }
  });
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const out = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  return out;
}

// Load + measure. Returns { pivot, dims:{length,beam,deckY,keelY} }.
export async function loadAndAnalyzeShip(url, { targetLength, flip = false, draftFraction = 0.42 }) {
  const gltf = await loadGLTF(url);
  const model = gltf.scene.clone(true);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Center, orient longest horizontal axis to +Z, scale to target length.
  model.position.sub(center);
  const pivot = new THREE.Group();
  pivot.add(model);
  if (size.x > size.z) pivot.rotation.y = Math.PI / 2;
  if (flip) pivot.rotation.y += Math.PI;
  const lengthAxis = Math.max(size.x, size.z) || 1;
  const scale = targetLength / lengthAxis;
  pivot.scale.setScalar(scale);
  pivot.position.set(0, 0, 0);
  pivot.updateMatrixWorld(true);

  // Analyze in the fitted frame.
  const verts = sampleVertices(model);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < verts.length; i += 3) {
    if (verts[i] < minY) minY = verts[i];
    if (verts[i] > maxY) maxY = verts[i];
  }
  // Y histogram: the deck/hull is a dense band; masts/rigging are sparse.
  const BINS = 48;
  const counts = new Array(BINS).fill(0);
  const span = maxY - minY || 1;
  for (let i = 1; i < verts.length; i += 3) {
    const b = Math.min(BINS - 1, Math.floor(((verts[i] - minY) / span) * BINS));
    counts[b]++;
  }
  const maxCount = Math.max(...counts);
  // highest bin that still belongs to the bulky hull/deck (not masts)
  let deckBin = 0;
  for (let b = 0; b < BINS; b++) if (counts[b] >= 0.15 * maxCount) deckBin = b;
  const deckTop = minY + ((deckBin + 1) / BINS) * span;

  // Beam/length measured only from the hull (below the deck) to ignore the
  // wide yardarms and the long bowsprit up high.
  let lateral = 0;
  let lengthwise = 0;
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i + 1] <= deckTop) {
      lateral = Math.max(lateral, Math.abs(verts[i]));
      lengthwise = Math.max(lengthwise, Math.abs(verts[i + 2]));
    }
  }
  const beam = lateral * 2;
  const length = Math.min(targetLength, lengthwise * 2) || targetLength;

  // Sink the hull so the waterline sits at y=0 (draftFraction up the hull).
  const draft = draftFraction * (deckTop - minY);
  const yOffset = -(minY + draft);
  pivot.position.y = yOffset;

  const dims = {
    length,
    beam,
    deckY: deckTop + yOffset,
    keelY: minY + yOffset,
  };

  pivot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = false;
      if (o.material) o.material.side = THREE.FrontSide;
    }
  });

  return { pivot, dims };
}
