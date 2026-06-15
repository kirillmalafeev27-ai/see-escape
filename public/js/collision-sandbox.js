import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { loadAndAnalyzeShip } from "./models.js?v=20260607-assets-fire-v1";
import { buildPlayerShip } from "./ship.js?v=20260607-cannon-layout-v1";
import { DamageControlSystem } from "./damage-control.js?v=20260609-remove-hold-helpers-v1";
import {
  CANNON_LAYOUT_DRAFT_STORAGE_KEY,
  applyCannonLayout,
  clearCannonLayout,
  loadCannonLayout,
  normalizeCannonLayout,
  saveCannonLayout,
  snapshotCannonLayout,
} from "./cannon-layout.js?v=20260609-default-profile-v2";
import {
  COLLISION_DRAFT_STORAGE_KEY,
  applyCollisionProfile,
  approximateSourceCollider,
  clearAppliedCollisionProfile,
  defaultCollisionProfile,
  enumerateSourceColliders,
  loadAppliedCollisionProfile,
  normalizeCollisionProfile,
  pointInsideCollisionHole,
  saveAppliedCollisionProfile,
} from "./collision-profile.js?v=20260609-remove-hold-helpers-v1";

const PLAYER_RADIUS = 0.62;
const PLAYER_HEIGHT = 2.05;
const WALK_SPEED = 8;
const FLY_SPEED = 18;
const GRAVITY = 22;
const JUMP_SPEED = 8.5;
const STEP_UP = 1.35;
const STEP_DOWN = 2.8;
const BODY_HEIGHTS = [0.7, 1.7];
const SOURCE_COLORS = { walkable: 0x52d273, solid: 0x65b9ff };
const COLORS = {
  floor: 0x52d273,
  ramp: 0xffd166,
  hole: 0xff5c6c,
  wall: 0x65b9ff,
  pillar: 0xc17cff,
  cannon: 0xff9d42,
};
const TYPE_NAMES = {
  floor: "пол",
  ramp: "наклон",
  hole: "отверстие",
  wall: "стена",
  pillar: "колонна",
};
const DOWN = new THREE.Vector3(0, -1, 0);

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const rows = $("object-rows");
const fields = $("fields");
const json = $("json");
const status = $("status");
const crosshair = $("crosshair");
const modeHint = $("mode-hint");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07131d);
scene.fog = new THREE.Fog(0x07131d, 80, 170);
const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 300);
camera.rotation.order = "YXZ";
camera.position.set(38, 34, 45);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = "fixed";
labelRenderer.domElement.style.inset = "0";
labelRenderer.domElement.style.pointerEvents = "none";
viewport.appendChild(labelRenderer.domElement);

scene.add(new THREE.HemisphereLight(0xbcecff, 0x10202a, 1.5));
const grid = new THREE.GridHelper(140, 70, 0x457f95, 0x173746);
scene.add(grid);
scene.add(new THREE.AxesHelper(12));

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 12, -10);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

const transform = new TransformControls(camera, renderer.domElement);
transform.setMode("translate");
scene.add(transform);

const sourceRoot = new THREE.Group();
sourceRoot.name = "ActualGameCollisionPreview";
scene.add(sourceRoot);
const overrideRoot = new THREE.Group();
overrideRoot.name = "EditableCollisionOverrides";
scene.add(overrideRoot);
const cannonRoot = new THREE.Group();
cannonRoot.name = "EditableCannonPositions";
scene.add(cannonRoot);

const avatar = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 14),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
);
body.position.y = PLAYER_HEIGHT / 2;
avatar.add(body);
const head = new THREE.Mesh(
  new THREE.SphereGeometry(PLAYER_RADIUS, 14, 9),
  new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9 })
);
head.position.y = PLAYER_HEIGHT - PLAYER_RADIUS;
avatar.add(head);
scene.add(avatar);

let config = loadWorkingProfile();
let cannonLayout = loadWorkingCannonLayout();
let liveShip = null;
let sourceRefs = [];
let sourceEntries = new Map();
let overrideEntries = new Map();
let cannonEntries = new Map();
let sourceSelectables = [];
let overrideSelectables = [];
let cannonSelectables = [];
let defaultStairZones = [];
let defaultCannonLayout = null;
let selectedKey = null;
let mode = "edit";
let transformMode = "translate";
let serial = 1;
let draggingTransform = false;
let lastSupport = null;
const keys = {};
const pointer = new THREE.Vector2();
const pickRay = new THREE.Raycaster();
const collisionRay = new THREE.Raycaster();
const clock = new THREE.Clock();
const fly = { position: new THREE.Vector3(28, 24, 34), yaw: -2.45, pitch: -0.28 };
const walk = {
  position: new THREE.Vector3(0, 14, -6),
  velocityY: 0,
  grounded: false,
  yaw: Math.PI,
  pitch: -0.08,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function yawRadians(item) {
  return THREE.MathUtils.degToRad(num(item.yaw));
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
    else child.material?.dispose?.();
    if (child.isCSS2DObject) child.element.remove();
  });
}

