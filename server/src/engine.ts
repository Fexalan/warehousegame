/**
 * TeamEngine — authoritative simulation for ONE team.
 *
 * Clients send *intents*; the engine validates, mutates, broadcasts.
 *
 * Error handling is mode-dependent and runs through ONE choke point,
 * `fault()`:
 *   - Easy/Normal ("supervisor" modes): the error is charged & logged for the
 *     offending player, then the CORRECTED effect is applied so downstream
 *     roles receive sanitized data.
 *   - Realistic: the RAW effect is applied; consequences propagate as
 *     `Anomaly` objects the downstream role must discover and handle.
 */
import {
  APPROCHE_MS,
  COSTS,
  CostKey,
  HEATMAP_BUCKET_MS,
  MODES,
  MS_PER_CELL,
  PRODUCTS,
  REAPPRO_LEAD_MS,
  REPREP_MS,
  ROLES,
  STARVATION_GRACE_MS,
  TICK_MS,
  TRANSFER_MS,
  TRUCK_WAIT_CHARGE_MS,
  productById,
} from "../../shared/constants";
import { optimalTour, tourDistance } from "../../shared/grid";
import type {
  AbcZone,
  Anomaly,
  ApprocheTask,
  CostEvent,
  DeliveryLine,
  Difficulty,
  Dock,
  InboundTruck,
  ModeConfig,
  Order,
  OrderLine,
  OutboundTruck,
  PlayerInfo,
  PutawayTask,
  RoleId,
  RoleTimer,
  Stage,
  StockItem,
  SupervisorEvent,
  TeamState,
  TransferJob,
} from "../../shared/types";
import { Rng, mulberry32 } from "./rng";
import { DeliveryLineSpec, Scenario, generateScenario } from "./scenario";

export interface RoleToast {
  role: RoleId | "all";
  message: string;
  severity: "info" | "warn" | "alert";
}

export interface TickEffects {
  toasts: RoleToast[];
  gameOver: boolean;
}

interface BucketAcc {
  sums: Record<Stage, number>;
  count: number;
}

export class TeamEngine {
  readonly teamId: string;
  readonly teamName: string;
  readonly difficulty: Difficulty;
  readonly mode: ModeConfig;
  players: PlayerInfo[] = [];

  // ----- public world state -----
  now = 0;
  cost = 0;
  docks: Dock[] = [
    { id: "d1", label: "Quai 1", truckId: null },
    { id: "d2", label: "Quai 2", truckId: null },
  ];
  inboundTrucks: InboundTruck[] = [];
  putawayTasks: PutawayTask[] = [];
  stock: StockItem[];
  transferJobs: TransferJob[] = [];
  approcheTasks: ApprocheTask[] = [];
  orders: Order[] = [];
  outboundTrucks: OutboundTruck[] = [];
  anomalies: Anomaly[] = [];
  supervisorEvents: SupervisorEvent[] = [];
  roleTimers: Record<RoleId, RoleTimer> = {
    receiver: { activeMs: 0, running: false },
    replenisher: { activeMs: 0, running: false },
    picker: { activeMs: 0, running: false },
    dispatcher: { activeMs: 0, running: false },
  };

  // ----- private truth (never serialized) -----
  private damagedLines = new Set<string>(); // delivery lines physically damaged
  private slotPhysical = new Map<string, string>(); // slotProductId -> actual productId
  private slotRevealed = new Set<string>(); // mismatched slots the picker discovered
  private misplacedReserve = new Set<string>(); // productId stored in wrong ABC zone
  private damagedReserve = new Map<string, number>(); // productId -> damaged units (realistic)
  private damagedPicking = new Map<string, number>();
  private starvedSince = new Map<string, number>();
  private stagingIncidents = new Set<string>(); // order ids that get a staging defect

  // ----- scenario & bookkeeping -----
  private scenario: Scenario;
  private rng: Rng;
  private nextTruckIdx = 0;
  private nextOrderIdx = 0;
  private nextOutboundIdx = 0;
  private outboundRespawnAt: number[] = [];
  private pendingReappro: { lines: DeliveryLineSpec[]; firstAt: number } | null = null;
  private dynamicTrucks: { at: number; lines: DeliveryLineSpec[] }[] = [];
  private reprepJobs: { orderId: string; finishAt: number }[] = [];
  private scheduled: { at: number; fn: () => void }[] = [];
  private idCounter = 0;
  private truckWaitCharged = new Map<string, number>();
  private prevNow = 0;

  // ----- analytics -----
  costLog: CostEvent[] = [];
  dockBusyMs = 0;
  truckWaitsMs: number[] = [];
  trucksServed = 0;
  wrongDestOrders = new Set<string>();
  buckets = new Map<number, BucketAcc>();

  private effects: TickEffects = { toasts: [], gameOver: false };

  constructor(teamId: string, teamName: string, seed: number, difficulty: Difficulty) {
    this.teamId = teamId;
    this.teamName = teamName;
    this.difficulty = difficulty;
    this.mode = MODES[difficulty];
    this.scenario = generateScenario(seed, difficulty);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.stock = PRODUCTS.map((p) => ({
      productId: p.id,
      reserveUnits: p.unitsPerPallet * 2,
      pickingUnits: Math.round(p.unitsPerPallet * 0.9),
      reserveMin: p.unitsPerPallet * 2, // several products start AT min: réappro has work
      reserveMax: p.unitsPerPallet * 5,
      pickMin: Math.round(p.unitsPerPallet * 0.5),
      pickMax: p.unitsPerPallet * 2,
      onOrderUnits: 0,
    }));
    // Stagger initial reserves so 3-4 products are already below min.
    for (let i = 0; i < this.stock.length; i++) {
      if (i % 2 === 0) this.stock[i].reserveUnits -= Math.round(PRODUCTS[i].unitsPerPallet * 1.2);
    }
    this.spawnOutbound(0);
    this.spawnOutbound(0);
    this.spawnOutbound(0);
  }

  // ----- helpers -----

  private newId(prefix: string): string {
    return `${prefix}-${this.teamId}-${++this.idCounter}`;
  }

  private toast(role: RoleId | "all", message: string, severity: RoleToast["severity"] = "info") {
    this.effects.toasts.push({ role, message, severity });
  }

