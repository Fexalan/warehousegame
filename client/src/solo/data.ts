/**
 * Self-contained world for the single-player training mode.
 *
 * It is deliberately NOT the multiplayer engine's catalogue: solo play
 * generates each role's inputs independently (a trainee picks one role and
 * its data is randomly generated, unaffected by any other role). The flavour
 * mirrors the reference game (Moroccan office/electronics warehouse) so the
 * tasks feel familiar, but the mechanics evolve it.
 */
import type { Difficulty } from "@shared/types";
import { chance, type Rng, randInt, pick, shuffle } from "./rng";

export type SoloRole = "reception" | "stockage" | "preparation" | "expedition";

export const SOLO_ROLES: SoloRole[] = ["reception", "stockage", "preparation", "expedition"];

export const SOLO_ROLE_LABELS: Record<SoloRole, string> = {
  reception: "Réception",
  stockage: "Stockage",
  preparation: "Préparation",
  expedition: "Expédition",
};

export const SOLO_ROLE_BLURBS: Record<SoloRole, string> = {
  reception: "Planifier les quais · contrôler les livraisons · mettre en stock (ABC)",
  stockage: "Réapprovisionner · rempoter · approcher les palettes",
  preparation: "Tracer le chemin · prélever · contrôler & emballer",
  expedition: "Planifier les départs · contrôler les palettes · charger",
};

export const SOLO_STEP_LABELS: Record<SoloRole, [string, string, string]> = {
  reception: ["Planification", "Déchargement & Contrôle", "Mise en Stock"],
  stockage: ["Réapprovisionnement", "Rempotage", "Approche"],
  preparation: ["Plan de Prélèvement", "Picking", "Contrôle & Emballage"],
  expedition: ["Planification", "Contrôle Palettes", "Chargement"],
};

/** Short "what is this task" text shown in the per-step info tab (kept brief). */
export const SOLO_STEP_INFO: Record<SoloRole, [string, string, string]> = {
  reception: [
    "Affectez chaque camion à un quai. Donnez la priorité aux camions urgents et équilibrez la charge entre les deux quais.",
    "Comparez la référence et la quantité commandées vs reçues. Signalez chaque écart : Manque, Surplus ou Erreur de référence.",
    "Rangez chaque produit dans la zone correspondant à sa rotation : Forte → A, Moyenne → B, Faible → C.",
  ],
  stockage: [
    "Quand le stock passe sous le seuil minimum, commandez de quoi remonter au seuil maximum. Sinon, ne commandez pas.",
    "Transférez des palettes de la réserve vers la zone picking lorsqu'un article y est sous son seuil minimum.",
    "Amenez les palettes complètes aux quais en respectant le plan d'approche du jour.",
  ],
  preparation: [
    "Tracez le chemin le plus court qui visite tous les emplacements à prélever pour limiter les déplacements.",
    "Prélevez la quantité demandée de chaque article. En cas de manque, reportez la ligne ou proposez une substitution.",
    "Vérifiez chaque commande, traitez les défauts éventuels, puis affectez-la au quai correspondant à sa destination.",
  ],
  expedition: [
    "Affectez les commandes aux camions en respectant destination et capacité. Ne reportez que les priorités les plus basses.",
    "Contrôlez chaque palette : validez si conforme, sinon corrigez, réaffectez ou retardez.",
    "Chargez les palettes dans le bon ordre : lourdes au fond d'abord, fragiles en dernier.",
  ],
};

// ---------------------------------------------------------------------------
// Catalogue (REF001–REF012) — Moroccan office/electronics warehouse
// ---------------------------------------------------------------------------
export type SoloRotation = "forte" | "moyenne" | "faible";
export type SoloZone = "A" | "B" | "C";

export const ROTATION_LABEL: Record<SoloRotation, string> = {
  forte: "Forte",
  moyenne: "Moyenne",
  faible: "Faible",
};
export const ROTATION_TO_ZONE: Record<SoloRotation, SoloZone> = { forte: "A", moyenne: "B", faible: "C" };

export interface SoloProduct {
  ref: string;
  name: string;
  type: string;
  rotation: SoloRotation;
  unitsPerPallet: number;
  fragile: boolean;
  heavy: boolean;
}

