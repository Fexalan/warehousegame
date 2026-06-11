import type { Cell, RoleId, Sku, Stage } from "./types";

// ---------------------------------------------------------------------------
// Session pacing
// ---------------------------------------------------------------------------
export const GAME_DURATION_MS = 7 * 60 * 1000;
export const TICK_MS = 250;
export const HEATMAP_BUCKET_MS = 15_000;

// Picking speed: route length and line count translate into real time cost,
// which is what makes "draw the FASTEST route" matter.
export const MS_PER_CELL = 320;
export const PICK_MS_PER_LINE = 1_000;
export const TRANSFER_MS = 4_000;
export const TRUCK_RESPAWN_MS = 8_000;

export const ROLES: RoleId[] = ["receiver", "replenisher", "picker", "dispatcher"];
export const STAGES: Stage[] = ["receiving", "replenishment", "picking", "dispatch"];

export const ROLE_LABELS: Record<RoleId, string> = {
  receiver: "Receiver",
  replenisher: "Replenisher",
  picker: "Picker",
  dispatcher: "Dispatcher",
};

export const STAGE_LABELS: Record<Stage, string> = {
  receiving: "Receiving",
  replenishment: "Replenishment",
  picking: "Picking",
  dispatch: "Dispatch",
};

// ---------------------------------------------------------------------------
// Error-cost table (the "Error Cost" KPI). Every entry is a teachable moment:
// the post-game dashboard groups the log by label.
// ---------------------------------------------------------------------------
export const COSTS = {
  damagedAccepted: { label: "Accepted a damaged pallet", amount: 200 },
  goodRejected: { label: "Rejected a good pallet", amount: 100 },
  wrongZone: { label: "Put-away to wrong ABC zone", amount: 50 },
  lateShipment: { label: "Shipped after deadline", amount: 75 },
  missedOrder: { label: "Order never shipped (missed)", amount: 250 },
  wrongDestination: { label: "Shipped to wrong destination", amount: 300 },
  truckWait: { label: "Inbound truck idling outside (per 30s)", amount: 25 },
} as const;

export const TRUCK_WAIT_CHARGE_MS = 30_000;

// ---------------------------------------------------------------------------
// Warehouse grid. Walkable = corridors; racks live between them.
//   - rows 0, 3, 6 are horizontal corridors
//   - even columns are vertical aisles
//   - odd columns at rows 1,2,4,5 are rack faces (not walkable)
// ---------------------------------------------------------------------------
export const GRID_W = 11;
export const GRID_H = 7;
export const DEPOT: Cell = { x: 0, y: 3 };
export const STAGING: Cell = { x: 10, y: 3 };

export function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return false;
  return y === 0 || y === 3 || y === 6 || x % 2 === 0;
}

export function cellEq(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y}`;
}

// ---------------------------------------------------------------------------
// Catalogue. Zone A (fast movers) sits next to the depot, zone C is the far
// end — the spatial layout IS the ABC lesson.
// ---------------------------------------------------------------------------
export const SKUS: Sku[] = [
  { id: "a1", name: "Soda 24-pack", emoji: "🥤", zone: "A", cell: { x: 2, y: 1 }, unitWeight: 2.0, unitVolume: 0.02 },
  { id: "a2", name: "Pasta cases", emoji: "🍝", zone: "A", cell: { x: 2, y: 5 }, unitWeight: 1.5, unitVolume: 0.02 },
  { id: "b1", name: "Detergent", emoji: "🧴", zone: "B", cell: { x: 4, y: 2 }, unitWeight: 2.5, unitVolume: 0.03 },
  { id: "b2", name: "Paper towels", emoji: "🧻", zone: "B", cell: { x: 6, y: 1 }, unitWeight: 0.8, unitVolume: 0.05 },
  { id: "b3", name: "Pet food bags", emoji: "🐕", zone: "B", cell: { x: 6, y: 4 }, unitWeight: 3.0, unitVolume: 0.03 },
  { id: "c1", name: "BBQ grills", emoji: "🔥", zone: "C", cell: { x: 8, y: 2 }, unitWeight: 6.0, unitVolume: 0.12 },
  { id: "c2", name: "Camping tents", emoji: "⛺", zone: "C", cell: { x: 8, y: 5 }, unitWeight: 4.0, unitVolume: 0.09 },
  { id: "c3", name: "Office chairs", emoji: "🪑", zone: "C", cell: { x: 10, y: 1 }, unitWeight: 7.0, unitVolume: 0.15 },
];

export function skuById(id: string): Sku {
  const sku = SKUS.find((s) => s.id === id);
  if (!sku) throw new Error(`Unknown SKU ${id}`);
  return sku;
}

export const DESTINATIONS = ["Lyon", "Berlin", "Madrid"];

export const CLIENT_NAMES = [
  "FreshMart", "TechnoPlus", "GreenGarden", "UrbanStyle", "MaxiSport",
  "CasaBella", "ProOffice", "HappyPets", "SunsetCafe", "NordicHome",
];

// Damaged-rack curveball: corridor clusters that can be blocked without
// trapping a pick point, the depot, or staging.
export const RACK_BLOCK_CLUSTERS: Cell[][] = [
  [{ x: 3, y: 3 }, { x: 4, y: 3 }],
  [{ x: 7, y: 3 }, { x: 8, y: 3 }],
  [{ x: 4, y: 5 }, { x: 4, y: 6 }],
  [{ x: 6, y: 2 }, { x: 6, y: 3 }],
];

// QC inspection cues shown on swipe cards. The Receiver's skill is reading
// these under time pressure — damage is never labelled outright.
export const DAMAGE_CUES = [
  "Shrink wrap torn open",
  "Crushed corner boxes",
  "Liquid leak on base",
  "Load visibly leaning",
  "Broken banding straps",
];

export const CLEAN_CUES = [
  "Wrap intact",
  "Labels scanned OK",
  "Stack square and stable",
  "Seals unbroken",
  "No visible defects",
];
