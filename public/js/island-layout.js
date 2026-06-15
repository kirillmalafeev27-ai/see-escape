import { BUILT_IN_DEFAULT_ISLAND_LAYOUT } from "./island-default-layout-data.js?v=20260609-quest-zone-scale-v4";

export const ISLAND_LAYOUT_STORAGE_KEY = "ocean-sandbox-applied-island-layout-v9";
export const ISLAND_LAYOUT_DRAFT_STORAGE_KEY = "ocean-sandbox-island-layout-draft-v9";

const OBJECT_TYPES = new Set(["model", "box", "cylinder", "tree", "cannon"]);

const DEFAULT_QUEST_LAYOUT = BUILT_IN_DEFAULT_ISLAND_LAYOUT.quest;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedCell(value, fallback, gridSize) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: clamp(Math.round(num(source.x, fallback.x)), 0, gridSize - 1),
    y: clamp(Math.round(num(source.y, fallback.y)), 0, gridSize - 1),
  };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function defaultTrees() {
  const random = lcg(7331);
  const trees = [];
  for (let i = 0; i < 32; i++) {
    const angle = (i / 32) * Math.PI * 2 + (random() - 0.5) * 0.18;
    const radius = 105 + random() * 23;
    trees.push({
      id: `tree-${String(i + 1).padStart(2, "0")}`,
      type: "tree",
      x: Math.cos(angle) * radius,
      y: 37,
      z: Math.sin(angle) * radius,
      scale: 0.72 + random() * 0.72,
      lean: (random() - 0.5) * 0.12,
      visible: true,
    });
  }
  return trees;
}

function fortressObjects() {
  const objects = [
    { id: "island-rock", type: "cylinder", x: 0, y: 14, z: 0, radiusTop: 136, radiusBottom: 174, height: 34, segments: 18, color: 0x4d554e, visible: true },
    { id: "island-shore", type: "cylinder", x: 0, y: 3.5, z: 0, radiusTop: 151, radiusBottom: 164, height: 8, segments: 24, color: 0xbfa66b, visible: true },
    { id: "island-grass", type: "cylinder", x: 0, y: 33.5, z: 0, radiusTop: 133, radiusBottom: 140, height: 7, segments: 20, color: 0x477d3c, visible: true },
    { id: "fort-keep", type: "box", x: 0, y: 53, z: 0, width: 96, height: 25, depth: 78, yaw: 0, color: 0x6f7168, visible: true },
    { id: "fort-gate", type: "box", x: 0, y: 56, z: -48, width: 24, height: 29, depth: 12, yaw: 0, color: 0x54574f, visible: true },
    { id: "fort-wall-north", type: "box", x: 0, y: 56, z: -42, width: 118, height: 16, depth: 8, yaw: 0, color: 0x6f7168, visible: true },
    { id: "fort-wall-south", type: "box", x: 0, y: 56, z: 42, width: 118, height: 16, depth: 8, yaw: 0, color: 0x6f7168, visible: true },
    { id: "fort-wall-west", type: "box", x: -55, y: 56, z: 0, width: 8, height: 16, depth: 92, yaw: 0, color: 0x6f7168, visible: true },
    { id: "fort-wall-east", type: "box", x: 55, y: 56, z: 0, width: 8, height: 16, depth: 92, yaw: 0, color: 0x6f7168, visible: true },
  ];

  for (const [index, [x, z]] of [[-59, -48], [59, -48], [-59, 48], [59, 48]].entries()) {
    objects.push({
      id: `fort-tower-${index + 1}`,
      type: "cylinder",
      x,
      y: 56,
      z,
      radiusTop: 14,
      radiusBottom: 16,
      height: 43,
      segments: 12,
      color: 0x54574f,
      crenels: true,
      visible: true,
    });
  }

  return objects;
}

function modelObjects() {
  return [
    {
      id: "model-island",
      type: "model",
      asset: "low_poly_island",
      x: 0,
      y: -30.368,
      z: 0,
      yaw: -0.08,
      targetXZ: 215,
      visible: true,
    },
    {
      id: "model-altar",
      type: "model",
      asset: "relic",
      x: 0,
      y: 36.4,
      z: -76,
      yaw: Math.PI,
      targetXZ: 5.6,
      visible: true,
    },
    {
      id: "model-treasure",
      type: "model",
      asset: "treasure",
      x: 18,
      y: 36.55,
      z: -74,
      yaw: -0.45,
      targetXZ: 3.5,
      visible: true,
    },
  ];
}

function cannonObjects() {
  return [
    [-92, 43, -65],
    [-112, 42, 0],
    [-92, 43, 65],
    [0, 44, -104],
    [0, 44, 104],
    [92, 43, -65],
    [112, 42, 0],
    [92, 43, 65],
  ].map(([x, y, z], index) => ({
    id: `fort-cannon-${index + 1}`,
    type: "cannon",
    x,
    y,
    z,
    yaw: 0,
    scale: 1,
    visible: true,
  }));
}