  private charge(key: CostKey, role: RoleId, detail?: string, supervised = false) {
    const { label, amount } = COSTS[key];
    this.cost += amount;
    this.costLog.push({
      at: this.now,
      label: detail ? `${label} — ${detail}` : label,
      amount,
      role,
      supervised,
    });
  }

  /**
   * THE SUPERVISOR CHOKE POINT.
   * Logs the error against the offending role, then applies either the
   * corrected effect (Easy/Normal) or lets the raw mistake cascade
   * (Realistic).
   */
  private fault(
    key: CostKey,
    role: RoleId,
    step: string,
    original: string,
    corrected: string,
    onCorrect: () => void,
    onCascade: () => void
  ) {
    this.charge(key, role, undefined, this.mode.supervisor);
    if (this.mode.supervisor) {
      this.supervisorEvents.push({
        at: this.now,
        role,
        step,
        error: COSTS[key].label,
        original,
        corrected,
        penalty: COSTS[key].amount,
      });
      onCorrect();
    } else {
      onCascade();
    }
  }

  private addAnomaly(kind: Anomaly["kind"], role: RoleId, detail: string, productId: string | null = null, orderId: string | null = null): Anomaly {
    const a: Anomaly = {
      id: this.newId("ano"),
      kind,
      role,
      productId,
      orderId,
      detail,
      status: "visible",
      createdAt: this.now,
    };
    this.anomalies.push(a);
    this.toast(role, `⚠ Anomalie : ${detail}`, "alert");
    return a;
  }

  private stockOf(productId: string): StockItem {
    const s = this.stock.find((x) => x.productId === productId);
    if (!s) throw new Error(`Produit inconnu ${productId}`);
    return s;
  }

  private orderOf(orderId: string): Order {
    const o = this.orders.find((x) => x.id === orderId);
    if (!o) throw new Error("Commande inconnue");
    return o;
  }

  private orderFragile(o: Order): boolean {
    return o.lines.some((l) => productById(l.productId).fragile);
  }

  // =========================================================================
  // TICK
  // =========================================================================

  tick(now: number): TickEffects {
    this.effects = { toasts: [], gameOver: false };
    const dt = now - this.prevNow;
    this.prevNow = now;
    this.now = now;

    this.spawnDueTrucks();
    this.spawnDueOrders();
    this.flushPendingReappro();
    this.completeDueJobs();
    this.watchStarvation();
    this.departDueOutbound();
    if (this.mode.globalTimer) this.accrueTruckWaitCosts();
    this.dockBusyMs += dt * this.docks.filter((d) => d.truckId).length;
    this.updateRoleTimers(dt);
    this.sampleTelemetry();

    if (this.isOver()) {
      this.finalizePenalties();
      this.effects.gameOver = true;
    }
    return this.effects;
  }

  private isOver(): boolean {
    if (this.now >= this.mode.durationMs) return true;
    if (this.mode.globalTimer) return false;
    // Easy: ends when the whole workload is processed.
    const spawnsDone =
      this.nextTruckIdx >= this.scenario.trucks.length &&
      this.nextOrderIdx >= this.scenario.orders.length &&
      this.dynamicTrucks.length === 0 &&
      !this.pendingReappro;
    const workDone =
      this.inboundTrucks.length === 0 &&
      this.putawayTasks.length === 0 &&
      this.approcheTasks.every((t) => t.status === "done") &&
      this.orders.length > 0 &&
      this.orders.every((o) => o.status === "shipped" || o.status === "missed");
    return spawnsDone && workDone;
  }

  // ----- spawning -----

  private spawnDueTrucks() {
    while (this.nextTruckIdx < this.scenario.trucks.length && this.scenario.trucks[this.nextTruckIdx].at <= this.now) {
      const spec = this.scenario.trucks[this.nextTruckIdx++];
      this.spawnInbound(spec.supplier, spec.lines);
    }
    this.dynamicTrucks = this.dynamicTrucks.filter((t) => {
      if (t.at > this.now) return true;
      this.spawnInbound("Réappro fournisseur", t.lines);
      for (const l of t.lines) this.stockOf(l.productId).onOrderUnits -= l.orderedQty;
      return false;
    });
  }

  private spawnInbound(supplier: string, lines: DeliveryLineSpec[]) {
    const truck: InboundTruck = {
      id: this.newId("itrk"),
      label: `LIV-${100 + ++this.idCounter}`,
      supplier,
      arrivedAt: this.now,
      dockId: null,
      status: "waiting",
      lines: lines.map((l) => {
        const line: DeliveryLine = {
          id: this.newId("lin"),
          orderedProductId: l.productId,
          orderedQty: l.orderedQty,
          deliveredProductId: l.deliveredProductId,
          deliveredQty: l.deliveredQty,
          conditionNote: l.conditionNote,
          decision: "pending",
        };
        if (l.damaged) this.damagedLines.add(line.id);
        return line;
      }),
    };
    this.inboundTrucks.push(truck);
    this.toast("receiver", `${truck.label} (${supplier}) arrivé sur le parc — ${truck.lines.length} lignes`, "info");
  }

