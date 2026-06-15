import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { loadGLTF } from "./models.js?v=20260607-assets-fire-v1";
import {
  ISLAND_LAYOUT_DRAFT_STORAGE_KEY,
  clearIslandLayout,
  cloneIslandLayout,
  defaultIslandLayout,
  loadIslandLayout,
  nextIslandObjectId,
  normalizeIslandLayout,
  normalizeIslandQuestLayout,
  saveIslandLayout,
} from "./island-layout.js?v=20260609-quest-zone-scale-v4";

const ASSETS = {
  low_poly_island: "models/low_poly_island.glb",
  relic: "models/relic_optimized.glb",
  treasure: "models/treasure_chest_lowpoly.glb",
};

const TYPE_NAMES = {
  model: "модель",
  box: "блок",
  cylinder: "цилиндр",
  tree: "дерево",
  cannon: "пушка",
};

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const rows = $("object-rows");
const fields = $("fields");
const json = $("json");
const status = $("status");
const modeHint = $("mode-hint");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07131d);
scene.fog = new THREE.Fog(0x07131d, 180, 520);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(165, 126, 180);

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

scene.add(new THREE.HemisphereLight(0xbcecff, 0x10202a, 1.65));
const sun = new THREE.DirectionalLight(0xfff2d6, 1.35);
sun.position.set(220, 260, 120);
scene.add(sun);
scene.add(new THREE.GridHelper(420, 42, 0x4b8ca0, 0x173746));
scene.add(new THREE.AxesHelper(18));

const root = new THREE.Group();
root.name = "IslandLayoutPreview";
scene.add(root);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 42, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

const transform = new TransformControls(camera, renderer.domElement);
transform.setMode("translate");
scene.add(transform);

const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let layout = loadWorkingLayout();
let selectedId = layout.objects[0]?.id || null;
let entries = new Map();
let selectables = [];
let transformMode = "translate";
let draggingTransform = false;
let rebuildToken = 0;

function loadWorkingLayout() {
  try {
    if (localStorage.getItem(ISLAND_LAYOUT_DRAFT_STORAGE_KEY)) {
      return loadIslandLayout(ISLAND_LAYOUT_DRAFT_STORAGE_KEY);
    }
  } catch {}
  return loadIslandLayout();
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.element?.classList?.contains("object-label")) child.element.remove();
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
    else child.material?.dispose?.();
  });
}

function clearRoot() {
  for (const child of [...root.children]) {
    root.remove(child);
    disposeObject(child);
  }
}

function setStatus(text) {
  status.textContent = text;
}

function material(color, opacity = 1, metalness = 0) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.84,
    metalness,
    transparent: opacity < 1,
    opacity,
  });
}

function questLayout() {
  layout.quest = normalizeIslandQuestLayout(layout.quest);
  return layout.quest;
}

function questCellLocal(q, cell, y = 0.18) {
  const center = (q.gridSize - 1) * 0.5;
  return new THREE.Vector3((cell.x - center) * q.cellSize, y, (cell.y - center) * q.cellSize + 12);
}

function questCellFromLocal(q, position) {
  const center = (q.gridSize - 1) * 0.5;
  return {
    x: THREE.MathUtils.clamp(Math.round(position.x / q.cellSize + center), 0, q.gridSize - 1),
    y: THREE.MathUtils.clamp(Math.round((position.z - 12) / q.cellSize + center), 0, q.gridSize - 1),
  };
}

function markSelectable(object, id) {
  object.userData.selectId = id;
  object.traverse((child) => {
    child.userData.selectId = id;
    if (child.isMesh) selectables.push(child);
  });
}

function addLabel(object, item) {
  const el = document.createElement("div");
  el.className = "object-label";
  el.textContent = item.id;
  const label = new CSS2DObject(el);
  label.position.set(0, labelHeight(item), 0);
  object.add(label);
}

