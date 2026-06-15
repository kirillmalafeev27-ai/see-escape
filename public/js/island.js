import * as THREE from "three";
import { solveLaunchVelocity } from "./ballistics.js?v=20260603-bonuses-island-v1";
import { loadGLTF } from "./models.js?v=20260607-assets-fire-v1";
import { loadIslandLayout } from "./island-layout.js?v=20260609-quest-zone-scale-v4";

const ISLAND_POSITION = new THREE.Vector3(-320, 0, 1420);
const ISLAND_FIRE_RANGE = 900;
const ISLAND_MUZZLE_SPEED = 235;
const ISLAND_DECOR_LOAD_RANGE = 1150;

function mat(color, roughness = 0.86, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addBox(parent, size, position, material, name = "") {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.name = name;
  mesh.position.copy(position);
  parent.add(mesh);
  return mesh;
}

function addCylinder(parent, radiusTop, radiusBottom, height, segments, position, material, name = "") {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
  mesh.name = name;
  mesh.position.copy(position);
  parent.add(mesh);
  return mesh;
}

function prepareLoadedModel(object) {
  const removals = [];
  object.traverse((child) => {
    if (child.isLight || child.isCamera) {
      removals.push(child);
      return;
    }
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      material.side = THREE.FrontSide;
      material.roughness = Math.max(material.roughness ?? 0.8, 0.72);
    }
  });
  for (const child of removals) child.parent?.remove(child);
}

function isWaterLikeMaterial(material) {
  if (!material?.color) return false;
  const alpha = material.opacity ?? 1;
  const transparent = material.transparent || alpha < 0.85;
  return transparent && material.color.g > 0.45 && material.color.b > 0.45;
}

function stripNonIslandModelParts(object) {
  const removals = [];
  object.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    if (materials.some(isWaterLikeMaterial)) removals.push(child);
  });
  for (const child of removals) child.parent?.remove(child);
}

function fitLoadedModel(object, { targetXZ, baseY, position = new THREE.Vector3(), yaw = 0 }) {
  object.rotation.y = yaw;
  object.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(object);
  let size = box.getSize(new THREE.Vector3());
  const scale = targetXZ / Math.max(0.001, size.x, size.z);
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(object);
  size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.x += position.x - center.x;
  object.position.z += position.z - center.z;
  object.position.y += baseY - box.min.y;
  object.userData.fitSize = { x: size.x, y: size.y, z: size.z };
}

function buildTree(parent, x, y, z, scale = 1, lean = 0) {
  const trunk = addCylinder(parent, 0.8 * scale, 1.05 * scale, 7 * scale, 7, new THREE.Vector3(x, y + 3.5 * scale, z), mat(0x5d351c, 0.94));
  trunk.rotation.z = lean;
  const crown = new THREE.Mesh(new THREE.ConeGeometry(4.4 * scale, 10 * scale, 9), mat(0x2c7134, 0.96));
  crown.position.set(x, y + 7 + 4.2 * scale, z);
  parent.add(crown);
}

function buildFortCannon(parent, position, index, yaw = 0, scale = 1) {
  const mount = new THREE.Group();
  mount.name = `IslandCannon_${index}`;
  mount.position.copy(position);
  mount.rotation.y = yaw;
  mount.scale.setScalar(scale);
  parent.add(mount);
  const carriage = addBox(mount, new THREE.Vector3(4.6, 1.3, 4.4), new THREE.Vector3(0, 0.65, 0), mat(0x63371f, 0.9));
  carriage.rotation.y = Math.PI / 4;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.08, 8.5, 14), mat(0x252c30, 0.42, 0.7));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 2.5, 3.7);
  mount.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 2.5, 8.1);
  mount.add(muzzle);
  return {
    mount,
    muzzle,
    reload: 2.5 + Math.random() * 4,
    destroyed: false,
  };
}

export class IslandFortress {
  constructor(scene, projectiles, effects, getPlayerTarget) {
    this.scene = scene;
    this.projectiles = projectiles;
    this.effects = effects;
    this.getPlayerTarget = getPlayerTarget;
    this.group = new THREE.Group();
    this.group.name = "FortressIsland";
    this.group.position.copy(ISLAND_POSITION);
    scene.add(this.group);
    this.cannons = [];
    this.layout = loadIslandLayout();
    this._tmp = new THREE.Vector3();
    this.decorLoading = false;
    this.decorLoaded = false;
    this._build();
  }