function clearRoot(root) {
  for (const child of [...root.children]) {
    root.remove(child);
    disposeObject(child);
  }
}

function loadWorkingProfile() {
  try {
    const saved = localStorage.getItem(COLLISION_DRAFT_STORAGE_KEY);
    if (saved) return normalizeCollisionProfile(JSON.parse(saved));
  } catch {}
  return loadAppliedCollisionProfile();
}

function loadWorkingCannonLayout() {
  const draft = loadCannonLayout(CANNON_LAYOUT_DRAFT_STORAGE_KEY);
  return draft.cannons.length ? draft : loadCannonLayout();
}

function cannonSelectKey(id) {
  return `cannon:${id}`;
}

function cannonIdFromKey(key) {
  return String(key || "").startsWith("cannon:") ? String(key).slice(7) : "";
}

function uniqueId(type) {
  while (config.objects.some((item) => item.id === `${type}-${serial}`)) serial++;
  return `${type}-${serial++}`;
}

function itemCenter(item) {
  if (item.type === "ramp") {
    return { x: item.x, y: (item.startY + item.endY) / 2 - item.thickness / 2, z: (item.startZ + item.endZ) / 2 };
  }
  if (item.type === "floor") return { x: item.x, y: item.y - item.height / 2, z: item.z };
  if (item.type === "hole") return { x: item.x, y: item.y + item.height / 2, z: item.z };
  return { x: item.x, y: item.y + item.height / 2, z: item.z };
}

function geometryFor(item) {
  if (item.type === "pillar") {
    return new THREE.CylinderGeometry(Math.max(0.05, item.radius), Math.max(0.05, item.radius), Math.max(0.05, item.height), 18);
  }
  if (item.type === "ramp") {
    const length = Math.hypot(item.endZ - item.startZ, item.endY - item.startY);
    return new THREE.BoxGeometry(Math.max(0.05, item.width), Math.max(0.05, item.thickness), Math.max(0.05, length));
  }
  return new THREE.BoxGeometry(Math.max(0.05, item.width), Math.max(0.05, item.height), Math.max(0.05, item.depth));
}

function labelText(item) {
  if (item.type === "ramp") {
    return `${item.id} · ramp x=${round(item.x)} z=${round(item.startZ)}→${round(item.endZ)} y=${round(item.startY)}→${round(item.endY)} w=${round(item.width)} yaw=${round(item.yaw)}°`;
  }
  if (item.type === "pillar") {
    return `${item.id} · pillar x=${round(item.x)} y=${round(item.y)} z=${round(item.z)} r=${round(item.radius)} h=${round(item.height)}`;
  }
  return `${item.id} · ${item.type} x=${round(item.x)} y=${round(item.y)} z=${round(item.z)} w=${round(item.width)} h=${round(item.height)} d=${round(item.depth)} yaw=${round(item.yaw)}°`;
}

function addLabel(group, text, y = 0.7) {
  const element = document.createElement("div");
  element.className = "collision-label";
  element.textContent = text;
  const label = new CSS2DObject(element);
  label.position.set(0, y, 0);
  group.add(label);
  return label;
}