  private spawnDueOrders() {
    while (this.nextOrderIdx < this.scenario.orders.length && this.scenario.orders[this.nextOrderIdx].at <= this.now) {
      const spec = this.scenario.orders[this.nextOrderIdx++];
      const lines: OrderLine[] = spec.lines.map((l) => ({
        productId: l.productId,
        qty: l.qty,
        preparedQty: 0,
        preparedProductId: null,
        damagedUnits: 0,
        short: false,
      }));
      const weight = Math.round(
        lines.reduce((a, l) => a + productById(l.productId).unitWeight * l.qty, 0) +
          (spec.fullPallet
            ? productById(spec.fullPallet.productId).unitWeight *
              productById(spec.fullPallet.productId).unitsPerPallet *
              spec.fullPallet.pallets
            : 0)
      );
      const order: Order = {
        id: this.newId("ord"),
        label: `CMD-${200 + this.orders.length + 1}`,
        client: spec.client,
        destination: spec.destination,
        priority: spec.priority,
        createdAt: this.now,
        deadline: spec.deadline,
        lines,
        fullPallet: spec.fullPallet ? { ...spec.fullPallet, fulfilled: false } : null,
        status: "queued",
        planDistance: null,
        optimalDistance: null,
        transitUntil: null,
        truckId: null,
        expeditionChecked: false,
        defects: [],
        weight,
        shippedAt: null,
      };
      this.orders.push(order);
      if (spec.stagingIncident) this.stagingIncidents.add(order.id);
      if (spec.fullPallet) {
        this.approcheTasks.push({
          id: this.newId("app"),
          orderId: order.id,
          orderLabel: order.label,
          productId: spec.fullPallet.productId,
          pallets: spec.fullPallet.pallets,
          status: "pending",
        });
        this.toast("replenisher", `Approche demandée : ${spec.fullPallet.pallets} palette(s) ${spec.fullPallet.productId} pour ${order.label}`, "info");
      }
      this.toast("picker", `Nouvelle commande ${order.label} (${spec.client})${spec.priority === "haute" ? " — PRIORITÉ HAUTE" : ""}`, spec.priority === "haute" ? "warn" : "info");
    }
  }

  private spawnOutbound(at: number) {
    // Cycle the seeded profiles so every destination keeps reappearing.
    const spec = this.scenario.outbound[this.nextOutboundIdx++ % this.scenario.outbound.length];
    this.outboundTrucks.push({
      id: this.newId("otrk"),
      label: `EXP-${300 + this.nextOutboundIdx}`,
      destination: spec.destination,
      maxWeight: spec.maxWeight,
      departsAt: this.mode.globalTimer ? at + spec.lifeMs : null,
      assignedOrderIds: [],
      loadedOrderIds: [],
      loadingClosed: false,
      status: "loading",
    });
  }

  private flushPendingReappro() {
    if (!this.pendingReappro) return;
    const p = this.pendingReappro;
    if (p.lines.length >= 3 || this.now - p.firstAt > 12_000) {
      this.dynamicTrucks.push({ at: this.now + REAPPRO_LEAD_MS, lines: p.lines });
      this.pendingReappro = null;
    }
  }

  // ----- job completion -----

  private schedule(delayMs: number, fn: () => void) {
    this.scheduled.push({ at: this.now + delayMs, fn });
  }

  private completeDueJobs() {
    this.scheduled = this.scheduled.filter((job) => {
      if (job.at > this.now) return true;
      job.fn();
      return false;
    });

    // rempotage transfers landing in picking
    for (const job of [...this.transferJobs]) {
      if (job.finishAt > this.now) continue;
      this.transferJobs = this.transferJobs.filter((j) => j !== job);
      const s = this.stockOf(job.productId);
      s.pickingUnits += job.units;
      this.toast("replenisher", `Rempotage terminé : +${job.units} u. ${job.productId} en picking`, "info");
    }

    // picker transit -> picking
    for (const o of this.orders) {
      if (o.status === "transit" && o.transitUntil !== null && o.transitUntil <= this.now) {
        o.status = "picking";
        this.toast("picker", `${o.label} : arrivé en zone — prélèvement possible`, "info");
      }
    }

    // expedition re-preparation after a refusal
    this.reprepJobs = this.reprepJobs.filter((j) => {
      if (j.finishAt > this.now) return true;
      const o = this.orders.find((x) => x.id === j.orderId);
      if (o) {
        o.defects = [];
        o.expeditionChecked = false;
        this.toast("dispatcher", `${o.label} re-préparée — à recontrôler`, "info");
      }
      return false;
    });

    // outbound bay respawns
    this.outboundRespawnAt = this.outboundRespawnAt.filter((at) => {
      if (at > this.now) return true;
      this.spawnOutbound(this.now);
      return false;
    });
  }

  /** Rempotage inaction: picking below min with a full pallet available. */
  private watchStarvation() {
    for (const s of this.stock) {
      const p = productById(s.productId);
      const needs = s.pickingUnits < s.pickMin && s.reserveUnits >= p.unitsPerPallet && !this.transferJobs.some((j) => j.productId === s.productId);
      if (!needs) {
        this.starvedSince.delete(s.productId);
        continue;
      }
      const since = this.starvedSince.get(s.productId) ?? this.now;
      this.starvedSince.set(s.productId, since);
      if (this.now - since < STARVATION_GRACE_MS) continue;
      this.starvedSince.set(s.productId, this.now); // re-arm
      this.fault(
        "pickingStarved",
        "replenisher",
        "Rempotage",
        `Picking ${s.productId} sous le seuil min (${s.pickingUnits}/${s.pickMin}) sans rempotage`,
        `Le superviseur a rempoté 1 palette de ${s.productId}`,
        () => {
          s.reserveUnits -= p.unitsPerPallet;
          s.pickingUnits += p.unitsPerPallet;
        },
        () => {
          // Realistic: nothing moves — the Picker will hit the stock-out.
        }
      );
    }
  }

  private departDueOutbound() {
    for (const truck of this.outboundTrucks.filter((t) => t.status === "loading")) {
      if (truck.departsAt !== null && truck.departsAt <= this.now) this.departTruck(truck, true);
    }
  }

  private departTruck(truck: OutboundTruck, auto: boolean) {
    truck.status = "departed";
    // Assigned but never loaded: left on the quai.
    for (const oid of truck.assignedOrderIds.filter((id) => !truck.loadedOrderIds.includes(id))) {
      const o = this.orders.find((x) => x.id === oid);
      if (o && o.status !== "shipped") {
        o.truckId = null;
        o.status = "staged";
        this.toast("dispatcher", `${o.label} restée à quai — ${truck.label} est parti sans elle !`, "warn");
      }
    }
    let shipped = 0;
    for (const oid of truck.loadedOrderIds) {
      const o = this.orders.find((x) => x.id === oid);
      if (!o) continue;
      o.status = "shipped";
      o.shippedAt = this.now;
      shipped++;
      if (this.mode.globalTimer && this.now > o.deadline) this.charge("lateShipment", "dispatcher", o.label);
      if (o.destination !== truck.destination) {
        this.wrongDestOrders.add(o.id);
        if (!this.mode.supervisor) this.charge("wrongDestination", "dispatcher", `${o.label} → ${truck.destination}`);
      }
      if (!this.mode.supervisor) {
        if (o.defects.length > 0) this.charge("shippedDamaged", "dispatcher", o.label);
        if (o.lines.some((l) => l.short || l.preparedQty < l.qty)) this.charge("shippedIncomplete", "picker", o.label);
      }
    }
    this.outboundTrucks = this.outboundTrucks.filter((t) => t !== truck);
    this.outboundRespawnAt.push(this.now + 8_000);
    this.toast(
      "dispatcher",
      auto
        ? `${truck.label} parti à l'heure avec ${shipped} commande(s)${shipped === 0 ? " — camion VIDE !" : ""}`
        : `${truck.label} expédié avec ${shipped} commande(s)`,
      auto && shipped === 0 ? "warn" : "info"
    );
  }

