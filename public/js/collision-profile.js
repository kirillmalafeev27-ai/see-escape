import * as THREE from "three";

export const COLLISION_PROFILE_STORAGE_KEY = "ocean-sandbox-applied-collision-profile-v2";
export const COLLISION_DRAFT_STORAGE_KEY = "ocean-sandbox-collision-draft-v2";
export const DEFAULT_HOLD_COLLISION = Object.freeze({
  id: "floor-8",
  type: "floor",
  x: 0,
  y: 0.11394088310286499,
  z: -11.125052764836976,
  width: 14.9314368731822,
  height: 0.11999999731779099,
  depth: 71.9569540071893,
  yaw: 0,
});

const BUILT_IN_DEFAULT_PROFILE = {
  version: 2,
  units: "ship-local",
  note: "Collision overrides applied on top of the actual game colliders.",
  disabledSourceIds: [
    "source:solid:stylship_wheelstand_mat_stylship_elements_0:1",
    "source:solid:stylship_cannon3_mat_stylship_props_0:6",
    "source:solid:stylship_cannon3_mat_stylship_props_0:12",
    "source:walkable:holddoorwaystairsthreshold:1",
    "source:walkable:stylship_floorbackbottom_mat_stylship_decks_0:1",
  ],
  objects: [
    { id: "floor-1", type: "floor", x: -7.815, y: 6.742, z: -34.635, width: 1.951, height: 0.12, depth: 21.683, yaw: 0 },
    { id: "floor-2", type: "floor", x: 0.031, y: 10.452, z: 14.305, width: 17.093, height: 0.05, depth: 19.568, yaw: 0 },
    { id: "floor-3", type: "floor", x: 0, y: 15.902, z: -34.743, width: 17.242, height: 0.12, depth: 25.661, yaw: 0 },
    { id: "floor-7", type: "floor", x: 0, y: 10.426, z: 16.258, width: 17.093, height: 0.12, depth: 25.133, yaw: 0 },
    DEFAULT_HOLD_COLLISION,
    { id: "floor-9", type: "floor", x: 0, y: 6.414, z: -24.184, width: 4.591, height: 0.12, depth: 10.155, yaw: 0 },
    { id: "floor-4", type: "floor", x: 0, y: 6.477, z: -8.6, width: 17.942, height: 0.3, depth: 26.1, yaw: 0 },
    { id: "floor-5", type: "floor", x: 1, y: 6.066, z: -36.65, width: 13.678, height: 0.12, depth: 19.278, yaw: 0 },
  ],
};

const INVISIBLE_MATERIAL = () =>
  new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slug(value) {
  return String(value || "unnamed")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "unnamed";
}

export function emptyCollisionProfile() {
  return {
    version: 2,
    units: "ship-local",
    note: "Collision overrides applied on top of the actual game colliders.",
    disabledSourceIds: [],
    objects: [],
  };
}

export function defaultCollisionProfile() {
  return clone(BUILT_IN_DEFAULT_PROFILE);
}

export function normalizeCollisionProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  const disabledSourceIds = Array.isArray(source.disabledSourceIds)
    ? [...new Set(source.disabledSourceIds.map((id) => String(id)))]
    : [];
  const objects = Array.isArray(source.objects)
    ? source.objects
      .filter((item) => ["floor", "ramp", "hole", "wall", "pillar"].includes(item?.type))
      .map((item, index) => {
        const base = { ...item, id: String(item.id || `${item.type}-${index + 1}`), type: item.type };
        if (item.type === "ramp") {
          return {
            ...base,
            x: num(item.x),
            startY: num(item.startY),
            startZ: num(item.startZ),
            endY: num(item.endY),
            endZ: num(item.endZ),
            width: Math.max(0.05, num(item.width, 2)),
            thickness: Math.max(0.05, num(item.thickness, 0.15)),
            yaw: num(item.yaw),
          };
        }
        if (item.type === "pillar") {
          return {
            ...base,
            x: num(item.x),
            y: num(item.y),
            z: num(item.z),
            radius: Math.max(0.05, num(item.radius, 0.5)),
            height: Math.max(0.05, num(item.height, 2)),
          };
        }
        return {
          ...base,
          x: num(item.x),
          y: num(item.y),
          z: num(item.z),
          width: Math.max(0.05, num(item.width, 2)),
          height: Math.max(0.05, num(item.height, 0.15)),
          depth: Math.max(0.05, num(item.depth, 2)),
          yaw: num(item.yaw),
        };
      })
    : [];
  return {
    version: 2,
    units: "ship-local",
    note: String(source.note || emptyCollisionProfile().note),
    disabledSourceIds,
    objects,
  };
}