function buildSourcePreview() {
  clearRoot(sourceRoot);
  sourceEntries = new Map();
  sourceSelectables = [];
  if (!liveShip) return;
  liveShip.group.updateMatrixWorld(true);
  const inverseShip = liveShip.group.matrixWorld.clone().invert();
  const disabled = new Set(config.disabledSourceIds);
  for (const ref of sourceRefs) {
    ref.mesh.updateWorldMatrix(true, false);
    const geometry = ref.mesh.geometry.clone();
    geometry.applyMatrix4(inverseShip.clone().multiply(ref.mesh.matrixWorld));
    const isDisabled = disabled.has(ref.id);
    const material = new THREE.MeshBasicMaterial({
      color: isDisabled ? 0xff5c6c : SOURCE_COLORS[ref.kind],
      transparent: true,
      opacity: isDisabled ? 0.08 : 0.13,
      wireframe: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = ref.id;
    mesh.userData.selectKey = ref.id;
    sourceRoot.add(mesh);
    sourceSelectables.push(mesh);
    sourceEntries.set(ref.id, { ref, mesh });
  }
}

function buildOverrideEntry(item) {
  const group = new THREE.Group();
  group.name = item.id;
  group.userData.selectKey = item.id;
  const center = itemCenter(item);
  group.position.set(center.x, center.y, center.z);
  group.rotation.order = "YXZ";
  if (item.type === "ramp") {
    group.rotation.set(-Math.atan2(item.endY - item.startY, item.endZ - item.startZ), yawRadians(item), 0);
  } else {
    group.rotation.y = yawRadians(item);
  }
  const fill = new THREE.Mesh(
    geometryFor(item),
    new THREE.MeshBasicMaterial({
      color: COLORS[item.type],
      transparent: true,
      opacity: item.type === "hole" ? 0.36 : 0.24,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  fill.userData.selectKey = item.id;
  group.add(fill);
  overrideSelectables.push(fill);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(fill.geometry),
    new THREE.LineBasicMaterial({ color: COLORS[item.type], transparent: true, opacity: 0.98 })
  );
  group.add(edges);
  addLabel(group, labelText(item), Math.max(0.45, item.height || item.thickness || 0.2) / 2 + 0.4);
  overrideRoot.add(group);
  overrideEntries.set(item.id, { item, group, fill });
}

function rebuildOverridePreview() {
  transform.detach();
  clearRoot(overrideRoot);
  overrideEntries = new Map();
  overrideSelectables = [];
  for (const item of config.objects) buildOverrideEntry(item);
}

function mergeCannonLayoutWithDefaults(layout = cannonLayout) {
  const current = normalizeCannonLayout(layout);
  if (!defaultCannonLayout) return current;
  const byId = new Map(current.cannons.map((item) => [item.id, item]));
  return normalizeCannonLayout({
    cannons: defaultCannonLayout.cannons.map((fallback) => ({ ...fallback, ...(byId.get(fallback.id) || {}) })),
  });
}

function buildCannonPreview() {
  clearRoot(cannonRoot);
  cannonEntries = new Map();
  cannonSelectables = [];
  if (!liveShip?.cannons?.length) return;
  const byId = new Map(liveShip.cannons.map((cannon) => [cannon.id, cannon]));
  const material = new THREE.MeshBasicMaterial({
    color: COLORS.cannon,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.cannon, transparent: true, opacity: 0.95 });
  for (const item of cannonLayout.cannons) {
    const cannon = byId.get(item.id);
    const group = new THREE.Group();
    group.name = `Editable_${item.id}`;
    group.userData.selectKey = cannonSelectKey(item.id);
    group.position.set(item.x, item.y, item.z);
    group.rotation.y = (cannon?.baseYaw ?? 0) - Math.PI / 2;

    const carriage = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.2, 2.5), material.clone());
    carriage.position.set(-0.35, 0.65, 0);
    carriage.userData.selectKey = group.userData.selectKey;
    group.add(carriage);
    cannonSelectables.push(carriage);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.72, 6.2, 12), material.clone());
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(1.8, 1.7, 0);
    barrel.userData.selectKey = group.userData.selectKey;
    group.add(barrel);
    cannonSelectables.push(barrel);

    for (const mesh of [carriage, barrel]) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial.clone());
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      group.add(edges);
    }
    addLabel(group, `${item.id} · cannon x=${round(item.x)} y=${round(item.y)} z=${round(item.z)}`, 3.1);
    cannonRoot.add(group);
    cannonEntries.set(group.userData.selectKey, { item, cannon, group });
  }
}

function rebuildLiveCollision(nextSelection = selectedKey) {
  if (!liveShip) return;
  applyCollisionProfile(liveShip, config, { sourceRefs, stairZones: defaultStairZones });
  cannonLayout = mergeCannonLayoutWithDefaults(cannonLayout);
  applyCannonLayout(liveShip, cannonLayout);
  liveShip.group.updateMatrixWorld(true);
  rebuildOverridePreview();
  buildCannonPreview();
  buildSourcePreview();
  renderTable();
  updateJson();
  selectItem(nextSelection);
}

function addCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

function refSummary(ref) {
  return {
    id: ref.id,
    kind: ref.kind,
    name: ref.name,
    center: { x: round(ref.center.x, 3), y: round(ref.center.y, 3), z: round(ref.center.z, 3) },
    size: { x: round(ref.size.x, 3), y: round(ref.size.y, 3), z: round(ref.size.z, 3) },
  };
}