  private accrueTruckWaitCosts() {
    for (const truck of this.inboundTrucks.filter((t) => t.status === "waiting")) {
      const waited = this.now - truck.arrivedAt;
      const charged = this.truckWaitCharged.get(truck.id) ?? 0;
      if (waited - charged >= TRUCK_WAIT_CHARGE_MS) {
        this.truckWaitCharged.set(truck.id, charged + TRUCK_WAIT_CHARGE_MS);
        this.charge("truckWait", "receiver", truck.label);
      }
    }
  }

  private finalizePenalties() {
    if (this.mode.globalTimer) {
      for (const o of this.orders) {
        if (o.status !== "shipped") {
          o.status = "missed";
          this.charge("missedOrder", "dispatcher", o.label);
        }
      }
    }
    for (const t of this.inboundTrucks.filter((x) => x.status === "waiting")) {
      this.truckWaitsMs.push(this.now - t.arrivedAt);
    }
  }

  // ----- role timers (Easy: only run while that role has a backlog) -----

  private backlogs(): Record<RoleId, boolean> {
    return {
      receiver: this.inboundTrucks.some((t) => t.status !== "departed") || this.putawayTasks.length > 0,
      replenisher:
        this.approcheTasks.some((t) => t.status === "pending") ||
        this.transferJobs.length > 0 ||
        this.anomalies.some((a) => a.status === "visible" && a.role === "replenisher") ||
        this.stock.some(
          (s) =>
            s.reserveUnits + s.onOrderUnits < s.reserveMin ||
            (s.pickingUnits < s.pickMin && s.reserveUnits >= productById(s.productId).unitsPerPallet)
        ),
      picker:
        this.anomalies.some((a) => a.status === "visible" && a.role === "picker") ||
        this.orders.some((o) => ["queued", "transit", "picking", "control"].includes(o.status)),
      dispatcher: this.orders.some((o) => ["staged", "loaded"].includes(o.status)),
    };
  }

  private updateRoleTimers(dt: number) {
    const backlog = this.backlogs();
    for (const role of ROLES) {
      const timer = this.roleTimers[role];
      timer.running = this.mode.globalTimer ? true : backlog[role];
      if (timer.running) timer.activeMs += dt;
    }
  }

  // =========================================================================
  // RÉCEPTION — planification quai, contrôle livraison, mise en stock ABC
  // =========================================================================

  assignDock(truckId: string, dockId: string) {
    const truck = this.inboundTrucks.find((t) => t.id === truckId);
    const dock = this.docks.find((d) => d.id === dockId);
    if (!truck || truck.status !== "waiting") throw new Error("Camion non disponible sur le parc");
    if (!dock || dock.truckId) throw new Error("Quai occupé");
    dock.truckId = truck.id;
    truck.dockId = dock.id;
    truck.status = "docked";
    this.truckWaitsMs.push(this.now - truck.arrivedAt);
    this.trucksServed++;
  }

  controlLine(lineId: string, accept: boolean) {
    const truck = this.inboundTrucks.find((t) => t.lines.some((l) => l.id === lineId));
    const line = truck?.lines.find((l) => l.id === lineId);
    if (!truck || !line || truck.status !== "docked") throw new Error("Ligne non disponible au contrôle");
    if (line.decision !== "pending") throw new Error("Ligne déjà traitée");

    const damaged = this.damagedLines.has(line.id);
    const conform =
      !damaged && line.deliveredProductId === line.orderedProductId && line.deliveredQty === line.orderedQty;
    line.decision = accept ? "accepted" : "declined";

    if (accept && !conform) {
      const what = damaged
        ? "marchandise endommagée"
        : line.deliveredProductId !== line.orderedProductId
          ? `mauvais produit (${line.deliveredProductId} au lieu de ${line.orderedProductId})`
          : `écart de quantité (${line.deliveredQty} au lieu de ${line.orderedQty})`;
      this.fault(
        "acceptedNonConform",
        "receiver",
        "Contrôle réception",
        `Ligne acceptée : ${what}`,
        `Le superviseur a substitué ${line.orderedQty} u. conformes de ${line.orderedProductId}`,
        () => this.createPutaway(line.orderedProductId, line.orderedQty),
        () => {
          // Realistic: what was accepted is what enters the warehouse.
          this.createPutaway(line.deliveredProductId, line.deliveredQty);
          if (damaged) {
            const cur = this.damagedReserve.get(line.deliveredProductId) ?? 0;
            this.damagedReserve.set(line.deliveredProductId, cur + line.deliveredQty);
          }
        }
      );
    } else if (!accept && conform) {
      this.fault(
        "declinedConform",
        "receiver",
        "Contrôle réception",
        `Ligne conforme refusée (${line.orderedQty} u. ${line.orderedProductId})`,
        "Le superviseur a réintégré la marchandise refusée à tort",
        () => this.createPutaway(line.orderedProductId, line.orderedQty),
        () => {
          // Realistic: the goods go back on the truck. Stock shortage ahead.
        }
      );
    } else if (accept && conform) {
      this.createPutaway(line.orderedProductId, line.orderedQty);
    }
    // (decline non-conform = correct, nothing enters stock)

    if (truck.lines.every((l) => l.decision !== "pending")) {
      truck.status = "departed";
      const dock = this.docks.find((d) => d.truckId === truck.id);
      if (dock) dock.truckId = null;
      this.inboundTrucks = this.inboundTrucks.filter((t) => t !== truck);
      this.toast("receiver", `${truck.label} contrôlé — quai libéré`, "info");
    }
  }