function labelHeight(item) {
  if (item.type === "box" || item.type === "cylinder") return Math.max(4, item.height * 0.6);
  if (item.type === "tree") return 15 * item.scale;
  if (item.type === "model") return Math.max(6, item.targetXZ * 0.15);
  if (item.type === "cannon") return 8 * (item.scale || 1);
  if (item.type?.startsWith?.("quest-")) return 8;
  return 7;
}

function buildBox(item) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(item.width, item.height, item.depth),
    material(item.color ?? 0x6f7168, item.visible === false ? 0.18 : 0.82)
  );
  mesh.position.set(item.x, item.y, item.z);
  mesh.rotation.y = item.yaw || 0;
  return mesh;
}

function buildCylinder(item) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(item.radiusTop, item.radiusBottom, item.height, item.segments || 12),
    material(item.color ?? 0x6f7168, item.visible === false ? 0.18 : 0.82)
  );
  mesh.position.set(item.x, item.y, item.z);
  mesh.rotation.y = item.yaw || 0;
  return mesh;
}

function buildTree(item) {
  const group = new THREE.Group();
  group.position.set(item.x, item.y, item.z);
  group.rotation.y = item.yaw || 0;
  const scale = item.scale || 1;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8 * scale, 1.05 * scale, 7 * scale, 7),
    material(0x5d351c)
  );
  trunk.position.y = 3.5 * scale;
  trunk.rotation.z = item.lean || 0;
  group.add(trunk);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(4.4 * scale, 10 * scale, 9), material(0x2c7134));
  crown.position.y = 11.2 * scale;
  group.add(crown);
  return group;
}

function buildCannon(item) {
  const group = new THREE.Group();
  group.position.set(item.x, item.y, item.z);
  group.rotation.y = item.yaw || 0;
  const scale = item.scale || 1;
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(4.6 * scale, 1.3 * scale, 4.4 * scale), material(0x63371f));
  carriage.position.y = 0.65 * scale;
  carriage.rotation.y = Math.PI / 4;
  group.add(carriage);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.8 * scale, 1.08 * scale, 8.5 * scale, 14), material(0x252c30, 1, 0.65));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 2.5 * scale, 3.7 * scale);
  group.add(barrel);
  return group;
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
    for (const mat of materials) {
      if (!mat) continue;
      mat.side = THREE.FrontSide;
      mat.transparent = false;
      mat.opacity = 1;
    }
  });
  for (const child of removals) child.parent?.remove(child);
}

function isWaterLikeMaterial(mat) {
  if (!mat?.color) return false;
  const alpha = mat.opacity ?? 1;
  return (mat.transparent || alpha < 0.85) && mat.color.g > 0.45 && mat.color.b > 0.45;
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

function fitLoadedModel(object, targetXZ) {
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.scale.setScalar(1);
  object.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(object);
  let size = box.getSize(new THREE.Vector3());
  const scale = targetXZ / Math.max(0.001, size.x, size.z);
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(object);
  size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  object.userData.fitSize = { x: size.x, y: size.y, z: size.z };
}

async function buildModel(item) {
  const group = new THREE.Group();
  group.position.set(item.x, item.y, item.z);
  group.rotation.y = item.yaw || 0;
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(item.targetXZ, Math.max(4, item.targetXZ * 0.22), item.targetXZ),
    material(0x7fd8ff, 0.18)
  );
  placeholder.position.y = Math.max(2, item.targetXZ * 0.11);
  group.add(placeholder);
  const url = ASSETS[item.asset];
  if (!url) return group;
  try {
    const model = (await loadGLTF(url)).scene.clone(true);
    if (item.asset === "low_poly_island") stripNonIslandModelParts(model);
    prepareLoadedModel(model);
    fitLoadedModel(model, item.targetXZ);
    group.remove(placeholder);
    disposeObject(placeholder);
    group.add(model);
  } catch (error) {
    console.warn("Island sandbox model failed:", item.id, error);
  }
  return group;
}

async function createObject(item) {
  let object;
  if (item.type === "box") object = buildBox(item);
  else if (item.type === "cylinder") object = buildCylinder(item);
  else if (item.type === "tree") object = buildTree(item);
  else if (item.type === "cannon") object = buildCannon(item);
  else object = await buildModel(item);
  object.name = item.id;
  markSelectable(object, item.id);
  addLabel(object, item);
  return object;
}

