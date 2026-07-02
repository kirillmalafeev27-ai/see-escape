import * as THREE from "three";

const PICKUP_RADIUS = 58;
const HARPOON_RADIUS = 360;
const HARPOON_PULL_SPEED = 115;

function mat(color, roughness = 0.82, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function buildChest() {
  const root = new THREE.Group();
  root.name = "FloatingTreasureChest";
  const wood = mat(0x8a4d24, 0.86);
  const gold = mat(0xe1b64c, 0.4, 0.55);
  const dark = mat(0x432313, 0.92);
  const base = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.7, 3.5), wood);
  base.position.y = 1.5;
  root.add(base);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.2, 3.7), dark);
  lid.position.y = 3.35;
  root.add(lid);
  for (const x of [-2.05, 0, 2.05]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.2, 3.9), gold);
    band.position.set(x, 2.1, 0);
    root.add(band);
  }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.05, 0.28), gold);
  lock.position.set(0, 2.25, 1.9);
  root.add(lock);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(4.2, 5.2, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd45c, transparent: true, opacity: 0.62, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.18;
  root.add(ring);
  return { root, ring };
}

export class TreasureSystem {
  constructor(scene, sampleWaveHeight, onCollect) {
    this.scene = scene;
    this.sampleWaveHeight = sampleWaveHeight;
    this.onCollect = onCollect || (() => {});
    this.list = [];
    this.nextId = 1;
  }

  _createTreasure(position, options = {}) {
    const built = buildChest();
    built.root.position.copy(position);
    built.root.position.y = this.sampleWaveHeight(position.x, position.z) + 0.55;
    this.scene.add(built.root);
    const treasure = {
      ...built,
      id: String(options.id || `treasure-${this.nextId++}`),
      phase: Number.isFinite(options.phase) ? options.phase : Math.random() * Math.PI * 2,
      rope: null,
    };
    this.list.push(treasure);
    return treasure;
  }

  spawn(position) {
    return this._createTreasure(position)?.id || "";
  }

  _ensureRope(treasure) {
    if (treasure.rope) return treasure.rope;
    const rope = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffd45c, transparent: true, opacity: 0.85 })
    );
    rope.frustumCulled = false;
    this.scene.add(rope);
    treasure.rope = rope;
    return rope;
  }

  _removeTreasure(index) {
    const treasure = this.list[index];
    if (treasure.rope) this.scene.remove(treasure.rope);
    this.scene.remove(treasure.root);
    this.list.splice(index, 1);
    this.onCollect({
      id: treasure.id,
      position: treasure.root.position.clone(),
    });
  }

  clear() {
    for (const treasure of this.list) {
      if (treasure.rope) this.scene.remove(treasure.rope);
      this.scene.remove(treasure.root);
    }
    this.list = [];
  }

  snapshot() {
    return this.list.map((treasure) => ({
      id: treasure.id,
      position: {
        x: treasure.root.position.x,
        y: treasure.root.position.y,
        z: treasure.root.position.z,
      },
      phase: treasure.phase,
    }));
  }

  syncFromSnapshot(items = []) {
    if (!Array.isArray(items)) return;
    const incomingIds = new Set(items.map((item) => String(item?.id || "")).filter(Boolean));
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (incomingIds.has(this.list[i].id)) continue;
      const treasure = this.list[i];
      if (treasure.rope) this.scene.remove(treasure.rope);
      this.scene.remove(treasure.root);
      this.list.splice(i, 1);
    }
    for (const item of items) {
      const id = String(item?.id || "");
      const pos = item?.position || {};
      if (!id || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
      let treasure = this.list.find((entry) => entry.id === id);
      if (!treasure) {
        treasure = this._createTreasure(new THREE.Vector3(pos.x, pos.y, pos.z), {
          id,
          phase: Number(item.phase) || 0,
        });
      }
      treasure.root.position.set(pos.x, pos.y, pos.z);
      if (Number.isFinite(item.phase)) treasure.phase = item.phase;
    }
  }

  update(dt, playerPosition, { harpoon = false, pullTarget = playerPosition } = {}) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const treasure = this.list[i];
      const distance = treasure.root.position.distanceTo(playerPosition);
      if (harpoon && distance <= HARPOON_RADIUS) {
        const toTarget = pullTarget.clone().sub(treasure.root.position);
        toTarget.y = 0;
        if (toTarget.lengthSq() > 1e-4) {
          treasure.root.position.addScaledVector(toTarget.normalize(), HARPOON_PULL_SPEED * dt);
        }
        const rope = this._ensureRope(treasure);
        rope.geometry.setFromPoints([
          pullTarget.clone().add(new THREE.Vector3(0, 5, 0)),
          treasure.root.position.clone().add(new THREE.Vector3(0, 2.2, 0)),
        ]);
        treasure.ring.material.color.setHex(0xff9f2d);
      } else if (treasure.rope) {
        this.scene.remove(treasure.rope);
        treasure.rope = null;
      }
      treasure.phase += dt;
      treasure.root.position.y =
        this.sampleWaveHeight(treasure.root.position.x, treasure.root.position.z) +
        0.55 +
        Math.sin(treasure.phase * 1.8) * 0.28;
      treasure.root.rotation.y += dt * 0.42;
      treasure.ring.rotation.z -= dt * 0.75;
      if (treasure.root.position.distanceTo(playerPosition) > PICKUP_RADIUS) continue;
      this._removeTreasure(i);
    }
  }
}