  private createPutaway(productId: string, qty: number) {
    this.putawayTasks.push({ id: this.newId("put"), productId, qty, createdAt: this.now });
  }

  putaway(taskId: string, zone: AbcZone) {
    const idx = this.putawayTasks.findIndex((t) => t.id === taskId);
    if (idx < 0) throw new Error("Tâche de mise en stock inconnue");
    const task = this.putawayTasks[idx];
    this.putawayTasks.splice(idx, 1);
    const product = productById(task.productId);
    this.stockOf(task.productId).reserveUnits += task.qty;

    if (zone !== product.zone) {
      this.fault(
        "wrongZone",
        "receiver",
        "Mise en stock",
        `${task.productId} (rotation ${product.rotation}) rangé en zone ${zone}`,
        `Le superviseur a déplacé la palette en zone ${product.zone}`,
        () => {},
        () => {
          // Realistic: the next rempotage of this product will lose time
          // searching for the pallet (and surface an anomaly).
          this.misplacedReserve.add(task.productId);
        }
      );
    }
  }

  // =========================================================================
  // STOCK — réapprovisionnement, rempotage, approche
  // =========================================================================

  replenishOrder(productId: string, qty: number) {
    const s = this.stockOf(productId);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantité invalide");
    const current = s.reserveUnits + s.onOrderUnits;

    if (current >= s.reserveMin) {
      this.fault(
        "reapproUseless",
        "replenisher",
        "Réapprovisionnement",
        `Commande de ${qty} u. de ${productId} alors que le stock (${current}) couvre le seuil min (${s.reserveMin})`,
        "Le superviseur a annulé la commande inutile",
        () => {},
        () => this.placeSupplierOrder(productId, qty)
      );
      return;
    }

    const correctQty = s.reserveMax - current;
    if (qty !== correctQty) {
      this.fault(
        "reapproWrongQty",
        "replenisher",
        "Réapprovisionnement",
        `Commande de ${qty} u. de ${productId} (attendu : ${correctQty} pour atteindre le max ${s.reserveMax})`,
        `Le superviseur a rectifié la commande à ${correctQty} u.`,
        () => this.placeSupplierOrder(productId, correctQty),
        () => this.placeSupplierOrder(productId, qty)
      );
      return;
    }
    this.placeSupplierOrder(productId, qty);
    this.toast("replenisher", `Commande fournisseur : ${qty} u. de ${productId} (livraison ~${Math.round(REAPPRO_LEAD_MS / 1000)} s)`, "info");
  }

  private placeSupplierOrder(productId: string, qty: number) {
    this.stockOf(productId).onOrderUnits += qty;
    const line: DeliveryLineSpec = {
      productId,
      orderedQty: qty,
      deliveredProductId: productId,
      deliveredQty: qty,
      damaged: false,
      conditionNote: "RAS",
    };
    if (!this.pendingReappro) this.pendingReappro = { lines: [], firstAt: this.now };
    this.pendingReappro.lines.push(line);
  }

  rempotage(palletProductId: string, slotProductId: string) {
    const reserve = this.stockOf(palletProductId);
    const slot = this.stockOf(slotProductId);
    const pallet = productById(palletProductId);
    if (reserve.reserveUnits < pallet.unitsPerPallet) throw new Error("Pas de palette complète en réserve");
    if (this.transferJobs.some((j) => j.productId === slotProductId)) throw new Error("Rempotage déjà en cours vers cet emplacement");

    // Misplaced pallet (realistic cascade from a wrong-zone put-away):
    // the transfer takes twice as long and surfaces an anomaly.
    let duration = TRANSFER_MS;
    if (this.misplacedReserve.has(palletProductId)) {
      this.misplacedReserve.delete(palletProductId);
      duration *= 2;
      this.addAnomaly(
        "misplaced_pallet",
        "replenisher",
        `Palette ${palletProductId} introuvable en zone ${pallet.zone} — rangée au mauvais endroit, recherche en cours (+${TRANSFER_MS / 1000} s)`,
        palletProductId
      ).status = "resolved"; // informative: resolved by the search itself
    }

    if (palletProductId !== slotProductId) {
      this.fault(
        "wrongSlot",
        "replenisher",
        "Rempotage",
        `Palette ${palletProductId} envoyée vers l'emplacement picking ${slotProductId}`,
        `Le superviseur a redirigé la palette vers l'emplacement ${palletProductId}`,
        () => this.startTransfer(palletProductId, palletProductId, duration),
        () => {
          // Realistic: the slot now physically contains the wrong product.
          // The system count goes up; the Picker will discover the truth.
          this.slotPhysical.set(slotProductId, palletProductId);
          this.startTransfer(palletProductId, slotProductId, duration);
        }
      );
      return;
    }

    if (slot.pickingUnits + pallet.unitsPerPallet > slot.pickMax) {
      this.fault(
        "slotOverflow",
        "replenisher",
        "Rempotage",
        `Rempotage de ${pallet.unitsPerPallet} u. alors que le picking ${slotProductId} dépasserait le max (${slot.pickMax})`,
        "Le superviseur a bloqué le rempotage excédentaire",
        () => {},
        () => this.startTransfer(palletProductId, slotProductId, duration)
      );
      return;
    }

    this.startTransfer(palletProductId, slotProductId, duration);
  }

  private startTransfer(palletProductId: string, slotProductId: string, duration: number) {
    const pallet = productById(palletProductId);
    this.stockOf(palletProductId).reserveUnits -= pallet.unitsPerPallet;
    // Damaged units flow with the pallet (realistic only — the map is empty otherwise).
    const dmg = Math.min(pallet.unitsPerPallet, this.damagedReserve.get(palletProductId) ?? 0);
    if (dmg > 0) {
      this.damagedReserve.set(palletProductId, (this.damagedReserve.get(palletProductId) ?? 0) - dmg);
      this.damagedPicking.set(slotProductId, (this.damagedPicking.get(slotProductId) ?? 0) + dmg);
    }
    this.transferJobs.push({
      productId: slotProductId,
      units: pallet.unitsPerPallet,
      finishAt: this.now + duration,
    });
  }