export const CATALOGUE: SoloProduct[] = [
  { ref: "REF001", name: "Ordinateur Portable Dell XPS", type: "Electronique", rotation: "forte", unitsPerPallet: 15, fragile: true, heavy: false },
  { ref: "REF002", name: "Chaise Bureau Ergonomique Pro", type: "Mobilier", rotation: "forte", unitsPerPallet: 12, fragile: false, heavy: true },
  { ref: "REF003", name: "Imprimante HP LaserJet Pro", type: "Electronique", rotation: "faible", unitsPerPallet: 10, fragile: false, heavy: true },
  { ref: "REF004", name: "Ramette Papier A4 Premium", type: "Fournitures", rotation: "forte", unitsPerPallet: 40, fragile: false, heavy: true },
  { ref: "REF005", name: "Écran LCD 27 pouces 4K", type: "Electronique", rotation: "moyenne", unitsPerPallet: 16, fragile: true, heavy: false },
  { ref: "REF006", name: "Clavier Mécanique RGB", type: "Accessoires", rotation: "moyenne", unitsPerPallet: 30, fragile: false, heavy: false },
  { ref: "REF007", name: "Souris Gaming Pro", type: "Accessoires", rotation: "moyenne", unitsPerPallet: 15, fragile: false, heavy: false },
  { ref: "REF008", name: "Bureau Ajustable Standing", type: "Mobilier", rotation: "moyenne", unitsPerPallet: 20, fragile: false, heavy: true },
  { ref: "REF009", name: "Webcam HD 1080p", type: "Electronique", rotation: "moyenne", unitsPerPallet: 46, fragile: true, heavy: false },
  { ref: "REF010", name: "Casque Audio Sans Fil", type: "Accessoires", rotation: "faible", unitsPerPallet: 20, fragile: false, heavy: false },
  { ref: "REF011", name: "Lampe Bureau LED", type: "Fournitures", rotation: "faible", unitsPerPallet: 48, fragile: false, heavy: false },
  { ref: "REF012", name: "Adaptateur USB-C Multiport", type: "Accessoires", rotation: "faible", unitsPerPallet: 60, fragile: false, heavy: false },
];

export function productByRef(ref: string): SoloProduct {
  const p = CATALOGUE.find((x) => x.ref === ref);
  if (!p) throw new Error(`Référence inconnue ${ref}`);
  return p;
}

export const SUPPLIERS = [
  { name: "QuickSupply SA", type: "Fournitures" },
  { name: "Digital Zone", type: "Electronique" },
  { name: "Premium Office", type: "Accessoires" },
  { name: "BureauDirect SARL", type: "Accessoires" },
  { name: "Office Plus Maroc", type: "Mobilier" },
  { name: "TechPro Distribution", type: "Electronique" },
  { name: "ElectroMaroc Import", type: "Electronique" },
  { name: "MegaStock Express", type: "Mobilier" },
];

export const CITIES = ["Casablanca", "Tanger", "Fès", "Agadir", "Oujda", "Meknès", "Marrakech", "Rabat"];

export const TRUCK_SIZES = [
  { label: "petit", duration: 15 },
  { label: "moyen", duration: 25 },
  { label: "grand", duration: 35 },
];

export type Priority = "Urgent" | "Standard" | "Basse";
export const PRIORITIES: Priority[] = ["Urgent", "Standard", "Basse"];

// ---------------------------------------------------------------------------
// Difficulty knobs — the user's Facile / Normal / Réaliste system, applied to
// the solo trainer (kept, not replaced).
// ---------------------------------------------------------------------------
export interface SoloTuning {
  /** seconds for the whole role; 0 => no timer (Facile shows time but never fails) */
  durationSec: number;
  /** probability a generated line/order carries a planted error/defect */
  errorRate: number;
  /** show inline hints (correct answer cues) */
  hints: boolean;
  /** penalty multiplier on mistakes */
  penaltyMult: number;
}

export const SOLO_TUNING: Record<Difficulty, SoloTuning> = {
  easy: { durationSec: 0, errorRate: 0.18, hints: true, penaltyMult: 0 },
  normal: { durationSec: 7 * 60, errorRate: 0.3, hints: false, penaltyMult: 1 },
  realistic: { durationSec: 6 * 60, errorRate: 0.42, hints: false, penaltyMult: 1.6 },
};

// ===========================================================================
// Per-role dataset generators (independent — no cross-role coupling)
// ===========================================================================

let _counter = 0;
const nextId = (p: string) => `${p}-${String(++_counter).padStart(4, "0")}`;

// ---- RÉCEPTION -----------------------------------------------------------
export type Discrepancy = "OK" | "Manque" | "Surplus" | "Erreur de REF";

export interface ReceptionTruck {
  id: string;
  supplier: string;
  type: string;
  size: string;
  duration: number;
  priority: Priority;
  /** correct dock for "balanced" planning is computed in the screen */
  lines: ReceptionLine[];
}
export interface ReceptionLine {
  id: string;
  orderedRef: string;
  orderedQty: number;
  receivedRef: string;
  receivedQty: number;
  /** ground-truth discrepancy the trainee must identify */
  truth: Discrepancy;
  stockCritical: boolean;
}
export interface ReceptionPutaway {
  id: string;
  ref: string;
  qty: number;
  rotation: SoloRotation;
}

