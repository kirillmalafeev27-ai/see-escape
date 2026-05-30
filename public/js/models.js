// models.js — load the uploaded pirate-ship .glb assets and normalize them so
// gameplay code can stay decoupled from each model's native scale/orientation.
// A normalized model is centered on x/z, scaled so its longest horizontal axis
// equals `targetLength`, aligned bow-along +Z, with its keel placed at `keelY`.
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
    cache.set(
      url,
      new Promise((res, rej) => loader.load(url, res, undefined, rej))
    );
  }
  return cache.get(url);
}

// Returns a THREE.Group (pivot) you can add to a ship root. Resolves even-ish
// orientation; `flip` rotates 180° if the bow ends up pointing the wrong way.
export async function loadShipModel(url, { targetLength, keelY = 0, flip = false }) {
  const gltf = await loadGLTF(url);
  const model = gltf.scene.clone(true);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Center the model at the origin of a pivot.
  model.position.sub(center);
  const pivot = new THREE.Group();
  pivot.add(model);

  // Bring the longest horizontal axis onto +Z.
  if (size.x > size.z) pivot.rotation.y = Math.PI / 2;
  if (flip) pivot.rotation.y += Math.PI;

  const lengthAxis = Math.max(size.x, size.z) || 1;
  const scale = targetLength / lengthAxis;
  pivot.scale.setScalar(scale);

  // Drop the keel (min Y) to keelY. Model is centered, so min Y = -size.y/2.
  pivot.position.y = keelY + (size.y / 2) * scale;

  pivot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.material) o.material.side = THREE.FrontSide;
    }
  });

  pivot.userData.fittedSize = new THREE.Vector3(
    size.x * scale,
    size.y * scale,
    size.z * scale
  );
  return pivot;
}

// Preload + normalize once; hand out cheap clones for repeated enemies.
export async function makeShipFactory(url, opts) {
  const template = await loadShipModel(url, opts);
  return () => template.clone(true);
}
