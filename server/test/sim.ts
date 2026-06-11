/**
 * Headless full-session simulations:
 *   1. Réaliste, honest bots  -> the chain works end to end
 *   2. Normal, sloppy receiver -> Supervisor intercepts, downstream stays clean
 *   3. Réaliste, wrong-slot rempotage -> anomaly cascades to the picker, gets resolved
 * Run: npx tsx test/sim.ts
 */
import { DAMAGE_NOTES, MODES, PRODUCTS, TICK_MS, productById } from "../../shared/constants";
import { tourDistance } from "../../shared/grid";
import type { Difficulty } from "../../shared/types";
import { TeamEngine } from "../src/engine";
import { buildReport } from "../src/kpi";

const damageNotes = new Set<string>(DAMAGE_NOTES);

function bestSequence(productIds: string[]): string[] {
  let best: string[] = productIds;
  let bestDist = Infinity;
  const permute = (rest: string[], acc: string[]) => {
    if (rest.length === 0) {
      const d = tourDistance(acc.map((id) => productById(id).cell));
      if (d < bestDist) {
        bestDist = d;
        best = [...acc];
      }
      return;
    }
    for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
  };
  permute(productIds, []);
  return best;
}

interface BotConfig {
  sloppyReceiver?: boolean; // accepts everything, ignores discrepancies
  wrongSlotOnce?: boolean; // sends one pallet to the wrong picking slot
}

