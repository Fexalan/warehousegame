/**
 * Headless full-session simulation: four scripted "bots" play one team for
 * the whole 7 minutes at instant speed, then the KPI report is sanity-checked.
 * Run: npx tsx test/sim.ts
 */
import {
  DAMAGE_CUES,
  DEPOT,
  GAME_DURATION_MS,
  STAGING,
  TICK_MS,
  cellEq,
  cellKey,
  isWalkable,
  skuById,
} from "../../shared/constants";
import type { Cell } from "../../shared/types";
import { TeamEngine } from "../src/engine";
import { buildReport } from "../src/kpi";

// ---------------------------------------------------------------------------
// BFS pathing for the picker bot
// ---------------------------------------------------------------------------
function bfs(from: Cell, to: Cell, blocked: Set<string>): Cell[] | null {
  const queue: Cell[] = [from];
  const prev = new Map<string, Cell | null>([[cellKey(from), null]]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cellEq(cur, to)) {
      const path: Cell[] = [];
      let c: Cell | null = cur;
      while (c) {
        path.unshift(c);
        c = prev.get(cellKey(c)) ?? null;
      }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: cur.x + dx, y: cur.y + dy };
      const k = cellKey(n);
      if (!isWalkable(n.x, n.y) || blocked.has(k) || prev.has(k)) continue;
      prev.set(k, cur);
      queue.push(n);
    }
  }
  return null;
}

function routeThrough(targets: Cell[], blocked: Set<string>): Cell[] | null {
  const stops = [DEPOT, ...[...targets].sort((a, b) => a.x - b.x), STAGING];
  let path: Cell[] = [DEPOT];
  for (let i = 1; i < stops.length; i++) {
    const seg = bfs(stops[i - 1], stops[i], blocked);
    if (!seg) return null;
    path = path.concat(seg.slice(1));
  }
  return path;
}

// ---------------------------------------------------------------------------
// Scripted roles
// ---------------------------------------------------------------------------
const damageCues = new Set<string>(DAMAGE_CUES);

function playTick(e: TeamEngine) {
  // Receiver
  const freeDock = e.docks.find((d) => !d.truckId);
  const waiting = e.inboundTrucks.find((t) => t.status === "waiting");
  if (freeDock && waiting) e.assignDock(waiting.id, freeDock.id);
  for (const truck of e.inboundTrucks.filter((t) => t.status === "docked")) {
    for (const p of truck.pallets.filter((p) => p.status === "qc")) {
      const looksDamaged = p.cues.some((c) => damageCues.has(c));
      if (looksDamaged) e.qcSwipe(p.id, false);
      else e.qcSwipe(p.id, true, skuById(p.skuId).zone);
    }
  }

  // Replenisher
  for (const p of [...e.inboundBuffer]) {
    const s = e.stock.find((x) => x.skuId === p.skuId)!;
    e.putaway(p.id, s.pick < s.min ? "pick" : "reserve");
  }
  for (const s of e.stock) {
    if (s.pick < s.min && s.reserve > 0 && !e.transferJobs.some((j) => j.skuId === s.skuId)) {
      try { e.transfer(s.skuId); } catch { /* race with max cap */ }
    }
  }

  // Picker
  if (!e.activeRoute) {
    const queue = e.orders
      .filter((o) => o.status === "queued")
      .sort((a, b) => Number(b.priority) - Number(a.priority) || a.deadline - b.deadline);
    const order = queue[0];
    if (order) {
      if (order.stockoutFlag) {
        for (const line of order.lines.filter((l) => l.picked < l.qty)) {
          try { e.flagGhost(line.skuId); } catch { /* not the ghost line */ }
        }
      }
      const blocked = new Set(e.blockedCells.map(cellKey));
      const targets = order.lines.filter((l) => l.picked < l.qty).map((l) => skuById(l.skuId).cell);
      const hasStock = order.lines.every((l) => {
        const s = e.stock.find((x) => x.skuId === l.skuId)!;
        return l.picked >= l.qty || s.pick >= l.qty - l.picked || order.stockoutFlag;
      });
      const path = routeThrough(targets, blocked);
      if (path && hasStock) {
        try { e.startRoute(order.id, path); } catch { /* blocked mid-change */ }
      }
    }
  }

  // Dispatcher
  const staged = e.orders.filter((o) => o.status === "staged");
  for (const order of staged) {
    const truck =
      e.outboundTrucks.find((t) => t.status === "loading" && t.destination === order.destination) ??
      null;
    if (truck) {
      try { e.loadOrder(order.id, truck.id); } catch { /* over capacity */ }
    }
  }
  // Dispatch proactively: a loaded truck blocking a bay while staged orders
  // can't match any destination should leave so the bay rotates.
  for (const truck of e.outboundTrucks.filter((t) => t.status === "loading")) {
    if (truck.loadedOrderIds.length === 0) continue;
    const loadedW = truck.loadedOrderIds
      .map((id) => e.orders.find((o) => o.id === id)!)
      .reduce((a, o) => a + o.weight, 0);
    const unmatched = staged.some(
      (o) => !e.outboundTrucks.some((t) => t.status === "loading" && t.destination === o.destination)
    );
    if (loadedW > truck.maxWeight * 0.6 || unmatched) e.dispatchTruck(truck.id);
  }
}

// ---------------------------------------------------------------------------
// Run the session
// ---------------------------------------------------------------------------
const engine = new TeamEngine("1", "Sim Team", 424242);
let curveballsSeen = 0;
let toastCount = 0;

for (let now = 0; now <= GAME_DURATION_MS; now += TICK_MS) {
  const fx = engine.tick(now);
  curveballsSeen += fx.curveballs.length;
  toastCount += fx.toasts.length;
  playTick(engine);
  // serialization must never throw or leak private fields
  const snapshot = engine.serialize();
  if ((snapshot as any).ghostSkuId !== undefined || (snapshot as any).damagedPallets !== undefined) {
    throw new Error("Private engine state leaked into the wire snapshot!");
  }
}

const report = buildReport(engine);

console.log("=== SIM RESULT ===");
console.log(`orders: ${report.otif.total}, shipped: ${report.otif.shipped}, OTIF: ${report.otif.pct}%`);
console.log(`dock: busy ${report.dockUtilization.busyPct}%, avg wait ${report.dockUtilization.avgWaitSec}s, served ${report.dockUtilization.trucksServed}`);
console.log(`error cost: €${report.errorCost.total}`);
for (const b of report.errorCost.breakdown) console.log(`  - ${b.label}: ${b.count}x €${b.amount}`);
console.log(`heatmap buckets: ${report.heatmap.buckets.length}`);
console.log(`score: ${report.score}`);
console.log(`curveball broadcasts: ${curveballsSeen}, toasts: ${toastCount}`);
console.log("insights:");
for (const i of report.insights) console.log(`  * ${i}`);

// ---- assertions ----
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exitCode = 1;
  }
}
assert(report.otif.total >= 10, "scenario should spawn at least 10 orders");
assert(report.otif.shipped > 0, "bots should ship at least one order");
assert(report.heatmap.buckets.length === 28, "7min / 15s = 28 heatmap buckets");
assert(report.insights.length > 0, "insights should not be empty");
assert(report.dockUtilization.trucksServed > 0, "trucks should be served");
assert(engine.serialize().curveballs.every((c) => c.targets.length > 0), "silent curveballs must stay hidden");

if (process.exitCode !== 1) console.log("\n✅ full-session simulation passed");