  approcheSend(taskId: string) {
    const task = this.approcheTasks.find((t) => t.id === taskId);
    if (!task || task.status !== "pending") throw new Error("Demande d'approche inconnue");
    const product = productById(task.productId);
    const s = this.stockOf(task.productId);
    const units = product.unitsPerPallet * task.pallets;
    if (s.reserveUnits < units) throw new Error(`Réserve insuffisante (${s.reserveUnits}/${units} u.)`);
    s.reserveUnits -= units;
    task.status = "done";
    const order = this.orders.find((o) => o.id === task.orderId);
    this.schedule(APPROCHE_MS, () => {
      if (order?.fullPallet) order.fullPallet.fulfilled = true;
      this.toast("dispatcher", `Approche à quai : ${task.pallets} palette(s) ${task.productId} pour ${task.orderLabel}`, "info");
    });
  }

  resolveAnomaly(anomalyId: string) {
    const a = this.anomalies.find((x) => x.id === anomalyId && x.status === "visible");
    if (!a) throw new Error("Anomalie inconnue ou déjà traitée");
    if (a.kind === "slot_mismatch" && a.productId) {
      // Swap the foreign pallet back: slot emptied, units return to reserve.
      const slot = this.stockOf(a.productId);
      const physical = this.slotPhysical.get(a.productId);
      if (physical) {
        const units = Math.min(slot.pickingUnits, productById(physical).unitsPerPallet);
        slot.pickingUnits -= units;
        this.stockOf(physical).reserveUnits += units;
        this.slotPhysical.delete(a.productId);
        this.slotRevealed.delete(a.productId);
        this.toast("picker", `Emplacement ${a.productId} corrigé — palette ${physical} retournée en réserve`, "info");
      }
    }
    a.status = "resolved";
  }

  // =========================================================================
  // PICKING — plan de prélèvement, picking, contrôle
  // =========================================================================

  planRoute(orderId: string, sequence: string[]) {
    const order = this.orderOf(orderId);
    if (order.status !== "queued") throw new Error("Commande déjà planifiée");
    const expected = order.lines.map((l) => l.productId).sort();
    if ([...sequence].sort().join() !== expected.join()) throw new Error("Le plan doit couvrir chaque produit de la commande, une fois");

    const cells = sequence.map((pid) => productById(pid).cell);
    const dist = tourDistance(cells);
    const optimal = optimalTour(order.lines.map((l) => productById(l.productId).cell));
    order.planDistance = dist;
    order.optimalDistance = optimal;

    let usedDist = dist;
    if (dist > optimal) {
      this.fault(
        "suboptimalRoute",
        "picker",
        "Plan de prélèvement",
        `Plan de ${dist} cases (optimal : ${optimal})`,
        "Le superviseur a réordonné la tournée au plus court",
        () => {
          usedDist = optimal;
        },
        () => {
          // Realistic: you walk the route you planned.
        }
      );
    }
    order.status = "transit";
    order.transitUntil = this.now + usedDist * MS_PER_CELL;
  }

  pickAssign(orderId: string, slotProductId: string, qty: number) {
    const order = this.orderOf(orderId);
    if (order.status !== "picking") throw new Error("Commande non disponible au picking");
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantité invalide");
    const slot = this.stockOf(slotProductId);

    // Realistic cascade: the slot physically contains another product.
    const physical = this.slotPhysical.get(slotProductId);
    if (physical && !this.slotRevealed.has(slotProductId)) {
      this.slotRevealed.add(slotProductId);
      this.addAnomaly(
        "slot_mismatch",
        "replenisher",
        `Emplacement picking ${slotProductId} : le système annonce ${slotProductId} mais la palette contient ${physical}. Signalé au stock pour échange.`,
        slotProductId,
        order.id
      );
      throw new Error(`Anomalie : l'emplacement ${slotProductId} contient ${physical} — signalé au stock`);
    }

    if (slot.pickingUnits < qty) {
      // Stock-out.
      if (this.mode.supervisor) {
        const p = productById(slotProductId);
        if (slot.reserveUnits >= p.unitsPerPallet) {
          this.fault(
            "pickingStarved",
            "replenisher",
            "Rempotage",
            `Rupture picking sur ${slotProductId} au moment du prélèvement`,
            "Le superviseur a rempoté une palette en urgence",
            () => {
              slot.reserveUnits -= p.unitsPerPallet;
              slot.pickingUnits += p.unitsPerPallet;
            },
            () => {}
          );
        }
      }
      if (slot.pickingUnits < qty) {
        if (!this.mode.supervisor && !this.anomalies.some((a) => a.kind === "stockout" && a.productId === slotProductId && a.orderId === order.id && a.status === "visible")) {
          this.addAnomaly(
            "stockout",
            "picker",
            `Rupture picking : ${slotProductId} (${slot.pickingUnits} u. restantes pour ${qty} demandées) — réappro d'urgence, partiel ou report ?`,
            slotProductId,
            order.id
          );
        }
        throw new Error(`Stock picking insuffisant : ${slot.pickingUnits} u. de ${slotProductId}`);
      }
    }

    const line = order.lines.find((l) => l.productId === slotProductId);
    if (!line) {
      this.fault(
        "wrongProductPicked",
        "picker",
        "Picking",
        `${qty} u. de ${slotProductId} affectées à ${order.label} qui ne le demande pas`,
        "Le superviseur a remis le produit en stock",
        () => {},
        () => {
          slot.pickingUnits -= qty;
          order.defects.push(`${qty} u. de ${slotProductId} non commandées dans la palette`);
        }
      );
      return;
    }

    slot.pickingUnits -= qty;
    line.preparedQty += qty;
    if (physical) line.preparedProductId = physical;
    const dmgAvail = this.damagedPicking.get(slotProductId) ?? 0;
    const dmg = Math.min(qty, dmgAvail);
    if (dmg > 0) {
      this.damagedPicking.set(slotProductId, dmgAvail - dmg);
      line.damagedUnits += dmg;
    }
  }