export interface ReceptionData {
  trucks: ReceptionTruck[];
  putaways: ReceptionPutaway[];
}

export function genReception(rng: Rng, tuning: SoloTuning): ReceptionData {
  const suppliers = shuffle(rng, SUPPLIERS).slice(0, randInt(rng, 6, 8));
  const trucks: ReceptionTruck[] = suppliers.map((s) => {
    const size = pick(rng, TRUCK_SIZES);
    const nLines = randInt(rng, 3, 6);
    const lines: ReceptionLine[] = [];
    for (let i = 0; i < nLines; i++) {
      const prod = pick(rng, CATALOGUE);
      const orderedQty = randInt(rng, 10, 50);
      let truth: Discrepancy = "OK";
      let receivedRef = prod.ref;
      let receivedQty = orderedQty;
      if (chance(rng, tuning.errorRate)) {
        const kind = pick(rng, ["Manque", "Surplus", "Erreur de REF"] as Discrepancy[]);
        truth = kind;
        if (kind === "Manque") receivedQty = Math.max(1, orderedQty - randInt(rng, 3, 12));
        else if (kind === "Surplus") receivedQty = orderedQty + randInt(rng, 3, 12);
        else receivedRef = pick(rng, CATALOGUE.filter((p) => p.ref !== prod.ref)).ref;
      }
      lines.push({
        id: nextId("LIG"),
        orderedRef: prod.ref,
        orderedQty,
        receivedRef,
        receivedQty,
        truth,
        stockCritical: chance(rng, 0.4),
      });
    }
    return {
      id: nextId("CAM"),
      supplier: s.name,
      type: s.type,
      size: size.label,
      duration: size.duration,
      priority: pick(rng, PRIORITIES),
      lines,
    };
  });

  // Put-away tasks: a handful of accepted products needing an ABC zone.
  const putaways: ReceptionPutaway[] = shuffle(rng, CATALOGUE)
    .slice(0, randInt(rng, 4, 6))
    .map((p) => ({ id: nextId("PUT"), ref: p.ref, qty: randInt(rng, 8, 40), rotation: p.rotation }));

  return { trucks, putaways };
}

// ---- STOCKAGE ------------------------------------------------------------
export interface StockRow {
  ref: string;
  name: string;
  stock: number;
  min: number;
  max: number;
  /** ground truth: should the trainee order? (stock < min) */
  shouldOrder: boolean;
  /** ground truth: order qty to reach max */
  suggestedQty: number;
}
export interface ReservePallet {
  ref: string;
  name: string;
  pallets: number;
  unitsPerPallet: number;
  /** the matching picking slot is below min => needs rempotage */
  pickBelowMin: boolean;
}
export interface ApprocheLine {
  ref: string;
  quai: 1 | 2;
  pallets: number;
}
export interface ApprochePallet {
  ref: string;
  name: string;
  available: number;
}
export interface StockageData {
  reappro: StockRow[];
  reserve: ReservePallet[];
  pickingSlots: StockRow[];
  approchePlan: ApprocheLine[];
  approcheStock: ApprochePallet[];
}

export function genStockage(rng: Rng, tuning: SoloTuning): StockageData {
  const reappro: StockRow[] = shuffle(rng, CATALOGUE).map((p) => {
    const min = randInt(rng, 24, 48);
    const max = min * randInt(rng, 4, 6);
    const below = chance(rng, 0.45 + tuning.errorRate * 0.3);
    const stock = below ? randInt(rng, 5, min - 1) : randInt(rng, min, max);
    return { ref: p.ref, name: p.name, stock, min, max, shouldOrder: stock < min, suggestedQty: Math.max(0, max - stock) };
  });

  const pickingSlots: StockRow[] = shuffle(rng, CATALOGUE).map((p) => {
    const min = randInt(rng, 24, 46);
    const max = min * randInt(rng, 4, 5);
    const below = chance(rng, 0.4 + tuning.errorRate * 0.3);
    const stock = below ? randInt(rng, 5, min - 1) : randInt(rng, min, max);
    return { ref: p.ref, name: p.name, stock, min, max, shouldOrder: stock < min, suggestedQty: Math.max(0, max - stock) };
  });

  const reserve: ReservePallet[] = shuffle(rng, CATALOGUE)
    .slice(0, randInt(rng, 6, 9))
    .map((p) => {
      const slot = pickingSlots.find((s) => s.ref === p.ref);
      return {
        ref: p.ref,
        name: p.name,
        pallets: randInt(rng, 1, 7),
        unitsPerPallet: p.unitsPerPallet,
        pickBelowMin: slot ? slot.stock < slot.min : false,
      };
    });

  const refsForApproche = shuffle(rng, CATALOGUE).slice(0, randInt(rng, 4, 6));
  const approchePlan: ApprocheLine[] = refsForApproche.map((p) => ({
    ref: p.ref,
    quai: (chance(rng, 0.5) ? 1 : 2) as 1 | 2,
    pallets: randInt(rng, 1, 3),
  }));
  const approcheStock: ApprochePallet[] = refsForApproche.map((p) => ({
    ref: p.ref,
    name: p.name,
    available: randInt(rng, 3, 7),
  }));

  return { reappro, reserve, pickingSlots, approchePlan, approcheStock };
}