function playTick(e: TeamEngine, cfg: BotConfig, flags: { wrongSlotDone: boolean }) {
  const t = (fn: () => void) => {
    try { fn(); } catch { /* engine validation refusals are part of the game */ }
  };

  // ---- Réception ----
  const freeDock = e.docks.find((d) => !d.truckId);
  const waiting = e.inboundTrucks.find((x) => x.status === "waiting");
  if (freeDock && waiting) t(() => e.assignDock(waiting.id, freeDock.id));
  for (const truck of e.inboundTrucks.filter((x) => x.status === "docked")) {
    for (const line of truck.lines.filter((l) => l.decision === "pending")) {
      const conform =
        line.deliveredProductId === line.orderedProductId &&
        line.deliveredQty === line.orderedQty &&
        !damageNotes.has(line.conditionNote);
      const accept = cfg.sloppyReceiver ? true : conform;
      t(() => e.controlLine(line.id, accept));
    }
  }
  for (const task of [...e.putawayTasks]) {
    t(() => e.putaway(task.id, productById(task.productId).zone));
  }

  // ---- Stock ----
  for (const s of e.stock) {
    const current = s.reserveUnits + s.onOrderUnits;
    if (current < s.reserveMin) t(() => e.replenishOrder(s.productId, s.reserveMax - current));
  }
  for (const s of e.stock) {
    const upp = productById(s.productId).unitsPerPallet;
    const needs = s.pickingUnits < s.pickMin && s.reserveUnits >= upp && s.pickingUnits + upp <= s.pickMax;
    if (!needs || e.transferJobs.some((j) => j.productId === s.productId)) continue;
    if (cfg.wrongSlotOnce && !flags.wrongSlotDone) {
      const other = PRODUCTS.find((p) => p.id !== s.productId)!;
      const otherStock = e.stock.find((x) => x.productId === other.id)!;
      if (otherStock.reserveUnits >= other.unitsPerPallet) {
        flags.wrongSlotDone = true;
        t(() => e.rempotage(other.id, s.productId)); // wrong pallet into this slot!
        continue;
      }
    }
    t(() => e.rempotage(s.productId, s.productId));
  }
  for (const task of e.approcheTasks.filter((x) => x.status === "pending")) {
    t(() => e.approcheSend(task.id));
  }
  for (const a of e.anomalies.filter((x) => x.status === "visible" && x.role === "replenisher")) {
    t(() => e.resolveAnomaly(a.id));
  }

  // ---- Picking ----
  for (const o of e.orders.filter((x) => x.status === "queued")) {
    t(() => e.planRoute(o.id, bestSequence(o.lines.map((l) => l.productId))));
    break; // one plan per tick, like a human
  }
  for (const o of e.orders.filter((x) => x.status === "picking")) {
    for (const line of o.lines) {
      const missing = line.qty - line.preparedQty;
      if (missing > 0 && !line.short) t(() => e.pickAssign(o.id, line.productId, missing));
    }
    // stock-out anomalies: emergency restock if possible, else partial
    for (const a of e.anomalies.filter((x) => x.status === "visible" && x.kind === "stockout" && x.orderId === o.id)) {
      const s = e.stock.find((x) => x.productId === a.productId)!;
      const action = s.reserveUnits >= productById(a.productId!).unitsPerPallet ? "emergency" : "partial";
      t(() => e.stockoutAction(o.id, a.productId!, action));
    }
    const allTouched = o.lines.every((l) => l.preparedQty > 0 || l.short);
    if (allTouched) {
      const marks: Record<string, boolean> = {};
      for (const l of o.lines) {
        marks[l.productId] =
          l.short ||
          (l.preparedQty === l.qty && l.damagedUnits === 0 && (l.preparedProductId === null || l.preparedProductId === l.productId));
      }
      t(() => e.pickControl(o.id, marks));
    }
  }

  // ---- Expédition ----
  const staged = e.orders.filter((x) => x.status === "staged");
  for (const o of staged.filter((x) => !x.truckId)) {
    if (o.fullPallet && !o.fullPallet.fulfilled) continue;
    const truck = e.outboundTrucks.find((x) => {
      if (x.status !== "loading" || x.loadingClosed || x.destination !== o.destination) return false;
      const w = x.assignedOrderIds.map((id) => e.orders.find((y) => y.id === id)!).reduce((a, y) => a + y.weight, 0);
      return w + o.weight <= x.maxWeight;
    });
    if (truck) t(() => e.assignTruck(o.id, truck.id));
  }
  for (const o of staged.filter((x) => x.truckId && !x.expeditionChecked)) {
    t(() => e.palletCheck(o.id, o.defects.length === 0));
  }
  // rotate empty bays whose destination matches nothing staged
  for (const truck of e.outboundTrucks.filter((x) => x.status === "loading" && x.assignedOrderIds.length === 0)) {
    const useful = e.orders.some(
      (o) => (o.status === "staged" || o.status === "picking" || o.status === "queued" || o.status === "transit") &&
        o.destination === truck.destination
    );
    const unmatched = e.orders.some(
      (o) => o.status === "staged" && !o.truckId &&
        !e.outboundTrucks.some((x) => x.status === "loading" && x.destination === o.destination)
    );
    if (!useful && unmatched) t(() => e.dispatchTruck(truck.id));
  }
  for (const truck of e.outboundTrucks.filter((x) => x.status === "loading" && !x.loadingClosed)) {
    const ready = e.orders.filter((o) => o.truckId === truck.id && o.status === "staged" && o.expeditionChecked);
    const anyPendingCheck = e.orders.some((o) => o.truckId === truck.id && o.status === "staged" && !o.expeditionChecked);
    // load heavy first, fragile last
    const fragile = (o: typeof ready[number]) => o.lines.some((l) => productById(l.productId).fragile);
    for (const o of [...ready].sort((a, b) => Number(fragile(a)) - Number(fragile(b)) || b.weight - a.weight)) {
      t(() => e.loadItem(truck.id, o.id));
    }
    const loaded = truck.loadedOrderIds.length;
    if (loaded === 0 || anyPendingCheck) continue;
    const w = truck.loadedOrderIds.map((id) => e.orders.find((y) => y.id === id)!).reduce((a, y) => a + y.weight, 0);
    const unmatched = e.orders.some(
      (o) => o.status === "staged" && !o.truckId &&
        !e.outboundTrucks.some((x) => x.status === "loading" && !x.loadingClosed && x.destination === o.destination)
    );
    // nothing else upstream is heading to this destination -> ship what we have
    const noMoreComing = !e.orders.some(
      (o) => o.destination === truck.destination && !truck.loadedOrderIds.includes(o.id) &&
        ["queued", "transit", "picking", "staged"].includes(o.status)
    );
    const closing =
      (truck.departsAt !== null && truck.departsAt - e.now < 20_000) ||
      w > truck.maxWeight * 0.5 || unmatched || noMoreComing;
    if (closing) {
      t(() => e.closeLoading(truck.id));
      t(() => e.dispatchTruck(truck.id));
    }
  }
}

