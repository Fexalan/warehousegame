/**
 * Pre-generates the session workload from a seed: supplier deliveries (with
 * planted discrepancies for the réception control step), client orders,
 * outbound truck profiles, and random staging incidents that give the
 * expedition control step real work in every mode.
 * Identical seed => identical scenario for every competing team.
 */
import {
  CLEAN_NOTES,
  CLIENT_NAMES,
  DAMAGE_NOTES,
  DESTINATIONS,
  MODES,
  PRODUCTS,
  SUPPLIERS,
} from "../../shared/constants";
import type { Difficulty } from "../../shared/types";
import { intBetween, mulberry32, pick, Rng, shuffle } from "./rng";

export type Discrepancy = "none" | "damaged" | "qty" | "wrong_product";

export interface DeliveryLineSpec {
  productId: string; // ordered (bon de commande)
  orderedQty: number;
  deliveredProductId: string;
  deliveredQty: number;
  damaged: boolean;
  conditionNote: string;
}

export interface TruckSpec {
  at: number;
  supplier: string;
  lines: DeliveryLineSpec[];
}

export interface OrderSpec {
  at: number;
  client: string;
  destination: string;
  priority: "haute" | "normale";
  deadline: number;
  lines: { productId: string; qty: number }[];
  fullPallet: { productId: string; pallets: number } | null;
  /** pallet film damaged during staging transfer (expedition control work) */
  stagingIncident: boolean;
}

export interface OutboundSpec {
  destination: string;
  maxWeight: number;
  lifeMs: number;
}

export interface Scenario {
  trucks: TruckSpec[];
  orders: OrderSpec[];
  outbound: OutboundSpec[];
}

function makeLine(rng: Rng): DeliveryLineSpec {
  const product = pick(rng, PRODUCTS);
  const orderedQty = intBetween(rng, 2, 4) * 10;
  const roll = rng();
  // ~45% of lines carry a discrepancy: the contrôle step must stay sharp.
  const discrepancy: Discrepancy =
    roll < 0.55 ? "none" : roll < 0.72 ? "damaged" : roll < 0.88 ? "qty" : "wrong_product";

  const spec: DeliveryLineSpec = {
    productId: product.id,
    orderedQty,
    deliveredProductId: product.id,
    deliveredQty: orderedQty,
    damaged: false,
    conditionNote: pick(rng, CLEAN_NOTES),
  };
  if (discrepancy === "damaged") {
    spec.damaged = true;
    spec.conditionNote = pick(rng, DAMAGE_NOTES);
  } else if (discrepancy === "qty") {
    const delta = intBetween(rng, 5, 15) * (rng() < 0.7 ? -1 : 1);
    spec.deliveredQty = Math.max(5, orderedQty + delta);
  } else if (discrepancy === "wrong_product") {
    spec.deliveredProductId = pick(rng, PRODUCTS.filter((p) => p.id !== product.id)).id;
  }
  return spec;
}

export function generateScenario(seed: number, difficulty: Difficulty): Scenario {
  const rng = mulberry32(seed);
  const durationMs = MODES[difficulty].durationMs;
  // Normal breathes a little more than Réaliste; Facile has no clock pressure
  // anyway, so it uses the same workload spread over a longer window.
  const pace = difficulty === "realistic" ? 1 : difficulty === "normal" ? 1.2 : 1.6;
  const horizon = difficulty === "easy" ? 8 * 60_000 : durationMs;

  const trucks: TruckSpec[] = [];
  for (let t = 4_000; t < horizon - 60_000; t += Math.round(intBetween(rng, 55_000, 80_000) * pace)) {
    trucks.push({
      at: t,
      supplier: pick(rng, SUPPLIERS),
      lines: Array.from({ length: intBetween(rng, 3, 5) }, () => makeLine(rng)),
    });
  }

  const orders: OrderSpec[] = [];
  for (let t = 8_000; t < horizon - 50_000; t += Math.round(intBetween(rng, 24_000, 40_000) * pace)) {
    const lineCount = intBetween(rng, 2, 4);
    const products = shuffle(rng, PRODUCTS).slice(0, lineCount);
    const fullPallet =
      rng() < 0.25
        ? { productId: pick(rng, PRODUCTS).id, pallets: 1 }
        : null;
    orders.push({
      at: t,
      client: pick(rng, CLIENT_NAMES),
      destination: pick(rng, DESTINATIONS),
      priority: rng() < 0.25 ? "haute" : "normale",
      deadline: t + intBetween(rng, 150_000, 220_000),
      lines: products.map((p) => ({ productId: p.id, qty: intBetween(rng, 4, 12) })),
      fullPallet,
      stagingIncident: rng() < 0.18,
    });
  }

  const outbound: OutboundSpec[] = Array.from({ length: 20 }, () => ({
    destination: pick(rng, DESTINATIONS),
    maxWeight: intBetween(rng, 250, 400),
    lifeMs: intBetween(rng, 90_000, 130_000),
  }));

  return { trucks, orders, outbound };
}