export function loadAppliedCollisionProfile() {
  try {
    const saved = localStorage.getItem(COLLISION_PROFILE_STORAGE_KEY);
    return saved ? normalizeCollisionProfile(JSON.parse(saved)) : defaultCollisionProfile();
  } catch {
    return defaultCollisionProfile();
  }
}

export function saveAppliedCollisionProfile(profile) {
  const normalized = normalizeCollisionProfile(profile);
  localStorage.setItem(COLLISION_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearAppliedCollisionProfile() {
  localStorage.removeItem(COLLISION_PROFILE_STORAGE_KEY);
  localStorage.removeItem("ocean-sandbox-applied-collision-profile-v1");
}

export function enumerateSourceColliders(ship) {
  ship.group.updateMatrixWorld(true);
  const refs = [];
  const seen = new Set();
  const counts = new Map();

  function append(mesh, kind) {
    if (!mesh?.isMesh || seen.has(mesh)) return;
    seen.add(mesh);
    const base = `${kind}:${slug(mesh.name)}`;
    const serial = (counts.get(base) || 0) + 1;
    counts.set(base, serial);
    const id = `source:${base}:${serial}`;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    refs.push({
      id,
      kind,
      name: mesh.name || "unnamed",
      mesh,
      box,
      size,
      center,
    });
  }

  for (const mesh of ship.walkableMeshes || []) append(mesh, "walkable");
  for (const mesh of ship.solidMeshes || []) append(mesh, "solid");
  return refs;
}

function yawRadians(item) {
  return THREE.MathUtils.degToRad(num(item.yaw));
}

export function pointInsideCollisionHole(point, holes) {
  return (holes || []).some((item) => {
    const dx = point.x - item.x;
    const dz = point.z - item.z;
    const yaw = yawRadians(item);
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const localX = cosine * dx - sine * dz;
    const localZ = sine * dx + cosine * dz;
    return (
      Math.abs(point.y - item.y) <= Math.max(0.8, item.height + 0.35) &&
      Math.abs(localX) <= item.width / 2 &&
      Math.abs(localZ) <= item.depth / 2
    );
  });
}

function makeBox(item, root, name) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(item.width, item.height, item.depth),
    INVISIBLE_MATERIAL()
  );
  mesh.name = name;
  mesh.position.set(item.x, item.y + item.height / 2, item.z);
  mesh.rotation.y = yawRadians(item);
  root.add(mesh);
  return mesh;
}

function makeRamp(item, root) {
  const run = item.endZ - item.startZ;
  const rise = item.endY - item.startY;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(item.width, item.thickness, Math.max(0.05, Math.hypot(run, rise))),
    INVISIBLE_MATERIAL()
  );
  mesh.name = `CollisionOverride_${item.id}_StairsRamp`;
  mesh.position.set(item.x, (item.startY + item.endY) / 2 - item.thickness / 2, (item.startZ + item.endZ) / 2);
  mesh.rotation.order = "YXZ";
  mesh.rotation.set(-Math.atan2(rise, run), yawRadians(item), 0);
  mesh.userData.lowLanding = [item.x, item.startY, item.startZ];
  mesh.userData.highLanding = [item.x, item.endY, item.endZ];
  root.add(mesh);
  return mesh;
}

