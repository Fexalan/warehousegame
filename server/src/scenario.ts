/**
 * Pre-generates the full 7-minute scenario from a seed: inbound truck
 * arrivals, client order drops, outbound truck profiles and the curveball
 * schedule. Identical seed => identical scenario for all competing teams.
 */
import {
  CLIENT_NAMES,
  CLEAN_CUES,
  DAMAGE_CUES,
  DESTINATIONS,
  GAME_DURATION_MS,
  SKUS,
} from "../../shared/constants";
import type { CurveballKind } from "../../shared/types";
import { intBetween, mulberry32, pick, Rng, shuffle } from "./rng";

export interface PalletSpec {
  skuId: string;
  qty: number;
  damaged: boolean;
  cues: string[];
}

export interface TruckSpec {
  at: number;
  pallets: PalletSpec[];
}

export interface OrderSpec {
  at: number;
  clientName: string;
  destination: string;
  deadline: number;
  lines: { skuId: string; qty: number }[];
}

export interface OutboundSpec {
  destination: string;
  maxWeight: number;
  maxVolume: number;
  lifeMs: number;
}

export interface CurveballSpec {
  at: number;
  kind: CurveballKind;
}

export interface Scenario {
  trucks: TruckSpec[];
  orders: OrderSpec[];
  outbound: OutboundSpec[]; // consumed in order as docks free up
  curveballs: CurveballSpec[];
}

function makePallet(rng: Rng): PalletSpec {
  const damaged = rng() < 0.28;
  const cues = damaged
    ? shuffle(rng, [pick(rng, DAMAGE_CUES), pick(rng, CLEAN_CUES)])
    : shuffle(rng, CLEAN_CUES).slice(0, 2);
  return {
    skuId: pick(rng, SKUS).id,
    qty: intBetween(rng, 18, 35),
    damaged,
    cues,
  };
}

export function generateScenario(seed: number): Scenario {
  const rng = mulberry32(seed);

  // Inbound trucks: ~7 per session, 3-4 pallets each.
  const trucks: TruckSpec[] = [];
  for (let t = 5_000; t < GAME_DURATION_MS - 60_000; t += intBetween(rng, 38_000, 62_000)) {
    const pallets = Array.from({ length: intBetween(rng, 3, 4) }, () => makePallet(rng));
    trucks.push({ at: t, pallets });
  }

  // Client orders: ~14-17 per session, 1-3 lines each.
  const orders: OrderSpec[] = [];
  for (let t = 8_000; t < GAME_DURATION_MS - 45_000; t += intBetween(rng, 16_000, 30_000)) {
    const lineCount = intBetween(rng, 1, 3);
    const skus = shuffle(rng, SKUS).slice(0, lineCount);
    orders.push({
      at: t,
      clientName: pick(rng, CLIENT_NAMES),
      destination: pick(rng, DESTINATIONS),
      deadline: t + intBetween(rng, 70_000, 110_000),
      lines: skus.map((s) => ({ skuId: s.id, qty: intBetween(rng, 4, 12) })),
    });
  }

  // Outbound trucks: a long queue; the engine keeps 2 at the loading bays.
  const outbound: OutboundSpec[] = Array.from({ length: 20 }, () => ({
    destination: pick(rng, DESTINATIONS),
    maxWeight: intBetween(rng, 120, 180),
    maxVolume: 2.5 + rng() * 1.5,
    lifeMs: intBetween(rng, 55_000, 80_000),
  }));

  // Curveballs: one of each kind guaranteed, plus one random extra,
  // spread across the session with jitter so they feel unscripted.
  const kinds = shuffle<CurveballKind>(rng, ["rush_order", "damaged_rack", "ghost_pallet"]);
  kinds.push(pick(rng, ["rush_order", "damaged_rack", "ghost_pallet"] as const));
  const baseTimes = [80_000, 170_000, 250_000, 330_000];
  const curveballs: CurveballSpec[] = kinds.map((kind, i) => ({
    at: baseTimes[i] + intBetween(rng, -15_000, 15_000),
    kind,
  }));

  return { trucks, orders, outbound, curveballs };
}