function buildQuestZonePreview() {
  const q = questLayout();
  const group = new THREE.Group();
  group.name = "quest-zone";
  group.position.set(q.x, q.y, q.z);
  group.rotation.y = q.yaw || 0;
  group.scale.setScalar(q.scale || 1);

  const gold = new THREE.MeshBasicMaterial({
    color: 0xe7cf62,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
  });
  const goalGold = new THREE.MeshBasicMaterial({
    color: 0xffe27a,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
  });
  const pickMat = new THREE.MeshBasicMaterial({
    color: 0xe7cf62,
    transparent: true,
    opacity: 0.05,
    depthWrite: false,
  });

  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(q.gridSize * q.cellSize + 2, 0.12, q.gridSize * q.cellSize + 24),
    pickMat
  );
  pick.name = "QuestZoneMoveHandle";
  pick.position.set(0, -0.06, 12);
  group.add(pick);
  markSelectable(pick, "quest-zone");

  for (let y = 0; y < q.gridSize; y++) {
    for (let x = 0; x < q.gridSize; x++) {
      const isGoal = x === q.goalCell.x && y === q.goalCell.y;
      const border = new THREE.Mesh(
        new THREE.RingGeometry((q.cellSize - 0.85) * 0.48, (q.cellSize - 0.35) * 0.5, 4),
        isGoal ? goalGold.clone() : gold.clone()
      );
      border.name = `QuestCell_${x}_${y}`;
      border.rotation.x = -Math.PI / 2;
      border.rotation.z = Math.PI / 4;
      border.position.copy(questCellLocal(q, { x, y }, 0.16));
      group.add(border);
      markSelectable(border, "quest-zone");
    }
  }

  const startMarker = new THREE.Group();
  startMarker.name = "quest-start";
  startMarker.position.copy(questCellLocal(q, q.startCell, 0.75));
  const startDisc = new THREE.Mesh(
    new THREE.RingGeometry(q.cellSize * 0.18, q.cellSize * 0.31, 24),
    new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.92, side: THREE.DoubleSide })
  );
  startDisc.rotation.x = -Math.PI / 2;
  startMarker.add(startDisc);
  const startPin = new THREE.Mesh(new THREE.ConeGeometry(q.cellSize * 0.16, q.cellSize * 0.55, 12), material(0x7fd8ff, 0.85));
  startPin.position.y = q.cellSize * 0.32;
  startMarker.add(startPin);
  group.add(startMarker);
  markSelectable(startMarker, "quest-start");
  addLabel(startMarker, { id: "quest-start", type: "quest-start" });

  const goalMarker = new THREE.Group();
  goalMarker.name = "quest-goal";
  goalMarker.position.copy(questCellLocal(q, q.goalCell, 0.78));
  const goalDisc = new THREE.Mesh(
    new THREE.RingGeometry(q.cellSize * 0.2, q.cellSize * 0.34, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.96, side: THREE.DoubleSide })
  );
  goalDisc.rotation.x = -Math.PI / 2;
  goalMarker.add(goalDisc);
  const goalBox = new THREE.Mesh(new THREE.BoxGeometry(q.cellSize * 0.38, q.cellSize * 0.24, q.cellSize * 0.28), material(0xd6af42, 0.45, 0.55));
  goalBox.position.y = q.cellSize * 0.26;
  goalMarker.add(goalBox);
  group.add(goalMarker);
  markSelectable(goalMarker, "quest-goal");
  addLabel(goalMarker, { id: "quest-goal", type: "quest-goal" });

  addLabel(group, { id: "quest-zone", type: "quest-zone" });
  entries.set("quest-zone", { kind: "quest-zone", object: group });
  entries.set("quest-start", { kind: "quest-start", object: startMarker });
  entries.set("quest-goal", { kind: "quest-goal", object: goalMarker });
  return group;
}