function renderTable() {
  rows.replaceChildren();
  const disabled = new Set(config.disabledSourceIds);
  for (const ref of sourceRefs) {
    const tr = document.createElement("tr");
    if (ref.id === selectedKey) tr.classList.add("selected");
    addCell(tr, ref.id);
    addCell(tr, `игровой ${ref.kind === "walkable" ? "проход" : "барьер"}`);
    addCell(tr, `${round(ref.center.x)}, ${round(ref.center.y)}, ${round(ref.center.z)}`);
    addCell(tr, `${round(ref.size.x)} × ${round(ref.size.y)} × ${round(ref.size.z)}`);
    addCell(tr, disabled.has(ref.id) ? "выключен правкой" : "активен");
    tr.addEventListener("click", () => selectItem(ref.id));
    rows.appendChild(tr);
  }
  for (const item of config.objects) {
    const tr = document.createElement("tr");
    if (item.id === selectedKey) tr.classList.add("selected");
    const pos = item.type === "ramp"
      ? `${round(item.x)}, ${round(item.startY)}, ${round(item.startZ)}`
      : `${round(item.x)}, ${round(item.y)}, ${round(item.z)}`;
    const size = item.type === "ramp"
      ? `w=${round(item.width)} y=${round(item.startY)}→${round(item.endY)} z=${round(item.startZ)}→${round(item.endZ)} yaw=${round(item.yaw)}°`
      : item.type === "pillar"
        ? `r=${round(item.radius)} h=${round(item.height)}`
        : `${round(item.width)} × ${round(item.height)} × ${round(item.depth)} yaw=${round(item.yaw)}°`;
    addCell(tr, item.id);
    addCell(tr, TYPE_NAMES[item.type]);
    addCell(tr, pos);
    addCell(tr, size);
    addCell(tr, "редактируемая правка");
    tr.addEventListener("click", () => selectItem(item.id));
    rows.appendChild(tr);
  }
  for (const item of cannonLayout.cannons) {
    const key = cannonSelectKey(item.id);
    const tr = document.createElement("tr");
    if (key === selectedKey) tr.classList.add("selected");
    addCell(tr, item.id);
    addCell(tr, "пушка");
    addCell(tr, `${round(item.x)}, ${round(item.y)}, ${round(item.z)}`);
    addCell(tr, "позиция монтировки");
    addCell(tr, "редактируется отдельно от коллизий");
    tr.addEventListener("click", () => selectItem(key));
    rows.appendChild(tr);
  }
}

function schemaFor(item) {
  if (item.type === "ramp") return ["x", "startY", "startZ", "endY", "endZ", "width", "thickness", "yaw"];
  if (item.type === "pillar") return ["x", "y", "z", "radius", "height"];
  return ["x", "y", "z", "width", "height", "depth", "yaw"];
}

