import * as THREE from "three";
import { solveLaunchVelocity } from "./ballistics.js?v=20260603-bonuses-island-v1";

const ISLAND_POSITION = new THREE.Vector3(-320, 0, 1420);
const ISLAND_FIRE_RANGE = 900;
const ISLAND_MUZZLE_SPEED = 235;

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

function buildTree(parent, x, z, scale = 1) {
  const trunk = addCylinder(parent, 0.8 * scale, 1.05 * scale, 7 * scale, 7, new THREE.Vector3(x, 37 + 3.5 * scale, z), mat(0x5d351c, 0.94));
  trunk.rotation.z = (Math.random() - 0.5) * 0.12;
  const crown = new THREE.Mesh(new THREE.ConeGeometry(4.4 * scale, 10 * scale, 9), mat(0x2c7134, 0.96));
  crown.position.set(x, 44 + 4.2 * scale, z);
  parent.add(crown);
}

function buildFortCannon(parent, position, index) {
  const mount = new THREE.Group();
  mount.name = `IslandCannon_${index}`;
  mount.position.copy(position);
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
    this._tmp = new THREE.Vector3();
    this._build();
  }

  _build() {
    const rock = mat(0x4d554e, 0.98);
    const sand = mat(0xbfa66b, 0.96);
    const grass = mat(0x477d3c, 0.98);
    const stone = mat(0x6f7168, 0.94);
    const darkStone = mat(0x54574f, 0.96);
    addCylinder(this.group, 136, 174, 34, 18, new THREE.Vector3(0, 14, 0), rock, "IslandRock");
    addCylinder(this.group, 151, 164, 8, 24, new THREE.Vector3(0, 3.5, 0), sand, "IslandShore");
    addCylinder(this.group, 133, 140, 7, 20, new THREE.Vector3(0, 33.5, 0), grass, "IslandGrass");

    addBox(this.group, new THREE.Vector3(96, 25, 78), new THREE.Vector3(0, 53, 0), stone, "FortressKeep");
    for (const [x, z] of [[-59, -48], [59, -48], [-59, 48], [59, 48]]) {
      addCylinder(this.group, 14, 16, 43, 12, new THREE.Vector3(x, 56, z), darkStone, "FortressTower");
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        addBox(
          this.group,
          new THREE.Vector3(5.2, 4.2, 5.2),
          new THREE.Vector3(x + Math.cos(a) * 11.2, 79.2, z + Math.sin(a) * 11.2),
          stone,
          "FortressCrenel"
        );
      }
    }
    for (const z of [-42, 42]) {
      addBox(this.group, new THREE.Vector3(118, 16, 8), new THREE.Vector3(0, 56, z), stone, "FortressWall");
    }
    for (const x of [-55, 55]) {
      addBox(this.group, new THREE.Vector3(8, 16, 92), new THREE.Vector3(x, 56, 0), stone, "FortressWall");
    }
    addBox(this.group, new THREE.Vector3(24, 29, 12), new THREE.Vector3(0, 56, -48), darkStone, "FortressGate");

    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const radius = 105 + Math.random() * 23;
      buildTree(this.group, Math.cos(angle) * radius, Math.sin(angle) * radius, 0.72 + Math.random() * 0.72);
    }

    const cannonPositions = [
      [-92, 43, -65],
      [-112, 42, 0],
      [-92, 43, 65],
      [0, 44, -104],
      [0, 44, 104],
      [92, 43, -65],
      [112, 42, 0],
      [92, 43, 65],
    ];
    for (const [x, y, z] of cannonPositions) {
      const cannon = buildFortCannon(this.group, new THREE.Vector3(x, y, z), this.cannons.length + 1);
      this.cannons.push(cannon);
    }
  }

  activeCannons() {
    return this.cannons.filter((cannon) => !cannon.destroyed);
  }

  update(dt) {
    const player = this.getPlayerTarget();
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
