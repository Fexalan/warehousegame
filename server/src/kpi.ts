/**
 * Educational feedback loop: OTIF, dock utilization, the grouped Error Cost
 * ledger (with per-role attribution and supervisor interventions), the
 * bottleneck heatmap and plain-language coaching insights.
 */
import { HEATMAP_BUCKET_MS, ROLES, ROLE_LABELS, STAGES, STAGE_LABELS } from "../../shared/constants";
import type { HeatmapBucket, RoleId, Stage, TeamReport } from "../../shared/types";
import { TeamEngine } from "./engine";

const BOTTLENECK_THRESHOLD = 0.4;

export function buildReport(engine: TeamEngine): TeamReport {
  const durationMs = engine.mode.durationMs;

  // ----- OTIF -----
  const total = engine.orders.length;
  const shipped = engine.orders.filter((o) => o.status === "shipped");
  const onTimeInFull = shipped.filter((o) => {
    const inFull =
      o.defects.length === 0 &&
      o.lines.every((l) => !l.short && l.preparedQty >= l.qty) &&
      !engine.wrongDestOrders.has(o.id);
    const onTime = !engine.mode.globalTimer || (o.shippedAt !== null && o.shippedAt <= o.deadline);
    return inFull && onTime;
  }).length;
  const otifPct = total > 0 ? Math.round((onTimeInFull / total) * 100) : 100;

  // ----- Dock utilization -----
  const elapsed = Math.min(engine.now, durationMs);
  const busyPct = elapsed > 0 ? Math.round((engine.dockBusyMs / (elapsed * 2)) * 100) : 0;
  const waits = engine.truckWaitsMs;
  const avgWaitSec = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 1000) : 0;
  const maxWaitSec = waits.length ? Math.round(Math.max(...waits) / 1000) : 0;

  // ----- Error cost -----
  const groups = new Map<string, { count: number; amount: number }>();
  const byRole: Record<RoleId, number> = { receiver: 0, replenisher: 0, picker: 0, dispatcher: 0 };
  for (const e of engine.costLog) {
    const baseLabel = e.label.split(" — ")[0];
    const g = groups.get(baseLabel) ?? { count: 0, amount: 0 };
    g.count++;
    g.amount += e.amount;
    groups.set(baseLabel, g);
    byRole[e.role] += e.amount;
  }
  const breakdown = [...groups.entries()]
    .map(([label, g]) => ({ label, ...g }))
    .sort((a, b) => b.amount - a.amount);
  const errorTotal = engine.costLog.reduce((a, e) => a + e.amount, 0);

  // ----- Heatmap -----
  const bucketCount = Math.ceil(Math.max(elapsed, 1) / HEATMAP_BUCKET_MS);
  const buckets: HeatmapBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const acc = engine.buckets.get(i);
    const pressures: Record<Stage, number> = { reception: 0, stock: 0, picking: 0, expedition: 0 };
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

  const insights = buildInsights(buckets, breakdown, byRole, otifPct, engine);

  const score = Math.max(0, Math.round(otifPct * 10 + shipped.length * 30 + busyPct * 2 - errorTotal / 10));

  return {
    teamId: engine.teamId,
    teamName: engine.teamName,
    difficulty: engine.difficulty,
    score,
    otif: { pct: otifPct, onTimeInFull, total, shipped: shipped.length },
    dockUtilization: { busyPct, avgWaitSec, maxWaitSec, trucksServed: engine.trucksServed },
    errorCost: { total: errorTotal, breakdown, byRole, log: engine.costLog },
    supervisor: engine.supervisorEvents,
    roleTimers: engine.roleTimers,
    heatmap: { bucketMs: HEATMAP_BUCKET_MS, buckets },
    insights,
  };
}

// ---------------------------------------------------------------------------
// Coaching insights
// ---------------------------------------------------------------------------

const STAGE_ADVICE: Record<Stage, string> = {
  reception:
    "des camions attendaient sur le parc pendant que des lignes restaient à contrôler. Un contrôle réception plus rapide alimente toute la chaîne.",
  stock:
    "des emplacements picking sont passés sous le seuil min et le picking s'est retrouvé affamé. Anticipez le rempotage et traitez les approches dès qu'elles tombent.",
  picking:
    "les commandes se sont accumulées en préparation. Des plans de prélèvement plus courts et un contrôle plus fluide débloquent l'aval.",
  expedition:
    "des palettes attendaient à quai. Affectez les commandes aux camions dès leur arrivée et clôturez les chargements avant les départs.",
};

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function buildInsights(
  buckets: HeatmapBucket[],
  breakdown: { label: string; count: number; amount: number }[],
  byRole: Record<RoleId, number>,
  otifPct: number,
  engine: TeamEngine
): string[] {
  const insights: string[] = [];

  // Sustained bottleneck runs (>= 30 s)
  const runs: { stage: Stage; from: number; len: number }[] = [];
  let cur: { stage: Stage; from: number; len: number } | null = null;
  for (const b of buckets) {
    if (b.bottleneck && cur && cur.stage === b.bottleneck) {
      cur.len++;
    } else {
      if (cur && cur.len >= 2) runs.push(cur);
      cur = b.bottleneck ? { stage: b.bottleneck, from: b.t, len: 1 } : null;
    }
  }
  if (cur && cur.len >= 2) runs.push(cur);
  for (const run of runs.sort((a, b) => b.len - a.len).slice(0, 2)) {
    insights.push(
      `De ${fmtTime(run.from)} à ${fmtTime(run.from + run.len * HEATMAP_BUCKET_MS)}, le goulot était ${STAGE_LABELS[run.stage].toUpperCase()} : ${STAGE_ADVICE[run.stage]}`
    );
  }

  // Supervisor interventions: who needed the safety net most?
  if (engine.supervisorEvents.length > 0) {
    const perRole = new Map<RoleId, number>();
    for (const e of engine.supervisorEvents) perRole.set(e.role, (perRole.get(e.role) ?? 0) + 1);
    const [worstRole, count] = [...perRole.entries()].sort((a, b) => b[1] - a[1])[0];
    insights.push(
      `Le Superviseur est intervenu ${engine.supervisorEvents.length} fois, dont ${count} pour le poste ${ROLE_LABELS[worstRole]}. En mode Réaliste, ces erreurs se seraient propagées à l'équipe.`
    );
  }

  // Most expensive habit
  if (breakdown.length > 0) {
    const top = breakdown[0];
    insights.push(`Erreur la plus coûteuse : « ${top.label} » — ${top.count}× pour ${top.amount} €. C'est le point de progrès le moins cher de la prochaine session.`);
  }

  // Role with the highest error bill
  const worst = ROLES.map((r) => [r, byRole[r]] as const).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 0) {
    insights.push(`Poste le plus pénalisé : ${ROLE_LABELS[worst[0]]} (${worst[1]} € d'erreurs). À débriefer en priorité.`);
  }

  // OTIF headline
  if (otifPct >= 85) insights.push(`OTIF ${otifPct} % — excellent taux de service. Prochain objectif : coût d'erreur et utilisation des quais.`);
  else if (otifPct >= 60) insights.push(`OTIF ${otifPct} % — correct, mais chaque commande en retard est un client à risque. Surveillez les deadlines à l'expédition.`);
  else insights.push(`OTIF ${otifPct} % — la chaîne a décroché. Relisez la heatmap : corrigez le PREMIER goulot, le reste suit en général.`);

  return insights;
}