  stockoutAction(orderId: string, productId: string, action: "emergency" | "partial" | "postpone") {
    const order = this.orderOf(orderId);
    const anomaly = this.anomalies.find(
      (a) => a.kind === "stockout" && a.orderId === orderId && a.productId === productId && a.status === "visible"
    );
    if (!anomaly) throw new Error("Pas de rupture signalée sur cette ligne");
    anomaly.status = "resolved";

    if (action === "emergency") {
      const p = productById(productId);
      const s = this.stockOf(productId);
      if (s.reserveUnits < p.unitsPerPallet) throw new Error("Réserve vide — réappro d'urgence impossible");
      this.startTransfer(productId, productId, TRANSFER_MS);
      this.toast("replenisher", `🚨 Réappro d'URGENCE demandé par le picking : ${productId}`, "alert");
      this.toast("picker", `Réappro d'urgence lancé (${TRANSFER_MS / 1000} s)`, "info");
    } else if (action === "partial") {
      const line = order.lines.find((l) => l.productId === productId);
      if (line) line.short = true;
      this.toast("picker", `${order.label} : ligne ${productId} validée en partiel`, "warn");
    } else {
      order.status = "queued";
      order.transitUntil = null;
      this.toast("picker", `${order.label} reportée en fin de file`, "warn");
    }
  }

  pickControl(orderId: string, conformMarks: Record<string, boolean>) {
    const order = this.orderOf(orderId);
    if (order.status !== "picking") throw new Error("Commande non disponible au contrôle");

    let anyReset = false;
    for (const line of order.lines) {
      const marked = conformMarks[line.productId];
      if (marked === undefined) throw new Error("Chaque ligne doit être contrôlée");
      const trulyConform =
        line.short ||
        (line.preparedQty === line.qty &&
          line.damagedUnits === 0 &&
          (line.preparedProductId === null || line.preparedProductId === line.productId));

      if (marked && !trulyConform) {
        const what =
          line.preparedProductId && line.preparedProductId !== line.productId
            ? `mauvais produit (${line.preparedProductId})`
            : line.damagedUnits > 0
              ? `${line.damagedUnits} u. endommagées`
              : `quantité ${line.preparedQty}/${line.qty}`;
        this.fault(
          "controlMissed",
          "picker",
          "Contrôle picking",
          `Ligne ${line.productId} validée conforme : ${what}`,
          "Le superviseur a corrigé la ligne avant expédition",
          () => {
            line.preparedQty = line.qty;
            line.damagedUnits = 0;
            line.preparedProductId = null;
          },
          () => {
            order.defects.push(`Ligne ${line.productId} : ${what}`);
          }
        );
      } else if (!marked && trulyConform) {
        this.charge("controlFalseAlarm", "picker", line.productId);
        this.resetLine(line);
        anyReset = true;
      } else if (!marked && !trulyConform) {
        // Correct catch: the line goes back to picking, damage discarded.
        this.resetLine(line);
        anyReset = true;
      }
    }

    if (anyReset) {
      order.status = "picking";
      this.toast("picker", `${order.label} : ligne(s) non conformes à re-préparer`, "warn");
      return;
    }
    order.status = "staged";
    if (this.stagingIncidents.delete(order.id)) {
      order.defects.push("Film de palettisation déchiré au transfert vers le quai");
    }
    this.toast("dispatcher", `${order.label} (${order.client}) à quai — ${order.destination}, ${order.weight} kg${order.priority === "haute" ? ", PRIORITÉ HAUTE" : ""}`, "info");
  }

  private resetLine(line: OrderLine) {
    const clean = Math.max(0, line.preparedQty - line.damagedUnits);
    if (line.preparedProductId && line.preparedProductId !== line.productId) {
      this.stockOf(line.preparedProductId).reserveUnits += line.preparedQty;
    } else {
      this.stockOf(line.productId).pickingUnits += clean;
    }
    line.preparedQty = 0;
    line.damagedUnits = 0;
    line.preparedProductId = null;
    line.short = false;
  }

  // =========================================================================
  // EXPÉDITION — planification camions, contrôle palettes, chargement
  // =========================================================================

  assignTruck(orderId: string, truckId: string) {
    const order = this.orderOf(orderId);
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    if (order.status !== "staged" || order.truckId) throw new Error("Commande non disponible à la planification");
    if (!truck || truck.status !== "loading" || truck.loadingClosed) throw new Error("Camion indisponible");
    if (order.fullPallet && !order.fullPallet.fulfilled) throw new Error("Palette d'approche pas encore à quai");

    const assignedWeight = truck.assignedOrderIds
      .map((id) => this.orders.find((o) => o.id === id)!)
      .reduce((a, o) => a + o.weight, 0);
    if (assignedWeight + order.weight > truck.maxWeight) {
      throw new Error(`Capacité dépassée : ${assignedWeight + order.weight} kg > ${truck.maxWeight} kg`);
    }

    if (order.destination !== truck.destination) {
      this.fault(
        "wrongDestination",
        "dispatcher",
        "Planification expédition",
        `${order.label} (${order.destination}) affectée au camion ${truck.label} (${truck.destination})`,
        "Le superviseur a refusé l'affectation",
        () => {},
        () => {
          order.truckId = truck.id;
          truck.assignedOrderIds.push(order.id);
        }
      );
      return;
    }

    order.truckId = truck.id;
    truck.assignedOrderIds.push(order.id);
  }

  unassignTruck(orderId: string) {
    const order = this.orderOf(orderId);
    if (!order.truckId || order.status !== "staged") throw new Error("Commande non affectée");
    const truck = this.outboundTrucks.find((t) => t.id === order.truckId);
    if (!truck || truck.loadingClosed || truck.loadedOrderIds.includes(order.id)) throw new Error("Trop tard pour désaffecter");
    truck.assignedOrderIds = truck.assignedOrderIds.filter((id) => id !== order.id);
    order.truckId = null;
    order.expeditionChecked = false;
  }