async function rebuildScene() {
  const token = ++rebuildToken;
  transform.detach();
  clearRoot();
  entries = new Map();
  selectables = [];
  setStatus("Загрузка объектов острова...");
  const visibleCount = layout.objects.filter((item) => item.visible !== false).length;
  for (const item of layout.objects) {
    if (token !== rebuildToken) return;
    const object = await createObject(item);
    if (item.visible === false) object.visible = false;
    root.add(object);
    entries.set(item.id, { item, object });
  }
  if (token !== rebuildToken) return;
  root.add(buildQuestZonePreview());
  select(selectedId, { silent: true });
  renderPanels();
  setStatus(`objects=${layout.objects.length} visible=${visibleCount} quest=on\nselected=${selectedId || "-"}`);
}

function updateObjectFromItem(item) {
  const entry = entries.get(item.id);
  if (!entry) return;
  const object = entry.object;
  object.position.set(item.x, item.y, item.z);
  object.rotation.y = item.yaw || 0;
  object.visible = item.visible !== false;
}

function syncItemFromObject(item, object) {
  item.x = round(object.position.x, 3);
  item.y = round(object.position.y, 3);
  item.z = round(object.position.z, 3);
  item.yaw = round(object.rotation.y, 4);
}

function commitItemScale(item, object) {
  const sx = Math.max(0.01, object.scale.x);
  const sy = Math.max(0.01, object.scale.y);
  const sz = Math.max(0.01, object.scale.z);
  const uniform = (sx + sy + sz) / 3;
  if (item.type === "model") item.targetXZ = Math.max(0.1, round(item.targetXZ * uniform, 3));
  else if (item.type === "tree") item.scale = Math.max(0.1, round(item.scale * uniform, 3));
  else if (item.type === "cannon") item.scale = Math.max(0.1, round((item.scale || 1) * uniform, 3));
  else if (item.type === "box") {
    item.width = Math.max(0.1, round(item.width * sx, 3));
    item.height = Math.max(0.1, round(item.height * sy, 3));
    item.depth = Math.max(0.1, round(item.depth * sz, 3));
  } else if (item.type === "cylinder") {
    const radial = (sx + sz) * 0.5;
    item.radiusTop = Math.max(0.1, round(item.radiusTop * radial, 3));
    item.radiusBottom = Math.max(0.1, round(item.radiusBottom * radial, 3));
    item.height = Math.max(0.1, round(item.height * sy, 3));
  }
  object.scale.set(1, 1, 1);
}

function syncQuestEntryFromObject(entry, final = false) {
  const q = questLayout();
  if (entry.kind === "quest-zone") {
    q.x = round(entry.object.position.x, 3);
    q.y = round(entry.object.position.y, 3);
    q.z = round(entry.object.position.z, 3);
    q.yaw = round(entry.object.rotation.y, 4);
    q.scale = Math.max(0.1, round((entry.object.scale.x + entry.object.scale.y + entry.object.scale.z) / 3, 3));
  } else if (entry.kind === "quest-start" || entry.kind === "quest-goal") {
    const cell = questCellFromLocal(q, entry.object.position);
    if (entry.kind === "quest-start") q.startCell = cell;
    else q.goalCell = cell;
    if (final) entry.object.position.copy(questCellLocal(q, cell, entry.kind === "quest-start" ? 0.75 : 0.78));
  }
  layout.quest = normalizeIslandQuestLayout(q);
}

function syncEntryFromObject(entry, final = false) {
  if (!entry) return;
  if (entry.kind) {
    syncQuestEntryFromObject(entry, final);
    return;
  }
  if (final && transformMode === "scale") commitItemScale(entry.item, entry.object);
  syncItemFromObject(entry.item, entry.object);
}

function select(id, options = {}) {
  selectedId = id;
  const entry = entries.get(selectedId);
  transform.detach();
  if (entry) transform.attach(entry.object);
  if (!options.silent) renderPanels();
}

function selectedEntry() {
  return entries.get(selectedId) || null;
}

function selectedItem() {
  const entry = selectedEntry();
  return entry?.item || null;
}

