/**
 * Educational feedback loop: turns the engine's telemetry into the
 * post-game dashboard — OTIF, dock utilization, the grouped Error Cost
 * ledger, the bottleneck Heatmap, and plain-language coaching insights.
 */
import { GAME_DURATION_MS, HEATMAP_BUCKET_MS, STAGES, STAGE_LABELS } from "../../shared/constants";
import type { HeatmapBucket, Stage, TeamReport } from "../../shared/types";
import { TeamEngine } from "./engine";

/** A stage only counts as a bottleneck when it is genuinely backed up. */
const BOTTLENECK_THRESHOLD = 0.4;

export function buildReport(engine: TeamEngine): TeamReport {
  // ----- OTIF -----
  const total = engine.orders.length;
  const shipped = engine.orders.filter((o) => o.status === "shipped");
  const onTimeInFull = shipped.filter(
    (o) => o.shippedAt !== null && o.shippedAt <= o.deadline && !engine.wrongDestOrders.has(o.id)
  ).length;
  const otifPct = total > 0 ? Math.round((onTimeInFull / total) * 100) : 100;

  // ----- Dock utilization -----
  const dockCapacityMs = GAME_DURATION_MS * 2; // 2 docks
  const busyPct = Math.round((engine.dockBusyMs / dockCapacityMs) * 100);
  const waits = engine.truckWaitsMs;
  const avgWaitSec = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 1000) : 0;
  const maxWaitSec = waits.length ? Math.round(Math.max(...waits) / 1000) : 0;

  // ----- Error cost, grouped by root cause -----
  const groups = new Map<string, { count: number; amount: number }>();
  for (const e of engine.costLog) {
    const baseLabel = e.label.split(" — ")[0];
    const g = groups.get(baseLabel) ?? { count: 0, amount: 0 };
    g.count++;
    g.amount += e.amount;
    groups.set(baseLabel, g);
  }
  const breakdown = [...groups.entries()]
    .map(([label, g]) => ({ label, ...g }))
    .sort((a, b) => b.amount - a.amount);
  const errorTotal = engine.costLog.reduce((a, e) => a + e.amount, 0);

  // ----- Heatmap -----
  const bucketCount = Math.ceil(GAME_DURATION_MS / HEATMAP_BUCKET_MS);
  const buckets: HeatmapBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const acc = engine.buckets.get(i);
    const pressures: Record<Stage, number> = { receiving: 0, replenishment: 0, picking: 0, dispatch: 0 };
    if (acc && acc.count > 0) {
      for (const s of STAGES) pressures[s] = Math.round((acc.sums[s] / acc.count) * 100) / 100;
    }
    let bottleneck: Stage | null = null;
    let best = BOTTLENECK_THRESHOLD;
    for (const s of STAGES) {
      if (pressures[s] >= best) {
        best = pressures[s];
        bottleneck = s;
      }
    }
    buckets.push({ t: i * HEATMAP_BUCKET_MS, pressures, bottleneck });
  }

  const insights = buildInsights(buckets, breakdown, otifPct, engine);

  // Composite score for the cross-team leaderboard.
  const score = Math.max(
    0,
    Math.round(otifPct * 10 + shipped.length * 30 + busyPct * 2 - errorTotal / 10)
  );

  return {
    teamId: engine.teamId,
    teamName: engine.teamName,
    score,
    otif: { pct: otifPct, onTimeInFull, total, shipped: shipped.length },
    dockUtilization: { busyPct, avgWaitSec, maxWaitSec, trucksServed: engine.trucksServed },
    errorCost: { total: errorTotal, breakdown, log: engine.costLog },
    heatmap: { bucketMs: HEATMAP_BUCKET_MS, buckets },
    insights,
  };
}

// ---------------------------------------------------------------------------
// Coaching insights: scan the heatmap for sustained bottleneck runs and the
// cost ledger for the most expensive habit, then say it in trainer language.
// ---------------------------------------------------------------------------

const STAGE_ADVICE: Record<Stage, string> = {
  receiving:
    "trucks queued in the yard while pallets waited for QC. Faster dock assignment and swipe decisions feed the entire chain.",
  replenishment:
    "pick faces ran below minimum and downstream picking starved. Act on min/max alerts early and cross-dock fast movers when inbound allows.",
  picking:
    "orders piled up in the pick queue. Shorter routes, batching nearby picks, and clearing priority orders first keep the queue moving.",
  dispatch:
    "staged orders sat waiting for trucks. Load as soon as orders stage, match destinations, and dispatch before deadlines slip.",
};

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function buildInsights(
  buckets: HeatmapBucket[],
  breakdown: { label: string; count: number; amount: number }[],
  otifPct: number,
  engine: TeamEngine
): string[] {
  const insights: string[] = [];

  // Sustained bottleneck runs (>= 2 consecutive buckets = 30s+)
  const runs: { stage: Stage; from: number; to: number; len: number }[] = [];
  let cur: { stage: Stage; from: number; len: number } | null = null;
  for (const b of buckets) {
    if (b.bottleneck && cur && cur.stage === b.bottleneck) {
      cur.len++;
    } else {
      if (cur && cur.len >= 2) runs.push({ ...cur, to: cur.from + cur.len * HEATMAP_BUCKET_MS });
      cur = b.bottleneck ? { stage: b.bottleneck, from: b.t, len: 1 } : null;
    }
  }
  if (cur && cur.len >= 2) runs.push({ ...cur, to: cur.from + cur.len * HEATMAP_BUCKET_MS });

  for (const run of runs.sort((a, b) => b.len - a.len).slice(0, 3)) {
    insights.push(
      `From ${fmtTime(run.from)} to ${fmtTime(run.to)}, the bottleneck was ${STAGE_LABELS[run.stage].toUpperCase()}: ${STAGE_ADVICE[run.stage]}`
    );
  }

  // Most expensive error habit
  if (breakdown.length > 0) {
    const top = breakdown[0];
    insights.push(
      `Biggest error cost: "${top.label}" — ${top.count}× for €${top.amount}. That is the cheapest KPI to fix next session.`
    );
  }

  // OTIF headline
  if (otifPct >= 85) {
    insights.push(`OTIF ${otifPct}% — excellent service level. Push dock utilization and error cost next.`);
  } else if (otifPct >= 60) {
    insights.push(`OTIF ${otifPct}% — solid, but every late or missed order is a client at risk. Watch deadlines on the dispatch screen.`);
  } else {
    insights.push(`OTIF ${otifPct}% — the chain broke down. Re-watch the heatmap: fix the FIRST bottleneck, the rest usually follows.`);
  }

  if (engine.orders.some((o) => o.priority && o.status !== "shipped")) {
    insights.push("The VIP rush order was not shipped — priority interrupts must jump the pick queue immediately.");
  }

  return insights;
}
