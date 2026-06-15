export const CANNON_LAYOUT_STORAGE_KEY = "ocean-sandbox-cannon-layout-v3";
export const CANNON_LAYOUT_DRAFT_STORAGE_KEY = "ocean-sandbox-cannon-layout-draft-v3";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const BUILT_IN_DEFAULT_CANNON_LAYOUT = {
  version: 1,
  units: "ship-local",
  note: "Editable cannon mount positions. Values are final ship-local mount positions.",
  cannons: [
    { id: "port-1", name: "Port broadside cannon", x: -10.944, y: 14.717, z: -36.48 },
    { id: "port-2", name: "Port broadside cannon", x: -10.931, y: 6.136, z: -15.219 },
    { id: "port-3", name: "Port broadside cannon", x: -10.978, y: 6.905, z: -7.761 },
    { id: "port-4", name: "Port broadside cannon", x: -11.384, y: 9.964, z: 5.69 },
    { id: "port-5", name: "Port broadside cannon", x: -10.053, y: 10.547, z: 17.28 },
    { id: "port-6", name: "Port broadside cannon", x: -6.681, y: -76.194, z: 24.134 },
    { id: "starboard-1", name: "Starboard broadside cannon", x: 10.962, y: 14.717, z: -36.644 },
    { id: "starboard-2", name: "Starboard broadside cannon", x: 10.924, y: 6.136, z: -12.959 },
    { id: "starboard-3", name: "Starboard broadside cannon", x: 11.171, y: 6.905, z: -7.629 },
    { id: "starboard-4", name: "Starboard broadside cannon", x: 11.125, y: 9.787, z: 5.76 },
    { id: "starboard-5", name: "Starboard broadside cannon", x: 9.458, y: 10.547, z: 17.28 },
    { id: "starboard-6", name: "Starboard broadside cannon", x: 6.158, y: -121.196, z: 23.79 },
    { id: "bow-chase", name: "Bow chase cannon", x: 0, y: 12.04, z: 27.816 },
    { id: "stern-chase", name: "Stern chase cannon", x: 0, y: 15.352, z: -42.998 },
  ],
};

export function emptyCannonLayout() {
  return {
    version: 1,
    units: "ship-local",
    note: "Editable cannon mount positions. Values are final ship-local mount positions.",
    cannons: [],
  };
}

export function defaultCannonLayout() {
  return clone(BUILT_IN_DEFAULT_CANNON_LAYOUT);
}

export function normalizeCannonLayout(value) {
  const source = value && typeof value === "object" ? value : {};
  const cannons = Array.isArray(source.cannons)
    ? source.cannons
      .filter((item) => item?.id)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        x: num(item.x),
        y: num(item.y),
        z: num(item.z),
      }))
    : [];
  return {
    version: 1,
    units: "ship-local",
    note: String(source.note || emptyCannonLayout().note),
    cannons,
  };
}

export function snapshotCannonLayout(cannons = []) {
  return normalizeCannonLayout({
    cannons: cannons
      .filter((cannon) => cannon?.id && cannon?.mount)
      .map((cannon) => ({
        id: cannon.id,
        name: cannon.name || cannon.id,
        x: cannon.mount.position.x,
        y: cannon.mount.position.y,
        z: cannon.mount.position.z,
      })),
  });
}

export function loadCannonLayout(storageKey = CANNON_LAYOUT_STORAGE_KEY) {
  const fallback = storageKey === CANNON_LAYOUT_STORAGE_KEY ? defaultCannonLayout() : emptyCannonLayout();
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? normalizeCannonLayout(JSON.parse(saved)) : fallback;
  } catch {
    return fallback;
  }
}

export function saveCannonLayout(layout, storageKey = CANNON_LAYOUT_STORAGE_KEY) {
  const normalized = normalizeCannonLayout(layout);
  localStorage.setItem(storageKey, JSON.stringify(normalized));
  return normalized;
}

export function clearCannonLayout() {
  localStorage.removeItem(CANNON_LAYOUT_STORAGE_KEY);
  localStorage.removeItem(CANNON_LAYOUT_DRAFT_STORAGE_KEY);
  localStorage.removeItem("ocean-sandbox-cannon-layout-v2");
  localStorage.removeItem("ocean-sandbox-cannon-layout-draft-v2");
  localStorage.removeItem("ocean-sandbox-cannon-layout-v1");
  localStorage.removeItem("ocean-sandbox-cannon-layout-draft-v1");
}

export function applyCannonLayout(ship, layout) {
  const normalized = normalizeCannonLayout(layout);
  if (!ship?.cannons?.length || !normalized.cannons.length) return normalized;
  const byId = new Map(normalized.cannons.map((item) => [item.id, item]));
  for (const cannon of ship.cannons) {
    const item = byId.get(cannon.id);
    if (!item || !cannon.mount) continue;
    cannon.mount.position.set(item.x, item.y, item.z);
    cannon.disabled = false;
    cannon.mount.visible = true;
    cannon.mount.traverse((object) => object.layers?.enable?.(0));
  }
  ship.group?.updateMatrixWorld?.(true);
  return clone(normalized);
}