// ---- PRÉPARATION ---------------------------------------------------------
export interface PickTarget {
  id: string;
  cmd: string;
  ref: string;
  name: string;
  slot: string; // e.g. "A3-01"
  required: number;
  available: number; // < required => shortage
}
export interface ControlOrder {
  cmd: string;
  ref: string;
  name: string;
  ordered: number;
  picked: number;
  priority: "Haute" | "Basse";
  defect: string; // "Aucun" | ...
  destination: string;
  expectedQuai: 1 | 2;
}
export interface PreparationData {
  targets: PickTarget[];
  control: ControlOrder[];
}

const PICK_DEFECTS = ["Emballage abîmé", "Étiquetage incorrect", "REF mélangée"];

export function genPreparation(rng: Rng, tuning: SoloTuning): PreparationData {
  const cols = "ABCD".split("");
  const refs = shuffle(rng, CATALOGUE).slice(0, randInt(rng, 5, 6));
  const targets: PickTarget[] = refs.map((p, i) => {
    const slot = `${pick(rng, cols)}${randInt(rng, 1, 5)}-0${randInt(rng, 1, 2)}`;
    const required = randInt(rng, 2, 9);
    const short = chance(rng, tuning.errorRate);
    return {
      id: nextId("PCK"),
      cmd: `CMD-00${randInt(rng, 25, 34)}`,
      ref: p.ref,
      name: p.name,
      slot,
      required,
      available: short ? randInt(rng, 0, required - 1) : required + randInt(rng, 0, 4),
    };
  });

  const control: ControlOrder[] = [];
  const nCtrl = randInt(rng, 5, 7);
  for (let i = 0; i < nCtrl; i++) {
    const p = pick(rng, CATALOGUE);
    const ordered = randInt(rng, 4, 10);
    const hasDefect = chance(rng, tuning.errorRate);
    const dest = pick(rng, CITIES);
    control.push({
      cmd: `CMD-00${10 + i}`,
      ref: p.ref,
      name: p.name,
      ordered,
      picked: ordered,
      priority: chance(rng, 0.4) ? "Haute" : "Basse",
      defect: hasDefect ? pick(rng, PICK_DEFECTS) : "Aucun",
      destination: dest,
      expectedQuai: (CITIES.indexOf(dest) % 2 === 0 ? 1 : 2) as 1 | 2,
    });
  }
  return { targets, control };
}

// ---- EXPÉDITION ----------------------------------------------------------
export interface ShipOrder {
  cmd: string;
  ref: string;
  name: string;
  destination: string;
  pallets: number;
  priority: "haute" | "moyenne" | "basse";
  fragile: boolean;
  heavy: boolean;
  unstable: boolean;
}
export interface ShipTruck {
  id: string;
  destination: string;
  capacity: number;
  departure: string;
}
export interface ExpeditionData {
  orders: ShipOrder[];
  trucks: ShipTruck[];
}

export function genExpedition(rng: Rng, tuning: SoloTuning): ExpeditionData {
  const trucks: ShipTruck[] = [];
  const nTrucks = randInt(rng, 5, 8);
  const usedCities = shuffle(rng, CITIES).slice(0, nTrucks);
  for (let i = 0; i < nTrucks; i++) {
    trucks.push({
      id: `CAM-00${i + 1}`,
      destination: usedCities[i],
      capacity: randInt(rng, 15, 28),
      departure: `${16 + Math.floor(i / 3)}:${(i % 3) * 15 === 0 ? "00" : (i % 3) * 15}`,
    });
  }
  const orders: ShipOrder[] = [];
  const nOrders = randInt(rng, 8, 12);
  for (let i = 0; i < nOrders; i++) {
    const p = pick(rng, CATALOGUE);
    orders.push({
      cmd: `CMD-00${10 + i}`,
      ref: p.ref,
      name: p.name,
      destination: pick(rng, usedCities),
      pallets: randInt(rng, 2, 10),
      priority: pick(rng, ["haute", "moyenne", "basse"] as const),
      fragile: p.fragile,
      heavy: p.heavy,
      unstable: chance(rng, tuning.errorRate),
    });
  }
  return { orders, trucks };
}