function renderInspector() {
  fields.replaceChildren();
  const ref = sourceRefs.find((candidate) => candidate.id === selectedKey);
  if (ref) {
    const disabled = config.disabledSourceIds.includes(ref.id);
    const summary = document.createElement("div");
    summary.style.gridColumn = "1 / -1";
    summary.textContent = `${ref.name} · ${ref.kind} · center ${round(ref.center.x)}, ${round(ref.center.y)}, ${round(ref.center.z)} · size ${round(ref.size.x)} × ${round(ref.size.y)} × ${round(ref.size.z)}`;
    fields.appendChild(summary);
    const toggle = document.createElement("button");
    toggle.textContent = disabled ? "Включить исходный меш" : "Выключить исходный меш";
    toggle.addEventListener("click", () => toggleSelectedSource());
    fields.appendChild(toggle);
    const approximate = document.createElement("button");
    approximate.textContent = "Создать редактируемую копию";
    approximate.addEventListener("click", () => duplicateSelected());
    fields.appendChild(approximate);
    return;
  }

  const cannonEntry = cannonEntries.get(selectedKey);
  if (cannonEntry) {
    const item = cannonEntry.item;
    const summary = document.createElement("div");
    summary.style.gridColumn = "1 / -1";
    summary.textContent = `${item.name || item.id} · cannon mount`;
    fields.appendChild(summary);
    for (const key of ["x", "y", "z"]) {
      const label = document.createElement("label");
      label.innerHTML = `<span>${key}</span>`;
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.value = item[key] ?? 0;
      input.addEventListener("change", () => {
        item[key] = num(input.value, item[key] ?? 0);
        rebuildLiveCollision(selectedKey);
      });
      label.appendChild(input);
      fields.appendChild(label);
    }
    const reset = document.createElement("button");
    reset.textContent = "Вернуть эту пушку по дефолту";
    reset.addEventListener("click", () => {
      const fallback = defaultCannonLayout?.cannons.find((candidate) => candidate.id === item.id);
      if (!fallback) return;
      Object.assign(item, clone(fallback));
      rebuildLiveCollision(selectedKey);
    });
    fields.appendChild(reset);
    return;
  }

  const item = config.objects.find((candidate) => candidate.id === selectedKey);
  if (!item) {
    fields.textContent = "Выберите реальный игровой меш или редактируемую правку.";
    return;
  }
  const idLabel = document.createElement("label");
  idLabel.innerHTML = "<span>ID</span>";
  const idInput = document.createElement("input");
  idInput.value = item.id;
  idInput.addEventListener("change", () => {
    const nextId = idInput.value.trim();
    if (!nextId || sourceEntries.has(nextId) || config.objects.some((candidate) => candidate !== item && candidate.id === nextId)) {
      idInput.value = item.id;
      return;
    }
    item.id = nextId;
    selectedKey = nextId;
    rebuildLiveCollision(nextId);
  });
  idLabel.appendChild(idInput);
  fields.appendChild(idLabel);

  for (const key of schemaFor(item)) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${key}</span>`;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.value = item[key] ?? 0;
    input.addEventListener("change", () => {
      item[key] = num(input.value, item[key] ?? 0);
      rebuildLiveCollision(item.id);
    });
    label.appendChild(input);
    fields.appendChild(label);
  }
}

function selectItem(key) {
  selectedKey = sourceEntries.has(key) || overrideEntries.has(key) || cannonEntries.has(key) ? key : null;
  for (const [id, entry] of sourceEntries) {
    entry.mesh.material.opacity = id === selectedKey ? 0.66 : config.disabledSourceIds.includes(id) ? 0.08 : 0.13;
  }
  for (const [id, entry] of overrideEntries) {
    entry.fill.material.opacity = id === selectedKey ? 0.64 : entry.item.type === "hole" ? 0.36 : 0.24;
  }
  for (const [id, entry] of cannonEntries) {
    entry.group.traverse((child) => {
      if (child.isMesh && child.material?.opacity !== undefined) child.material.opacity = id === selectedKey ? 0.72 : 0.38;
    });
  }
  transform.detach();
  const entry = overrideEntries.get(selectedKey) || cannonEntries.get(selectedKey);
  if (entry && mode === "edit") transform.attach(entry.group);
  renderTable();
  renderInspector();
}

function commitTransform() {
  const cannonEntry = cannonEntries.get(selectedKey);
  if (cannonEntry) {
    cannonEntry.item.x = round(cannonEntry.group.position.x, 3);
    cannonEntry.item.y = round(cannonEntry.group.position.y, 3);
    cannonEntry.item.z = round(cannonEntry.group.position.z, 3);
    rebuildLiveCollision(selectedKey);
    return;
  }
  const entry = overrideEntries.get(selectedKey);
  if (!entry) return;
  const item = entry.item;
  const start = itemCenter(item);
  const dx = entry.group.position.x - start.x;
  const dy = entry.group.position.y - start.y;
  const dz = entry.group.position.z - start.z;
  const sx = Math.max(0.05, Math.abs(entry.group.scale.x));
  const sy = Math.max(0.05, Math.abs(entry.group.scale.y));
  const sz = Math.max(0.05, Math.abs(entry.group.scale.z));
  if (item.type === "ramp") {
    const middleZ = (item.startZ + item.endZ) / 2 + dz;
    const halfRun = Math.abs(item.endZ - item.startZ) * sz / 2;
    const direction = Math.sign(item.endZ - item.startZ) || 1;
    item.x += dx;
    item.startY += dy;
    item.endY += dy;
    item.startZ = middleZ - direction * halfRun;
    item.endZ = middleZ + direction * halfRun;
    item.width *= sx;
    item.thickness *= sy;
  } else {
    item.x += dx;
    item.y += dy;
    item.z += dz;
    if (item.type === "pillar") {
      item.radius *= Math.max(sx, sz);
      item.height *= sy;
    } else {
      item.width *= sx;
      item.height *= sy;
      item.depth *= sz;
    }
  }
  if (item.type !== "pillar") item.yaw = round(THREE.MathUtils.radToDeg(entry.group.rotation.y), 3);
  rebuildLiveCollision(item.id);
}

function currentAnchor() {
  if (mode === "walk") return walk.position;
  if (mode === "fly") return fly.position;
  return orbit.target;
}

function addObject(type) {
  const anchor = currentAnchor();
  const x = round(anchor.x);
  const y = round(anchor.y);
  const z = round(anchor.z);
  const id = uniqueId(type);
  let item;
  if (type === "ramp") item = { id, type, x, startY: y, startZ: z - 2.5, endY: y + 2.2, endZ: z + 2.5, width: 3.4, thickness: 0.22, yaw: 0 };
  else if (type === "pillar") item = { id, type, x, y, z, radius: 0.8, height: 6 };
  else if (type === "wall") item = { id, type, x, y, z, width: 5, height: 4, depth: 0.4, yaw: 0 };
  else if (type === "hole") item = { id, type, x, y, z, width: 3, height: 0.12, depth: 3, yaw: 0 };
  else item = { id, type, x, y, z, width: 6, height: 0.22, depth: 6, yaw: 0 };
  config.objects.push(item);
  rebuildLiveCollision(id);
}

function toggleSelectedSource() {
  if (!sourceEntries.has(selectedKey)) return;
  if (config.disabledSourceIds.includes(selectedKey)) {
    config.disabledSourceIds = config.disabledSourceIds.filter((id) => id !== selectedKey);
  } else {
    config.disabledSourceIds.push(selectedKey);
  }
  rebuildLiveCollision(selectedKey);
}

function removeSelected() {
  const cannonEntry = cannonEntries.get(selectedKey);
  if (cannonEntry) {
    const fallback = defaultCannonLayout?.cannons.find((candidate) => candidate.id === cannonEntry.item.id);
    if (fallback) Object.assign(cannonEntry.item, clone(fallback));
    rebuildLiveCollision(selectedKey);
    return;
  }
  if (sourceEntries.has(selectedKey)) {
    toggleSelectedSource();
    return;
  }
  if (!overrideEntries.has(selectedKey)) return;
  config.objects = config.objects.filter((item) => item.id !== selectedKey);
  rebuildLiveCollision(null);
}

function duplicateSelected() {
  if (cannonEntries.has(selectedKey)) return;
  const ref = sourceRefs.find((candidate) => candidate.id === selectedKey);
  if (ref) {
    const item = approximateSourceCollider(ref, uniqueId(ref.kind === "walkable" ? "floor" : "wall"));
    config.objects.push(item);
    rebuildLiveCollision(item.id);
    return;
  }
  const item = config.objects.find((candidate) => candidate.id === selectedKey);
  if (!item) return;
  const copy = clone(item);
  copy.id = uniqueId(item.type);
  if ("x" in copy) copy.x += 1;
  if ("z" in copy) copy.z += 1;
  if ("startZ" in copy) {
    copy.startZ += 1;
    copy.endZ += 1;
  }
  config.objects.push(copy);
  rebuildLiveCollision(copy.id);
}

function exportedProfile() {
  const clean = normalizeCollisionProfile(config);
  clean.sourceSnapshot = sourceRefs.map(refSummary);
  clean.objects = clean.objects.map((item) => {
    const next = {};
    for (const [key, value] of Object.entries(item)) next[key] = typeof value === "number" ? round(value, 3) : value;
    return next;
  });
  clean.cannonLayout = normalizeCannonLayout(cannonLayout);
  clean.cannonLayout.cannons = clean.cannonLayout.cannons.map((item) => ({
    ...item,
    x: round(item.x, 3),
    y: round(item.y, 3),
    z: round(item.z, 3),
  }));
  return JSON.stringify(clean, null, 2);
}

function updateJson(force = false) {
  if (!force && document.activeElement === json) return;
  json.value = exportedProfile();
}

function setButtonFeedback(id, message, fallback) {
  const button = $(id);
  button.textContent = message;
  setTimeout(() => (button.textContent = fallback), 1400);
}

function cameraForward(yaw) {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}

function cameraRight(yaw) {
  return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
}

function movementVector(yaw, speed, dt) {
  const forward = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const side = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const move = cameraForward(yaw).multiplyScalar(forward).add(cameraRight(yaw).multiplyScalar(side));
  if (move.lengthSq()) move.normalize().multiplyScalar(speed * dt);
  return move;
}

function groundAt(position, stepUp = STEP_UP, stepDown = STEP_DOWN) {
  if (!liveShip) return null;
  collisionRay.set(new THREE.Vector3(position.x, position.y + stepUp + 0.05, position.z), DOWN);
  collisionRay.far = stepUp + stepDown + 0.1;
  const hits = collisionRay.intersectObjects(liveShip.walkableMeshes, false);
  for (const hit of hits) {
    if (pointInsideCollisionHole(hit.point, liveShip.collisionHoles)) continue;
    return { y: hit.point.y, name: hit.object.name || "unnamed" };
  }
  return null;
}

function movementBlocked(from, to) {
  if (!liveShip?.solidMeshes.length) return false;
  const move = to.clone().sub(from);
  move.y = 0;
  const distance = move.length();
  if (distance < 1e-5) return false;
  const direction = move.normalize();
  const side = new THREE.Vector3(-direction.z, 0, direction.x);
  for (const lateral of [-PLAYER_RADIUS, 0, PLAYER_RADIUS]) {
    for (const height of BODY_HEIGHTS) {
      const origin = new THREE.Vector3(from.x, from.y + height, from.z).addScaledVector(side, lateral);
      collisionRay.set(origin, direction);
      collisionRay.far = distance + PLAYER_RADIUS;
      if (collisionRay.intersectObjects(liveShip.solidMeshes, false).length) return true;
    }
  }
  return false;
}

function resetWalk() {
  walk.velocityY = 0;
  walk.grounded = false;
  const startY = (liveShip?.dims.deckY || 14) + 18;
  for (const z of [-6, 0, -12, 10]) {
    const probe = new THREE.Vector3(0, startY, z);
    const ground = groundAt(probe, 0.1, 80);
    if (!ground) continue;
    walk.position.set(0, ground.y, z);
    walk.grounded = true;
    lastSupport = ground;
    return;
  }
  walk.position.set(0, liveShip?.dims.deckY || 14, -6);
}

function updateWalk(dt) {
  const move = movementVector(walk.yaw, WALK_SPEED, dt);
  const candidate = walk.position.clone().add(move);
  const candidateGround = groundAt(candidate);
  if (!movementBlocked(walk.position, candidate)) {
    walk.position.x = candidate.x;
    walk.position.z = candidate.z;
    if (candidateGround && walk.grounded) walk.position.y = candidateGround.y;
  }
  const standing = groundAt(walk.position, 0.35, 0.65);
  if (standing && walk.velocityY <= 0) {
    walk.position.y = standing.y;
    walk.velocityY = 0;
    walk.grounded = true;
    lastSupport = standing;
  } else {
    const previousY = walk.position.y;
    walk.velocityY -= GRAVITY * dt;
    walk.position.y += walk.velocityY * dt;
    const landing = groundAt(new THREE.Vector3(walk.position.x, previousY, walk.position.z), 0.12, Math.max(0.45, previousY - walk.position.y + 0.2));
    if (landing && landing.y >= walk.position.y - 0.12 && walk.velocityY <= 0) {
      walk.position.y = landing.y;
      walk.velocityY = 0;
      walk.grounded = true;
      lastSupport = landing;
    } else {
      walk.grounded = false;
    }
  }
  if (walk.position.y < -16) resetWalk();
}

function updateFly(dt) {
  const speed = FLY_SPEED * (keys.ShiftLeft ? 2.1 : 1);
  fly.position.add(movementVector(fly.yaw, speed, dt));
  if (keys.Space) fly.position.y += speed * dt;
  if (keys.ControlLeft || keys.KeyQ) fly.position.y -= speed * dt;
}

function setMode(nextMode) {
  mode = nextMode;
  document.exitPointerLock?.();
  orbit.enabled = mode === "edit";
  avatar.visible = mode === "walk";
  crosshair.style.display = mode === "edit" ? "none" : "block";
  transform.detach();
  if (mode === "edit") {
    modeHint.textContent = "Редактирование: таблица или клик по мешу · манипулятор двигает, масштабирует или поворачивает правки";
    selectItem(selectedKey);
  } else if (mode === "walk") {
    resetWalk();
    modeHint.textContent = "Ходьба по актуальным игровым коллизиям: клик для мыши · WASD · Пробел прыжок";
  } else {
    modeHint.textContent = "Полёт бога: клик для мыши · WASD · Пробел вверх · Q/Ctrl вниз · Shift ускорение";
  }
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }
}

function updateCamera() {
  if (mode === "edit") {
    orbit.update();
    return;
  }
  const state = mode === "walk" ? walk : fly;
  const eye = mode === "walk" ? PLAYER_HEIGHT * 0.88 : 0;
  camera.position.set(state.position.x, state.position.y + eye, state.position.z);
  camera.rotation.set(state.pitch, state.yaw, 0);
}

function updateStatus() {
  const state = mode === "walk" ? walk : fly;
  const position = mode === "edit" ? orbit.target : state.position;
  status.textContent =
    `mode=${mode}\n` +
    `position x=${round(position.x)} y=${round(position.y)} z=${round(position.z)}\n` +
    `support=${lastSupport?.name || "none"}${lastSupport ? ` y=${round(lastSupport.y)}` : ""}\n` +
    `game-colliders=${sourceRefs.length} · overrides=${config.objects.length} · disabled=${config.disabledSourceIds.length}\n` +
    `selected=${selectedKey || "none"}`;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mode === "walk") updateWalk(dt);
  if (mode === "fly") updateFly(dt);
  avatar.position.copy(walk.position);
  updateCamera();
  updateStatus();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

async function initializeActualColliders() {
  status.textContent = "Загрузка реальных игровых коллизий...";
  try {
    const result = await loadAndAnalyzeShip("models/stylized_pirate_ship.glb", { targetLength: 96, flip: false });
    const ship = buildPlayerShip(result.dims, { cannonTemplate: result.cannonTemplate });
    ship.group.add(result.pivot);
    ship.group.add(result.navigationRoot);
    ship.modelPivot = result.pivot;
    ship.walkableMeshes = result.walkableMeshes;
    ship.stairZones = result.stairZones;
    ship.solidMeshes = [...result.solidMeshes, ...ship.cannonSolidMeshes];
    ship.snapCannonsToDeck(result.walkableMeshes);
    defaultCannonLayout = snapshotCannonLayout(ship.cannons);
    cannonLayout = mergeCannonLayoutWithDefaults(cannonLayout);
    applyCannonLayout(ship, cannonLayout);
    ship.hidePrimitives();
    new DamageControlSystem({
      scene: new THREE.Scene(),
      ship,
      effects: { waterFlow() {} },
      onMessage() {},
    });
    ship.group.updateMatrixWorld(true);
    liveShip = ship;
    sourceRefs = enumerateSourceColliders(ship);
    defaultStairZones = ship.stairZones.slice();
    rebuildLiveCollision(null);
    resetWalk();
  } catch (error) {
    console.error(error);
    status.textContent = `Не удалось собрать реальные коллизии: ${error.message}`;
  }
}

transform.addEventListener("dragging-changed", (event) => {
  draggingTransform = event.value;
  orbit.enabled = mode === "edit" && !event.value;
});
transform.addEventListener("mouseUp", commitTransform);

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (mode !== "edit" || draggingTransform) {
    if (mode !== "edit" && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  pickRay.setFromCamera(pointer, camera);
  const hit = pickRay.intersectObjects([...overrideSelectables, ...sourceSelectables, ...cannonSelectables], false)[0];
  if (hit?.object.userData.selectKey) selectItem(hit.object.userData.selectKey);
});

addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== renderer.domElement || mode === "edit") return;
  const state = mode === "walk" ? walk : fly;
  state.yaw -= event.movementX * 0.0023;
  state.pitch = THREE.MathUtils.clamp(state.pitch - event.movementY * 0.0023, -1.42, 1.42);
});
addEventListener("keydown", (event) => {
  keys[event.code] = true;
  if (mode === "walk" && event.code === "Space" && walk.grounded) {
    walk.velocityY = JUMP_SPEED;
    walk.grounded = false;
    event.preventDefault();
  }
});
addEventListener("keyup", (event) => {
  keys[event.code] = false;
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
for (const button of document.querySelectorAll("[data-add]")) {
  button.addEventListener("click", () => addObject(button.dataset.add));
}
for (const button of document.querySelectorAll("[data-transform]")) {
  button.addEventListener("click", () => {
    transformMode = button.dataset.transform;
    transform.setMode(transformMode);
    transform.showX = transformMode !== "rotate";
    transform.showY = true;
    transform.showZ = transformMode !== "rotate";
    for (const peer of document.querySelectorAll("[data-transform]")) {
      peer.classList.toggle("active", peer.dataset.transform === transformMode);
    }
  });
}
$("remove").addEventListener("click", removeSelected);
$("duplicate").addEventListener("click", duplicateSelected);
$("copy-json").addEventListener("click", async () => {
  const text = exportedProfile();
  json.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setButtonFeedback("copy-json", "Скопировано", "Скопировать JSON");
  } catch {
    json.select();
    document.execCommand("copy");
  }
});
$("import-json").addEventListener("click", () => {
  try {
    const parsed = JSON.parse(json.value);
    config = normalizeCollisionProfile(parsed);
    if (parsed?.cannonLayout) cannonLayout = normalizeCannonLayout(parsed.cannonLayout);
    rebuildLiveCollision(null);
    resetWalk();
  } catch (error) {
    alert(`Не удалось загрузить JSON: ${error.message}`);
  }
});
$("apply-profile").addEventListener("click", () => {
  config = saveAppliedCollisionProfile(config);
  cannonLayout = saveCannonLayout(cannonLayout);
  localStorage.setItem(COLLISION_DRAFT_STORAGE_KEY, JSON.stringify(config));
  localStorage.setItem(CANNON_LAYOUT_DRAFT_STORAGE_KEY, JSON.stringify(cannonLayout));
  setButtonFeedback("apply-profile", "Применено к бою", "Применить коллизии");
  updateJson(true);
});
$("save-local").addEventListener("click", () => {
  localStorage.setItem(COLLISION_DRAFT_STORAGE_KEY, JSON.stringify(normalizeCollisionProfile(config)));
  localStorage.setItem(CANNON_LAYOUT_DRAFT_STORAGE_KEY, JSON.stringify(normalizeCannonLayout(cannonLayout)));
  setButtonFeedback("save-local", "Черновик сохранён", "Сохранить черновик");
});
$("reset").addEventListener("click", () => {
  config = loadAppliedCollisionProfile();
  cannonLayout = loadCannonLayout();
  localStorage.removeItem(COLLISION_DRAFT_STORAGE_KEY);
  localStorage.removeItem(CANNON_LAYOUT_DRAFT_STORAGE_KEY);
  rebuildLiveCollision(null);
  resetWalk();
});
$("default-profile").addEventListener("click", () => {
  if (!confirm("Вернуть исходные игровые коллизии и удалить применённые правки?")) return;
  clearAppliedCollisionProfile();
  clearCannonLayout();
  localStorage.removeItem(COLLISION_DRAFT_STORAGE_KEY);
  localStorage.removeItem(CANNON_LAYOUT_DRAFT_STORAGE_KEY);
  config = defaultCollisionProfile();
  cannonLayout = defaultCannonLayout ? clone(defaultCannonLayout) : normalizeCannonLayout(null);
  rebuildLiveCollision(null);
  resetWalk();
  updateJson(true);
});

setMode("edit");
animate();
initializeActualColliders();