export function defaultIslandQuestLayout() {
  return clone(DEFAULT_QUEST_LAYOUT);
}

export function normalizeIslandQuestLayout(value) {
  const source = value && typeof value === "object" ? value : {};
  const gridSize = clamp(Math.round(num(source.gridSize, DEFAULT_QUEST_LAYOUT.gridSize)), 2, 9);
  const quest = {
    x: num(source.x, DEFAULT_QUEST_LAYOUT.x),
    y: num(source.y, DEFAULT_QUEST_LAYOUT.y),
    z: num(source.z, DEFAULT_QUEST_LAYOUT.z),
    yaw: num(source.yaw, DEFAULT_QUEST_LAYOUT.yaw),
    scale: Math.max(0.1, num(source.scale, DEFAULT_QUEST_LAYOUT.scale)),
    gridSize,
    cellSize: Math.max(2, num(source.cellSize, DEFAULT_QUEST_LAYOUT.cellSize)),
  };
  quest.startCell = normalizedCell(source.startCell, DEFAULT_QUEST_LAYOUT.startCell, gridSize);
  quest.goalCell = normalizedCell(source.goalCell, DEFAULT_QUEST_LAYOUT.goalCell, gridSize);
  if (quest.startCell.x === quest.goalCell.x && quest.startCell.y === quest.goalCell.y) {
    quest.goalCell.y = quest.startCell.y === 0 ? gridSize - 1 : 0;
  }
  return quest;
}

export function defaultIslandLayout() {
  return clone(BUILT_IN_DEFAULT_ISLAND_LAYOUT);
}

export function normalizeIslandLayout(value) {
  const source = value && typeof value === "object" ? value : {};
  const objects = Array.isArray(source.objects)
    ? source.objects
        .filter((item) => OBJECT_TYPES.has(item?.type))
        .map((item, index) => {
          const type = item.type;
          const base = {
            id: String(item.id || `${type}-${index + 1}`),
            type,
            x: num(item.x),
            y: num(item.y),
            z: num(item.z),
            yaw: num(item.yaw),
            visible: bool(item.visible, true),
          };
          if (type === "model") {
            return {
              ...base,
              asset: String(item.asset || "relic"),
              targetXZ: Math.max(0.1, num(item.targetXZ, 10)),
            };
          }
          if (type === "box") {
            return {
              ...base,
              width: Math.max(0.1, num(item.width, 4)),
              height: Math.max(0.1, num(item.height, 4)),
              depth: Math.max(0.1, num(item.depth, 4)),
              color: num(item.color, 0x6f7168),
            };
          }
          if (type === "cylinder") {
            return {
              ...base,
              radiusTop: Math.max(0.1, num(item.radiusTop, 4)),
              radiusBottom: Math.max(0.1, num(item.radiusBottom, 4)),
              height: Math.max(0.1, num(item.height, 6)),
              segments: Math.max(5, Math.round(num(item.segments, 12))),
              color: num(item.color, 0x6f7168),
              crenels: bool(item.crenels, false),
            };
          }
          if (type === "tree") {
            return {
              ...base,
              scale: Math.max(0.1, num(item.scale, 1)),
              lean: num(item.lean),
            };
          }
          if (type === "cannon") {
            return {
              ...base,
              scale: Math.max(0.1, num(item.scale, 1)),
            };
          }
          return base;
        })
    : defaultIslandLayout().objects;

  return {
    version: 2,
    units: "island-local",
    note: String(source.note || defaultIslandLayout().note),
    quest: normalizeIslandQuestLayout(source.quest),
    objects,
  };
}

export function loadIslandLayout(key = ISLAND_LAYOUT_STORAGE_KEY) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? normalizeIslandLayout(JSON.parse(saved)) : defaultIslandLayout();
  } catch {
    return defaultIslandLayout();
  }
}

export function saveIslandLayout(layout, key = ISLAND_LAYOUT_STORAGE_KEY) {
  const normalized = normalizeIslandLayout(layout);
  localStorage.setItem(key, JSON.stringify(normalized));
  return normalized;
}

export function clearIslandLayout() {
  localStorage.removeItem(ISLAND_LAYOUT_STORAGE_KEY);
  localStorage.removeItem(ISLAND_LAYOUT_DRAFT_STORAGE_KEY);
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v8");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v8");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v7");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v7");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v6");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v6");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v5");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v5");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v4");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v4");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v3");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v3");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v2");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v2");
  localStorage.removeItem("ocean-sandbox-applied-island-layout-v1");
  localStorage.removeItem("ocean-sandbox-island-layout-draft-v1");
}

export function nextIslandObjectId(layout, type) {
  let serial = 1;
  const used = new Set((layout?.objects || []).map((item) => item.id));
  while (used.has(`${type}-${serial}`)) serial++;
  return `${type}-${serial}`;
}

export function cloneIslandLayout(layout) {
  return clone(normalizeIslandLayout(layout));
}