function sizeText(item) {
  if (item.type === "quest-zone") return `grid=${item.gridSize} cell=${round(item.cellSize)} scale=${round(item.scale)}`;
  if (item.type === "quest-start" || item.type === "quest-goal") return `cell=${item.cell.x},${item.cell.y}`;
  if (item.type === "model") return `asset=${item.asset} xz=${round(item.targetXZ)}`;
  if (item.type === "box") return `${round(item.width)} x ${round(item.height)} x ${round(item.depth)}`;
  if (item.type === "cylinder") return `r=${round(item.radiusTop)}/${round(item.radiusBottom)} h=${round(item.height)}`;
  if (item.type === "tree") return `scale=${round(item.scale)}`;
  if (item.type === "cannon") return `scale=${round(item.scale || 1)}`;
  return "object";
}

function renderRows() {
  rows.innerHTML = "";
  const q = questLayout();
  const visibleRows = [
    { id: "quest-zone", type: "quest-zone", x: q.x, y: q.y, z: q.z, gridSize: q.gridSize, cellSize: q.cellSize, scale: q.scale, visible: true },
    { id: "quest-start", type: "quest-start", x: q.startCell.x, y: 0, z: q.startCell.y, cell: q.startCell, visible: true },
    { id: "quest-goal", type: "quest-goal", x: q.goalCell.x, y: 0, z: q.goalCell.y, cell: q.goalCell, visible: true },
    ...layout.objects,
  ];
  for (const item of visibleRows) {
    const tr = document.createElement("tr");
    if (item.id === selectedId) tr.classList.add("selected");
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${TYPE_NAMES[item.type] || item.type}</td>
      <td>${round(item.x)}, ${round(item.y)}, ${round(item.z)}</td>
      <td>${sizeText(item)}</td>
      <td>${item.visible === false ? "нет" : "да"}</td>
    `;
    tr.addEventListener("click", () => select(item.id));
    rows.appendChild(tr);
  }
}

function field(label, key, item, options = {}) {
  const wrapper = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = label;
  wrapper.appendChild(title);

  let input;
  if (options.type === "select") {
    input = document.createElement("select");
    for (const value of options.values || []) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      input.appendChild(option);
    }
    input.value = item[key];
  } else if (options.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = item[key] !== false;
  } else {
    input = document.createElement("input");
    input.type = options.type || "number";
    input.step = options.step || "0.01";
    input.value = item[key] ?? "";
  }

  input.addEventListener("change", () => {
    if (options.type === "checkbox") item[key] = input.checked;
    else if (options.type === "text" || options.type === "select") item[key] = input.value;
    else item[key] = Number(input.value);
    layout = normalizeIslandLayout(layout);
    const normalized = layout.objects.find((candidate) => candidate.id === item.id);
    if (normalized) selectedId = normalized.id;
    updateObjectFromItem(normalized || item);
    rebuildScene();
  });
  wrapper.appendChild(input);
  return wrapper;
}

function questNumberField(label, value, onChange, step = "0.01") {
  const wrapper = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = label;
  wrapper.appendChild(title);
  const input = document.createElement("input");
  input.type = "number";
  input.step = step;
  input.value = value ?? 0;
  input.addEventListener("change", () => {
    onChange(Number(input.value));
    layout.quest = normalizeIslandQuestLayout(layout.quest);
    rebuildScene();
  });
  wrapper.appendChild(input);
  return wrapper;
}

function renderQuestInspector(kind) {
  const q = questLayout();
  fields.className = "";
  if (kind === "quest-zone") {
    fields.appendChild(questNumberField("x", q.x, (value) => { q.x = value; }));
    fields.appendChild(questNumberField("y", q.y, (value) => { q.y = value; }));
    fields.appendChild(questNumberField("z", q.z, (value) => { q.z = value; }));
    fields.appendChild(questNumberField("yaw rad", q.yaw, (value) => { q.yaw = value; }, "0.001"));
    fields.appendChild(questNumberField("scale", q.scale, (value) => { q.scale = value; }));
    fields.appendChild(questNumberField("gridSize", q.gridSize, (value) => { q.gridSize = value; }, "1"));
    fields.appendChild(questNumberField("cellSize", q.cellSize, (value) => { q.cellSize = value; }));
    return;
  }
  const cell = kind === "quest-start" ? q.startCell : q.goalCell;
  fields.appendChild(questNumberField("cell x", cell.x, (value) => { cell.x = value; }, "1"));
  fields.appendChild(questNumberField("cell y", cell.y, (value) => { cell.y = value; }, "1"));
}

function renderInspector() {
  const entry = selectedEntry();
  if (entry?.kind) {
    fields.innerHTML = "";
    renderQuestInspector(entry.kind);
    return;
  }
  const item = selectedItem();
  fields.innerHTML = "";
  if (!item) {
    fields.className = "muted";
    fields.textContent = "Выберите объект в таблице или кликните по нему в сцене.";
    return;
  }
  fields.className = "";
  fields.appendChild(field("ID", "id", item, { type: "text" }));
  fields.appendChild(field("x", "x", item));
  fields.appendChild(field("y", "y", item));
  fields.appendChild(field("z", "z", item));
  fields.appendChild(field("yaw rad", "yaw", item, { step: "0.001" }));
  fields.appendChild(field("visible", "visible", item, { type: "checkbox" }));
  if (item.type === "model") {
    fields.appendChild(field("asset", "asset", item, { type: "select", values: Object.keys(ASSETS) }));
    fields.appendChild(field("targetXZ", "targetXZ", item));
  } else if (item.type === "box") {
    fields.appendChild(field("width", "width", item));
    fields.appendChild(field("height", "height", item));
    fields.appendChild(field("depth", "depth", item));
  } else if (item.type === "cylinder") {
    fields.appendChild(field("radiusTop", "radiusTop", item));
    fields.appendChild(field("radiusBottom", "radiusBottom", item));
    fields.appendChild(field("height", "height", item));
    fields.appendChild(field("segments", "segments", item, { step: "1" }));
  } else if (item.type === "tree") {
    fields.appendChild(field("scale", "scale", item));
    fields.appendChild(field("lean", "lean", item, { step: "0.001" }));
  } else if (item.type === "cannon") {
    fields.appendChild(field("scale", "scale", item));
  }
}

function renderJson() {
  json.value = JSON.stringify(layout, null, 2);
}

function renderPanels() {
  renderRows();
  renderInspector();
  renderJson();
}

function addObject(kind) {
  const p = orbit.target.clone();
  let item;
  if (kind === "tree") {
    item = { id: nextIslandObjectId(layout, "tree"), type: "tree", x: round(p.x), y: 37, z: round(p.z), yaw: 0, scale: 1, lean: 0, visible: true };
  } else if (kind === "cannon") {
    item = { id: nextIslandObjectId(layout, "cannon"), type: "cannon", x: round(p.x), y: round(Math.max(38, p.y)), z: round(p.z), yaw: 0, visible: true };
  } else if (kind === "box") {
    item = { id: nextIslandObjectId(layout, "box"), type: "box", x: round(p.x), y: round(p.y), z: round(p.z), yaw: 0, width: 12, height: 8, depth: 12, color: 0x6f7168, visible: true };
  } else if (kind === "altar") {
    item = { id: nextIslandObjectId(layout, "model-altar"), type: "model", asset: "relic", x: round(p.x), y: 36.4, z: round(p.z), yaw: Math.PI, targetXZ: 5.6, visible: true };
  } else {
    item = { id: nextIslandObjectId(layout, "model-treasure"), type: "model", asset: "treasure", x: round(p.x), y: 36.55, z: round(p.z), yaw: -0.45, targetXZ: 3.5, visible: true };
  }
  layout.objects.push(item);
  layout = normalizeIslandLayout(layout);
  selectedId = item.id;
  rebuildScene();
}

function duplicateSelected() {
  const item = selectedItem();
  if (!item) return;
  const copy = cloneIslandLayout({ objects: [item] }).objects[0];
  copy.id = nextIslandObjectId(layout, item.type);
  copy.x += 7;
  copy.z += 7;
  layout.objects.push(copy);
  selectedId = copy.id;
  rebuildScene();
}

function removeSelected() {
  if (selectedEntry()?.kind) return;
  if (!selectedId) return;
  layout.objects = layout.objects.filter((item) => item.id !== selectedId);
  selectedId = layout.objects[0]?.id || null;
  rebuildScene();
}

function selectIdFromObject(object) {
  let current = object;
  while (current) {
    if (current.userData?.selectId) return current.userData.selectId;
    current = current.parent;
  }
  return null;
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (draggingTransform) return;
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(selectables, false)[0];
  const id = hit ? selectIdFromObject(hit.object) : null;
  if (id) select(id);
});

transform.addEventListener("dragging-changed", (event) => {
  draggingTransform = event.value;
  orbit.enabled = !event.value;
  if (!event.value) {
    const entry = selectedEntry();
    if (entry) {
      syncEntryFromObject(entry, true);
      layout = normalizeIslandLayout(layout);
      if (!entry.kind && transformMode === "scale") {
        selectedId = entry.item.id;
        rebuildScene();
        return;
      }
      renderPanels();
    }
  }
});
transform.addEventListener("objectChange", () => {
  const entry = selectedEntry();
  if (!entry) return;
  if (!entry.kind && transformMode === "scale") {
    renderRows();
    renderJson();
    return;
  }
  syncEntryFromObject(entry, false);
  renderRows();
  renderJson();
});

document.querySelectorAll("[data-transform]").forEach((button) => {
  button.addEventListener("click", () => {
    transformMode = button.dataset.transform;
    transform.setMode(transformMode);
    document.querySelectorAll("[data-transform]").forEach((node) => node.classList.toggle("active", node === button));
  });
});
document.querySelectorAll("[data-add]").forEach((button) => {
  button.addEventListener("click", () => addObject(button.dataset.add));
});

$("duplicate").addEventListener("click", duplicateSelected);
$("remove").addEventListener("click", removeSelected);
$("save-local").addEventListener("click", () => {
  saveIslandLayout(layout, ISLAND_LAYOUT_DRAFT_STORAGE_KEY);
  setStatus(`Черновик сохранён.\nobjects=${layout.objects.length}\nselected=${selectedId || "-"}`);
});
$("apply-layout").addEventListener("click", () => {
  layout = saveIslandLayout(layout);
  saveIslandLayout(layout, ISLAND_LAYOUT_DRAFT_STORAGE_KEY);
  renderPanels();
  setStatus(`Применено в игру.\nВернись в бой или обнови simulation.html.\nobjects=${layout.objects.length}`);
});
$("reset").addEventListener("click", () => {
  layout = loadIslandLayout();
  selectedId = layout.objects[0]?.id || null;
  rebuildScene();
});
$("default-layout").addEventListener("click", () => {
  clearIslandLayout();
  layout = defaultIslandLayout();
  selectedId = layout.objects[0]?.id || null;
  rebuildScene();
});
$("copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(json.value);
    setStatus("JSON скопирован.");
  } catch {
    json.select();
    document.execCommand("copy");
    setStatus("JSON выделен и скопирован старым способом.");
  }
});
$("import-json").addEventListener("click", () => {
  try {
    layout = normalizeIslandLayout(JSON.parse(json.value));
    selectedId = layout.objects[0]?.id || null;
    saveIslandLayout(layout, ISLAND_LAYOUT_DRAFT_STORAGE_KEY);
    rebuildScene();
  } catch (error) {
    setStatus(`Ошибка JSON: ${error.message}`);
  }
});

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  const modeName = transformMode === "rotate" ? "rotate" : transformMode === "scale" ? "scale" : "move";
  modeHint.textContent = `Остров: ${transformMode === "rotate" ? "поворот" : "перемещение"} · selected=${selectedId || "-"}`;
  modeHint.textContent = `Island: ${modeName} · selected=${selectedId || "-"}`;
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

rebuildScene();
animate();
