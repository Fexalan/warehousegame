import type { AbcZone, Cell, Difficulty, ModeConfig, Product, RoleId, Rotation, Stage } from "./types";

// ---------------------------------------------------------------------------
// Session pacing
// ---------------------------------------------------------------------------
export const TICK_MS = 250;
export const HEATMAP_BUCKET_MS = 15_000;

/** Travel time per plan cell: the prélèvement plan's distance is real time. */
export const MS_PER_CELL = 220;
/** Rempotage transfer duration (reserve pallet -> picking slot). */
export const TRANSFER_MS = 5_000;
/** Approche duration (reserve pallet -> quai). */
export const APPROCHE_MS = 4_000;
/** Re-preparation after a justified expedition refusal. */
export const REPREP_MS = 8_000;
export const TRUCK_WAIT_CHARGE_MS = 45_000;
/** Replenishment orders arrive as a new inbound truck after this delay. */
export const REAPPRO_LEAD_MS = 50_000;
/** Rempotage inaction: picking below min with reserve available for this long = fault. */
export const STARVATION_GRACE_MS = 30_000;

export const ROLES: RoleId[] = ["receiver", "replenisher", "picker", "dispatcher"];
export const STAGES: Stage[] = ["reception", "stock", "picking", "expedition"];

export const ROLE_LABELS: Record<RoleId, string> = {
  receiver: "Réception",
  replenisher: "Stock",
  picker: "Picking",
  dispatcher: "Expédition",
};

export const STAGE_LABELS: Record<Stage, string> = {
  reception: "Réception",
  stock: "Stock",
  picking: "Picking",
  expedition: "Expédition",
};

export const STEP_LABELS: Record<RoleId, [string, string, string]> = {
  receiver: ["1. Planification quai", "2. Contrôle livraison", "3. Mise en stock (ABC)"],
  replenisher: ["1. Réapprovisionnement", "2. Rempotage", "3. Approche"],
  picker: ["1. Plan de prélèvement", "2. Picking", "3. Contrôle"],
  dispatcher: ["1. Planification camions", "2. Contrôle palettes", "3. Chargement"],
};

// ---------------------------------------------------------------------------
// Difficulty modes
// ---------------------------------------------------------------------------
export const MODES: Record<Difficulty, ModeConfig> = {
  easy: {
    label: "Facile — apprentissage isolé",
    description:
      "Chronos individuels (le vôtre ne tourne que si vous avez du travail). Le Superviseur corrige les erreurs avant qu'elles n'atteignent le poste suivant.",
    globalTimer: false,
    supervisor: true,
    durationMs: 15 * 60_000, // safety cap; Easy normally ends when the workload is done
  },
  normal: {
    label: "Normal — cadence synchronisée",
    description:
      "Chrono global strict de 7 minutes pour toute l'équipe. Le Superviseur intercepte encore les erreurs entre les postes.",
    globalTimer: true,
    supervisor: true,
    durationMs: 7 * 60_000,
  },
  realistic: {
    label: "Réaliste — l'effet domino",
    description:
      "7 minutes, flux continu, aucun filet : chaque erreur se propage au poste suivant. Communiquez.",
    globalTimer: true,
    supervisor: false,
    durationMs: 7 * 60_000,
  },
};

// ---------------------------------------------------------------------------
// Error-cost table. Every entry is a teachable moment; the debrief groups
// the ledger by label and by role.
// ---------------------------------------------------------------------------
export const COSTS = {
  acceptedNonConform: { label: "Ligne non conforme acceptée en réception", amount: 200 },
  declinedConform: { label: "Ligne conforme refusée en réception", amount: 100 },
  wrongZone: { label: "Mise en stock dans la mauvaise zone ABC", amount: 50 },
  reapproWrongQty: { label: "Réappro : quantité commandée incorrecte", amount: 60 },
  reapproUseless: { label: "Réappro : commande inutile (stock suffisant)", amount: 60 },
  slotOverflow: { label: "Rempotage : débordement du picking (max dépassé)", amount: 40 },
  wrongSlot: { label: "Rempotage : palette envoyée au mauvais emplacement", amount: 120 },
  pickingStarved: { label: "Rupture picking (rempotage trop tardif)", amount: 80 },
  suboptimalRoute: { label: "Plan de prélèvement non optimal", amount: 40 },
  wrongProductPicked: { label: "Mauvais produit affecté à une commande", amount: 120 },
  controlMissed: { label: "Défaut validé au contrôle picking", amount: 150 },
  controlFalseAlarm: { label: "Ligne conforme rejetée au contrôle picking", amount: 50 },
  expeditionCheckMissed: { label: "Palette défectueuse approuvée au chargement", amount: 150 },
  expeditionFalseAlarm: { label: "Palette conforme refusée à l'expédition", amount: 50 },
  wrongDestination: { label: "Commande expédiée vers la mauvaise destination", amount: 300 },
  crushedLoad: { label: "Colis fragile écrasé (ordre de chargement)", amount: 120 },
  lateShipment: { label: "Expédition après la deadline", amount: 75 },
  missedOrder: { label: "Commande jamais expédiée", amount: 250 },
  truckWait: { label: "Camion en attente sur le parc (par 45 s)", amount: 25 },
  shippedDamaged: { label: "Marchandise endommagée expédiée au client", amount: 250 },
  shippedIncomplete: { label: "Commande expédiée incomplète", amount: 100 },
} as const;