  _build() {
    for (const item of this.layout.objects) {
      if (item.visible === false || item.type === "model") continue;
      if (item.type === "box") {
        const mesh = addBox(
          this.group,
          new THREE.Vector3(item.width, item.height, item.depth),
          new THREE.Vector3(item.x, item.y, item.z),
          mat(item.color ?? 0x6f7168, 0.94),
          item.id
        );
        mesh.rotation.y = item.yaw || 0;
      } else if (item.type === "cylinder") {
        addCylinder(
          this.group,
          item.radiusTop,
          item.radiusBottom,
          item.height,
          item.segments || 12,
          new THREE.Vector3(item.x, item.y, item.z),
          mat(item.color ?? 0x6f7168, 0.96),
          item.id
        );
        if (item.crenels) this._addTowerCrenels(item);
      } else if (item.type === "tree") {
        buildTree(this.group, item.x, item.y, item.z, item.scale, item.lean);
      } else if (item.type === "cannon") {
        const cannon = buildFortCannon(
          this.group,
          new THREE.Vector3(item.x, item.y, item.z),
          this.cannons.length + 1,
          item.yaw || 0,
          item.scale || 1
        );
        this.cannons.push(cannon);
      }
    }
  }

  _addTowerCrenels(item) {
    const stone = mat(0x6f7168, 0.94);
    const radius = Math.max(item.radiusTop, item.radiusBottom) * 0.7;
    const y = item.y + item.height * 0.54;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      addBox(
        this.group,
        new THREE.Vector3(5.2, 4.2, 5.2),
        new THREE.Vector3(item.x + Math.cos(a) * radius, y, item.z + Math.sin(a) * radius),
        stone,
        `${item.id}_Crenel_${i + 1}`
      );
    }
  }

  async _loadDecorModels() {
    if (this.decorLoading || this.decorLoaded) return;
    this.decorLoading = true;
    const assets = {
      low_poly_island: { url: "models/low_poly_island.glb", name: "LoadedLowPolyIslandModel" },
      relic: { url: "models/relic_optimized.glb", name: "LoadedRelicAltarModel" },
      treasure: { url: "models/treasure_chest_lowpoly.glb", name: "LoadedFortressTreasureChest" },
    };
    const modelItems = this.layout.objects.filter((item) => item.visible !== false && item.type === "model" && assets[item.asset]);
    const results = await Promise.allSettled(modelItems.map(async (item) => {
      const asset = assets[item.asset];
      const model = (await loadGLTF(asset.url)).scene.clone(true);
      model.name = `${asset.name}_${item.id}`;
      if (item.asset === "low_poly_island") stripNonIslandModelParts(model);
      prepareLoadedModel(model);
      fitLoadedModel(model, {
        targetXZ: item.targetXZ,
        baseY: item.y,
        position: new THREE.Vector3(item.x, 0, item.z),
        yaw: item.yaw || 0,
      });
      this.group.add(model);
    }));
    for (const result of results) {
      if (result.status === "rejected") console.warn("Island decor model failed:", result.reason);
    }
    this.decorLoaded = true;
    this.decorLoading = false;
  }

  activeCannons() {
    return this.cannons.filter((cannon) => !cannon.destroyed);
  }

  update(dt) {
    const player = this.getPlayerTarget();
    if (!this.decorLoaded && !this.decorLoading && player.pos.distanceTo(this.group.position) <= ISLAND_DECOR_LOAD_RANGE) {
      this._loadDecorModels();
    }
    for (const cannon of this.activeCannons()) {
      const cannonPosition = cannon.mount.getWorldPosition(new THREE.Vector3());
      cannon.mount.lookAt(player.pos.x, cannonPosition.y, player.pos.z);
    }
  }

  hitTest(proj) {
    for (const cannon of this.activeCannons()) {
      const point = cannon.mount.getWorldPosition(new THREE.Vector3());
      point.y += 2;
      if (point.distanceTo(proj.pos) <= 7.4 + (proj.radius || 0)) {
        const normal = proj.vel.clone().normalize().multiplyScalar(-1);
        return { kind: "islandCannon", cannon, point: proj.pos.clone(), normal };
      }
    }
    const local = this.group.worldToLocal(proj.pos.clone());
    if (Math.hypot(local.x, local.z) <= 175 && local.y >= -4 && local.y <= 86) {
      const normal = new THREE.Vector3(local.x, 0.2, local.z).normalize().transformDirection(this.group.matrixWorld);
      return { kind: "island", point: proj.pos.clone(), normal };
    }
    return null;
  }

  destroyCannon(cannon) {
    if (!cannon || cannon.destroyed) return false;
    cannon.destroyed = true;
    cannon.mount.visible = false;
    return true;
  }

  get position() {
    return this.group.position;
  }
}