  palletCheck(orderId: string, approve: boolean) {
    const order = this.orderOf(orderId);
    if (order.status !== "staged" || !order.truckId) throw new Error("Commande non affectée à un camion");
    if (order.expeditionChecked) throw new Error("Palette déjà contrôlée");
    const trulyGood = order.defects.length === 0;

    if (approve && !trulyGood) {
      this.fault(
        "expeditionCheckMissed",
        "dispatcher",
        "Contrôle palettes",
        `${order.label} approuvée malgré : ${order.defects.join(" ; ")}`,
        "Le superviseur a fait re-préparer la palette",
        () => {
          order.defects = [];
          order.expeditionChecked = true;
        },
        () => {
          order.expeditionChecked = true; // ships with its defects
        }
      );
      return;
    }
    if (!approve && trulyGood) {
      this.charge("expeditionFalseAlarm", "dispatcher", order.label);
      this.reprepJobs.push({ orderId: order.id, finishAt: this.now + REPREP_MS });
      this.toast("dispatcher", `${order.label} renvoyée en re-préparation (${REPREP_MS / 1000} s)`, "warn");
      return;
    }
    if (!approve && !trulyGood) {
      // Correct catch: re-preparation fixes the defects.
      this.reprepJobs.push({ orderId: order.id, finishAt: this.now + REPREP_MS });
      this.toast("dispatcher", `${order.label} refusée à juste titre — re-préparation (${REPREP_MS / 1000} s)`, "info");
      return;
    }
    order.expeditionChecked = true;
  }

  loadItem(truckId: string, orderId: string) {
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    const order = this.orderOf(orderId);
    if (!truck || truck.status !== "loading" || truck.loadingClosed) throw new Error("Camion indisponible au chargement");
    if (order.truckId !== truck.id || order.status !== "staged") throw new Error("Commande non affectée à ce camion");
    if (!order.expeditionChecked) throw new Error("Palette non contrôlée — contrôle obligatoire avant chargement");
    truck.loadedOrderIds.push(order.id);
    order.status = "loaded";
  }

  closeLoading(truckId: string) {
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    if (!truck || truck.status !== "loading" || truck.loadingClosed) throw new Error("Camion indisponible");
    if (truck.loadedOrderIds.length === 0) throw new Error("Aucun colis chargé");

    // Loading order rule: what is loaded later sits ON TOP. A fragile parcel
    // followed by a heavier one means it gets crushed.
    const loaded = truck.loadedOrderIds.map((id) => this.orders.find((o) => o.id === id)!);
    let violations = 0;
    for (let i = 0; i < loaded.length; i++) {
      if (!this.orderFragile(loaded[i])) continue;
      for (let j = i + 1; j < loaded.length; j++) {
        if (!this.orderFragile(loaded[j]) && loaded[j].weight > loaded[i].weight) violations++;
      }
    }
    for (let v = 0; v < Math.min(violations, 3); v++) {
      this.fault(
        "crushedLoad",
        "dispatcher",
        "Chargement",
        "Colis fragile chargé avant un colis plus lourd",
        "Le superviseur a réordonné le chargement",
        () => {},
        () => {
          const fragile = loaded.find((o) => this.orderFragile(o));
          if (fragile && !fragile.defects.includes("Colis écrasé au chargement")) {
            fragile.defects.push("Colis écrasé au chargement");
          }
        }
      );
    }
    truck.loadingClosed = true;
  }

  dispatchTruck(truckId: string) {
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    if (!truck || truck.status !== "loading") throw new Error("Camion indisponible");
    // An empty truck can be sent away to free the bay for another destination.
    const empty = truck.assignedOrderIds.length === 0 && truck.loadedOrderIds.length === 0;
    if (!truck.loadingClosed && !empty) throw new Error("Clôturez d'abord le chargement");
    this.departTruck(truck, false);
  }

  // =========================================================================
  // TELEMETRY
  // =========================================================================

  private sampleTelemetry() {
    const waiting = this.inboundTrucks.filter((t) => t.status === "waiting").length;
    const pendingLines = this.inboundTrucks
      .filter((t) => t.status === "docked")
      .reduce((a, t) => a + t.lines.filter((l) => l.decision === "pending").length, 0);
    const reapproNeeded = this.stock.filter((s) => s.reserveUnits + s.onOrderUnits < s.reserveMin).length;
    const belowPickMin = this.stock.filter((s) => s.pickingUnits < s.pickMin).length;
    const approchePending = this.approcheTasks.filter((t) => t.status === "pending").length;
    const pickingWork = this.orders.filter((o) => ["queued", "transit", "picking", "control"].includes(o.status)).length;
    const expeditionWork = this.orders.filter((o) => ["staged", "loaded"].includes(o.status)).length;

    const pressures: Record<Stage, number> = {
      reception: Math.min(1, waiting * 0.4 + pendingLines * 0.06 + this.putawayTasks.length * 0.12),
      stock: Math.min(1, reapproNeeded * 0.18 + belowPickMin * 0.2 + approchePending * 0.2),
      picking: Math.min(1, pickingWork * 0.2),
      expedition: Math.min(1, expeditionWork * 0.22),
    };

    const key = Math.floor(this.now / HEATMAP_BUCKET_MS);
    let acc = this.buckets.get(key);
    if (!acc) {
      acc = { sums: { reception: 0, stock: 0, picking: 0, expedition: 0 }, count: 0 };
      this.buckets.set(key, acc);
    }
    for (const s of Object.keys(pressures) as Stage[]) acc.sums[s] += pressures[s];
    acc.count++;
  }

  // =========================================================================
  // SERIALIZATION — private truth stripped
  // =========================================================================

  serialize(): TeamState {
    return {
      teamId: this.teamId,
      teamName: this.teamName,
      difficulty: this.difficulty,
      clock: { now: this.now, durationMs: this.mode.durationMs },
      roleTimers: this.roleTimers,
      cost: this.cost,
      shippedCount: this.orders.filter((o) => o.status === "shipped").length,
      orderCount: this.orders.length,
      supervisorCount: this.supervisorEvents.length,
      docks: this.docks,
      inboundTrucks: this.inboundTrucks,
      putawayTasks: this.putawayTasks,
      stock: this.stock,
      transferJobs: this.transferJobs,
      approcheTasks: this.approcheTasks,
      orders: this.orders,
      outboundTrucks: this.outboundTrucks,
      anomalies: this.anomalies.filter((a) => a.status === "visible"),
      players: this.players,
    };
  }
}