export type CostKey = keyof typeof COSTS;

// ---------------------------------------------------------------------------
// Warehouse plan (used by the plan de prélèvement). Walkable = corridors.
// ---------------------------------------------------------------------------
export const GRID_W = 11;
export const GRID_H = 7;
export const DEPOT: Cell = { x: 0, y: 3 };
export const STAGING: Cell = { x: 10, y: 3 };

export function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return false;
  return y === 0 || y === 3 || y === 6 || x % 2 === 0;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y}`;
}

// ---------------------------------------------------------------------------
// Catalogue. Rotation class determines the correct ABC zone, and the plan
// places A near the depot — the spatial layout IS the ABC lesson.
// ---------------------------------------------------------------------------
export const ROTATION_TO_ZONE: Record<Rotation, AbcZone> = {
  haute: "A",
  moyenne: "B",
  faible: "C",
};

export const PRODUCTS: Product[] = [
  { id: "PRD-101", name: "Eau minérale 6×1,5 L", rotation: "haute", zone: "A", cell: { x: 2, y: 1 }, unitsPerPallet: 48, unitWeight: 9, fragile: false },
  { id: "PRD-102", name: "Pâtes 500 g (carton)", rotation: "haute", zone: "A", cell: { x: 2, y: 5 }, unitsPerPallet: 40, unitWeight: 6, fragile: false },
  { id: "PRD-201", name: "Lessive liquide 3 L", rotation: "moyenne", zone: "B", cell: { x: 4, y: 2 }, unitsPerPallet: 32, unitWeight: 3.5, fragile: false },
  { id: "PRD-202", name: "Essuie-tout (lot de 6)", rotation: "moyenne", zone: "B", cell: { x: 6, y: 1 }, unitsPerPallet: 60, unitWeight: 1.2, fragile: false },
  { id: "PRD-203", name: "Croquettes chien 10 kg", rotation: "moyenne", zone: "B", cell: { x: 6, y: 4 }, unitsPerPallet: 24, unitWeight: 10, fragile: false },
  { id: "PRD-301", name: "Verres cristal (coffret)", rotation: "faible", zone: "C", cell: { x: 8, y: 2 }, unitsPerPallet: 20, unitWeight: 2, fragile: true },
  { id: "PRD-302", name: "Téléviseur 43\"", rotation: "faible", zone: "C", cell: { x: 8, y: 5 }, unitsPerPallet: 8, unitWeight: 9, fragile: true },
  { id: "PRD-303", name: "Vaisselle porcelaine", rotation: "faible", zone: "C", cell: { x: 10, y: 1 }, unitsPerPallet: 30, unitWeight: 1.5, fragile: true },
];

export function productById(id: string): Product {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) throw new Error(`Produit inconnu ${id}`);
  return p;
}

export const DESTINATIONS = ["Lyon", "Berlin", "Madrid"];

export const CLIENT_NAMES = [
  "FreshMart", "TechnoPlus", "GreenGarden", "UrbanStyle", "MaxiSport",
  "CasaBella", "ProOffice", "HappyPets", "SunsetCafé", "NordicHome",
];

export const SUPPLIERS = ["LogiSud SARL", "TransEuro", "Provisio", "CartonExpress"];

/** Inspection notes. Damage is expressed through the note, never labelled. */
export const DAMAGE_NOTES = [
  "Film étirable déchiré, cartons apparents",
  "Cartons écrasés sur un angle",
  "Traces d'humidité sur la base",
  "Palette penchée, cerclage rompu",
];

export const CLEAN_NOTES = ["RAS", "Emballage intact", "Palette stable, film intact", "Étiquetage conforme"];