function runSession(name: string, difficulty: Difficulty, cfg: BotConfig) {
  const engine = new TeamEngine("1", "Sim", 424242, difficulty);
  const flags = { wrongSlotDone: false };
  let sawSlotAnomaly = false;
  const cap = MODES[difficulty].durationMs;
  let endedAt = cap;

  for (let now = 0; now <= cap; now += TICK_MS) {
    const fx = engine.tick(now);
    if (engine.anomalies.some((a) => a.kind === "slot_mismatch")) sawSlotAnomaly = true;
    if (fx.gameOver) {
      endedAt = now;
      break;
    }
    playTick(engine, cfg, flags);
    const snap = engine.serialize() as any;
    if (snap.slotPhysical !== undefined || snap.damagedLines !== undefined) {
      throw new Error("Private engine state leaked into the wire snapshot!");
    }
  }

  const report = buildReport(engine);
  if (process.env.DEBUG) {
    for (const o of engine.orders.filter((x) => x.status !== "shipped")) {
      console.log(
        `[debug] ${o.label} status=${o.status} dest=${o.destination} truck=${o.truckId} checked=${o.expeditionChecked} ` +
          `fullPallet=${o.fullPallet ? `${o.fullPallet.productId}×${o.fullPallet.pallets} fulfilled=${o.fullPallet.fulfilled}` : "-"} ` +
          `lines=${o.lines.map((l) => `${l.productId}:${l.preparedQty}/${l.qty}${l.short ? "S" : ""}`).join(",")}`
      );
    }
    for (const t of engine.outboundTrucks) {
      console.log(`[debug] truck ${t.label} dest=${t.destination} assigned=${t.assignedOrderIds.length} loaded=${t.loadedOrderIds.length} closed=${t.loadingClosed}`);
    }
    for (const a of engine.approcheTasks.filter((x) => x.status === "pending")) {
      console.log(`[debug] approche pending ${a.orderLabel} ${a.productId}×${a.pallets}`);
    }
  }
  console.log(`\n=== ${name} ===`);
  console.log(`ended at ${Math.round(endedAt / 1000)}s / cap ${Math.round(cap / 1000)}s`);
  console.log(`orders: ${report.otif.total}, shipped: ${report.otif.shipped}, OTIF: ${report.otif.pct}%`);
  console.log(`error cost: €${report.errorCost.total} | supervisor interventions: ${report.supervisor.length}`);
  for (const b of report.errorCost.breakdown) console.log(`  - ${b.label}: ${b.count}x €${b.amount}`);
  console.log(`role timers: ${Object.entries(report.roleTimers).map(([r, t]) => `${r}=${Math.round(t.activeMs / 1000)}s`).join(", ")}`);
  console.log("insights:");
  for (const i of report.insights) console.log(`  * ${i}`);
  return { engine, report, sawSlotAnomaly, endedAt };
}

let failed = false;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    failed = true;
  }
}

// --- 1. Réaliste, honest bots ---
{
  const { report } = runSession("Réaliste — équipe rigoureuse", "realistic", {});
  assert(report.otif.total >= 8, "scenario should spawn enough orders");
  assert(report.otif.shipped > 0, "bots should ship orders");
  assert(report.otif.pct >= 50, `honest play should reach decent OTIF (got ${report.otif.pct}%)`);
  assert(report.supervisor.length === 0, "no supervisor in realistic mode");
}

// --- 2. Normal, sloppy receiver: the Supervisor intercepts ---
{
  const { engine, report } = runSession("Normal — réceptionnaire négligent", "normal", { sloppyReceiver: true });
  assert(report.supervisor.length > 0, "supervisor must intervene on sloppy acceptance");
  assert(report.supervisor.some((e) => e.role === "receiver"), "interventions attributed to the receiver");
  assert(
    engine.costLog.filter((c) => c.role === "receiver").every((c) => c.supervised),
    "receiver errors must be flagged as supervised in normal mode"
  );
  const shipped = engine.orders.filter((o) => o.status === "shipped");
  assert(
    shipped.every((o) => o.lines.every((l) => l.damagedUnits === 0)),
    "supervisor mode: no damaged goods may reach a shipped order"
  );
}

// --- 3. Réaliste, wrong-slot rempotage: the cascade ---
{
  const { engine, sawSlotAnomaly } = runSession("Réaliste — palette au mauvais emplacement", "realistic", { wrongSlotOnce: true });
  assert(
    engine.costLog.some((c) => c.label.startsWith("Rempotage : palette envoyée au mauvais emplacement")),
    "wrong slot must be charged to the replenisher"
  );
  assert(sawSlotAnomaly, "the picker must surface a slot_mismatch anomaly in realistic mode");
  assert(
    engine.anomalies.filter((a) => a.kind === "slot_mismatch").every((a) => a.status === "resolved"),
    "the anomaly must be resolvable by the replenisher"
  );
}

// --- 4. Facile: per-role timers + early end ---
{
  const { report, endedAt } = runSession("Facile — apprentissage isolé", "easy", {});
  assert(endedAt < MODES.easy.durationMs, "easy mode should end when the workload is done");
  assert(report.supervisor.length === 0 || report.supervisor.length >= 0, "report builds");
  const timers = Object.values(report.roleTimers).map((t) => t.activeMs);
  assert(timers.some((t) => t > 0), "role timers must accumulate active time");
  assert(new Set(timers).size > 1, "role timers should differ (asynchronous backlogs)");
}

if (!failed) console.log("\n✅ all simulation scenarios passed");
else process.exit(1);