function makePillar(item, root) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(item.radius, item.radius, item.height, 16),
    INVISIBLE_MATERIAL()
  );
  mesh.name = `CollisionOverride_${item.id}_Pillar`;
  mesh.position.set(item.x, item.y + item.height / 2, item.z);
  root.add(mesh);
  return mesh;
}

export function applyCollisionProfile(ship, value, { sourceRefs = null, stairZones = null } = {}) {
  const profile = normalizeCollisionProfile(value);
  const refs = sourceRefs || enumerateSourceColliders(ship);
  const disabled = new Set(profile.disabledSourceIds);
  const baseWalkable = refs.filter((ref) => ref.kind === "walkable" && !disabled.has(ref.id)).map((ref) => ref.mesh);
  const baseSolid = refs.filter((ref) => ref.kind === "solid" && !disabled.has(ref.id)).map((ref) => ref.mesh);
  ship.walkableMeshes.splice(0, ship.walkableMeshes.length, ...baseWalkable);
  ship.solidMeshes.splice(0, ship.solidMeshes.length, ...baseSolid);
  if (stairZones) ship.stairZones.splice(0, ship.stairZones.length, ...stairZones);

  ship.collisionOverrideRoot?.removeFromParent();
  const root = new THREE.Group();
  root.name = "CollisionOverrides";
  ship.group.add(root);
  ship.collisionOverrideRoot = root;
  ship.collisionHoles = profile.objects.filter((item) => item.type === "hole").map(clone);

  for (const item of profile.objects) {
    if (item.type === "floor") {
      const mesh = makeBox({ ...item, y: item.y - item.height }, root, `CollisionOverride_${item.id}_Floor`);
      ship.walkableMeshes.push(mesh);
    } else if (item.type === "ramp") {
      const mesh = makeRamp(item, root);
      ship.walkableMeshes.push(mesh);
      const box = new THREE.Box3().setFromObject(mesh);
      box.expandByVector(new THREE.Vector3(0.8, 1.2, 1.8));
      ship.stairZones.push(box);
    } else if (item.type === "wall") {
      ship.solidMeshes.push(makeBox(item, root, `CollisionOverride_${item.id}_Wall`));
    } else if (item.type === "pillar") {
      ship.solidMeshes.push(makePillar(item, root));
    }
  }
  root.updateMatrixWorld(true);
  return { profile, sourceRefs: refs, root };
}

export function approximateSourceCollider(ref, id) {
  const { box, size, center } = ref;
  if (ref.kind === "walkable") {
    const low = ref.mesh.userData.lowLanding;
    const high = ref.mesh.userData.highLanding;
    if (/_StairsRamp$/i.test(ref.name) && low && high) {
      return {
        id,
        type: "ramp",
        x: (low[0] + high[0]) / 2,
        startY: low[1],
        startZ: low[2],
        endY: high[1],
        endZ: high[2],
        width: Math.max(0.05, size.x),
        thickness: 0.16,
        yaw: 0,
      };
    }
    return {
      id,
      type: "floor",
      x: center.x,
      y: box.max.y,
      z: center.z,
      width: Math.max(0.05, size.x),
      height: Math.max(0.05, Math.min(size.y, 0.3)),
      depth: Math.max(0.05, size.z),
      yaw: 0,
    };
  }
  if (/TrunkCollider$/i.test(ref.name)) {
    return {
      id,
      type: "pillar",
      x: center.x,
      y: box.min.y,
      z: center.z,
      radius: Math.max(0.05, Math.max(size.x, size.z) / 2),
      height: Math.max(0.05, size.y),
    };
  }
  return {
    id,
    type: "wall",
    x: center.x,
    y: box.min.y,
    z: center.z,
    width: Math.max(0.05, size.x),
    height: Math.max(0.05, size.y),
    depth: Math.max(0.05, size.z),
    yaw: 0,
  };
}
