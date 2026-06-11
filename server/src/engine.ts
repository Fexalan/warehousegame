/**
 * TeamEngine — the authoritative simulation for ONE team.
 *
 * Clients never mutate state. They send *intents* ("swipe pallet P right",
 * "run route R for order O"); the engine validates, mutates, and the new
 * snapshot is broadcast to the whole team. That single rule is what makes
 * the asymmetric ripple effect work: a slow Receiver is *visible* to the
 * Picker because they share one source of truth.
 */
import {
  COSTS,
  DEPOT,
  GAME_DURATION_MS,
  HEATMAP_BUCKET_MS,
  MS_PER_CELL,
  PICK_MS_PER_LINE,
  RACK_BLOCK_CLUSTERS,
  SKUS,
  STAGING,
  TRANSFER_MS,
  TRUCK_RESPAWN_MS,
  TRUCK_WAIT_CHARGE_MS,
  cellEq,
  cellKey,
  isWalkable,
  skuById,
} from "../../shared/constants";
import type {
  AbcZone,
  ActiveRoute,
  Cell,
  CostEvent,
  Curveball,
  CurveballKind,
  Dock,
  InboundTruck,
  Order,
  OutboundTruck,
  Pallet,
  PlayerInfo,
  RoleId,
  Stage,
  StockLevel,
  TeamState,
  TransferJob,
} from "../../shared/types";
import { Rng, intBetween, mulberry32, pick } from "./rng";
import { OutboundSpec, Scenario, generateScenario } from "./scenario";

export interface RoleToast {
  role: RoleId | "all";
  message: string;
  severity: "info" | "warn" | "alert";
}

/** Per-tick output the socket layer routes to the right role channels. */
export interface TickEffects {
  toasts: RoleToast[];
  curveballs: Curveball[];
  gameOver: boolean;
}

interface BucketAcc {
  sums: Record<Stage, number>;
  count: number;
}

export class TeamEngine {
  readonly teamId: string;
  readonly teamName: string;
  players: PlayerInfo[] = [];

  // ----- public world state (serialized into TeamState) -----
  now = 0;
  cost = 0;
  docks: Dock[] = [
    { id: "d1", label: "Dock 1", truckId: null },
    { id: "d2", label: "Dock 2", truckId: null },
  ];
  inboundTrucks: InboundTruck[] = [];
  inboundBuffer: Pallet[] = [];
  stock: StockLevel[];
  orders: Order[] = [];
  outboundTrucks: OutboundTruck[] = [];
  blockedCells: Cell[] = [];
  activeRoute: ActiveRoute | null = null;
  transferJobs: TransferJob[] = [];
  curveballs: Curveball[] = [];

  // ----- private truth the players must discover -----
  private damagedPallets = new Set<string>();
  private ghostSkuId: string | null = null; // WMS shows stock, location is empty
  private ghostDiscovered = false;

  // ----- scenario & bookkeeping -----
  private scenario: Scenario;
  private rng: Rng;
  private nextTruckIdx = 0;
  private nextOrderIdx = 0;
  private nextOutboundIdx = 0;
  private nextCurveballIdx = 0;
  private outboundRespawnAt: number[] = [];
  private rackBlockUntil = 0;
  private idCounter = 0;
  private truckWaitCharged = new Map<string, number>(); // truckId -> ms already billed
  private prevNow = 0;

  // ----- analytics (consumed by kpi.ts) -----
  costLog: CostEvent[] = [];
  dockBusyMs = 0;
  truckWaitsMs: number[] = [];
  trucksServed = 0;
  wrongDestOrders = new Set<string>();
  buckets = new Map<number, BucketAcc>();

  private effects: TickEffects = { toasts: [], curveballs: [], gameOver: false };

  constructor(teamId: string, teamName: string, seed: number) {
    this.teamId = teamId;
    this.teamName = teamName;
    this.scenario = generateScenario(seed);
    // Engine-local rng (curveball target picks); offset so it diverges from scenario gen.
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.stock = SKUS.map((s) => ({ skuId: s.id, reserve: 60, pick: 25, min: 12, max: 40 }));
    // Three loading bays: with three destinations in play, dispatch should be
    // a planning problem, not a lottery.
    this.spawnOutbound(0);
    this.spawnOutbound(0);
    this.spawnOutbound(0);
  }

  private newId(prefix: string): string {
    return `${prefix}-${this.teamId}-${++this.idCounter}`;
  }

  private toast(role: RoleId | "all", message: string, severity: RoleToast["severity"] = "info") {
    this.effects.toasts.push({ role, message, severity });
  }

  private charge(key: keyof typeof COSTS, role: RoleId, detail?: string) {
    const { label, amount } = COSTS[key];
    this.cost += amount;
    this.costLog.push({ at: this.now, label: detail ? `${label} — ${detail}` : label, amount, role });
  }

  private stockOf(skuId: string): StockLevel {
    const s = this.stock.find((x) => x.skuId === skuId);
    if (!s) throw new Error(`Unknown SKU ${skuId}`);
    return s;
  }

  // =========================================================================
  // TICK — the continuous-flow heartbeat (4 Hz)
  // =========================================================================

  tick(now: number): TickEffects {
    this.effects = { toasts: [], curveballs: [], gameOver: false };
    const dt = now - this.prevNow;
    this.prevNow = now;
    this.now = now;

    this.spawnDueTrucks();
    this.spawnDueOrders();
    this.fireDueCurveballs();
    this.completeDueJobs();
    this.departDueOutbound();
    this.accrueTruckWaitCosts();
    this.clearExpiredRackBlock();
    this.dockBusyMs += dt * this.docks.filter((d) => d.truckId).length;
    this.sampleTelemetry();

    if (now >= GAME_DURATION_MS) {
      this.finalizePenalties();
      this.effects.gameOver = true;
    }
    return this.effects;
  }

  private spawnDueTrucks() {
    while (
      this.nextTruckIdx < this.scenario.trucks.length &&
      this.scenario.trucks[this.nextTruckIdx].at <= this.now
    ) {
      const spec = this.scenario.trucks[this.nextTruckIdx++];
      const truck: InboundTruck = {
        id: this.newId("itrk"),
        label: `TRK-${10 + this.nextTruckIdx}`,
        arrivedAt: this.now,
        dockId: null,
        status: "waiting",
        pallets: spec.pallets.map((p) => {
          const pallet: Pallet = {
            id: this.newId("plt"),
            skuId: p.skuId,
            qty: p.qty,
            cues: p.cues,
            status: "on_truck",
          };
          if (p.damaged) this.damagedPallets.add(pallet.id);
          return pallet;
        }),
      };
      this.inboundTrucks.push(truck);
      this.toast("receiver", `${truck.label} arrived in the yard (${truck.pallets.length} pallets)`, "info");
    }
  }

  private spawnDueOrders() {
    while (
      this.nextOrderIdx < this.scenario.orders.length &&
      this.scenario.orders[this.nextOrderIdx].at <= this.now
    ) {
      const spec = this.scenario.orders[this.nextOrderIdx++];
      this.createOrder(spec.clientName, spec.destination, spec.lines, spec.deadline, false);
    }
  }

  private createOrder(
    clientName: string,
    destination: string,
    lines: { skuId: string; qty: number }[],
    deadline: number,
    priority: boolean
  ): Order {
    let weight = 0;
    let volume = 0;
    for (const l of lines) {
      const sku = skuById(l.skuId);
      weight += sku.unitWeight * l.qty;
      volume += sku.unitVolume * l.qty;
    }
    const order: Order = {
      id: this.newId("ord"),
      label: `#${100 + this.orders.length + 1}`,
      clientName,
      destination,
      lines: lines.map((l) => ({ ...l, picked: 0 })),
      createdAt: this.now,
      deadline,
      priority,
      status: "queued",
      weight: Math.round(weight),
      volume: Math.round(volume * 100) / 100,
      stockoutFlag: false,
      assignedTruckId: null,
      shippedAt: null,
    };
    this.orders.push(order);
    if (!priority) this.toast("picker", `New order ${order.label} from ${clientName}`, "info");
    return order;
  }

  private spawnOutbound(at: number) {
    const spec: OutboundSpec =
      this.scenario.outbound[Math.min(this.nextOutboundIdx++, this.scenario.outbound.length - 1)];
    this.outboundTrucks.push({
      id: this.newId("otrk"),
      label: `OUT-${20 + this.nextOutboundIdx}`,
      destination: spec.destination,
      departsAt: at + spec.lifeMs,
      maxWeight: spec.maxWeight,
      maxVolume: Math.round(spec.maxVolume * 100) / 100,
      loadedOrderIds: [],
      status: "loading",
    });
  }

  private completeDueJobs() {
    // Replenishment transfers landing
    for (const job of [...this.transferJobs]) {
      if (job.finishAt > this.now) continue;
      this.transferJobs = this.transferJobs.filter((j) => j !== job);
      const s = this.stockOf(job.skuId);
      if (this.ghostSkuId === job.skuId && !this.ghostDiscovered) {
        // Physical stock arrives before anyone noticed the discrepancy:
        // the transferred qty IS the real on-hand now. Quietly self-heals.
        s.pick = job.qty;
        this.resolveGhost(false);
      } else {
        s.pick += job.qty;
      }
      this.toast("replenisher", `Transfer done: +${job.qty} ${skuById(job.skuId).name} to pick face`, "info");
    }

    // Picker route landing
    if (this.activeRoute && this.activeRoute.finishAt <= this.now) {
      this.completeRoute(this.activeRoute);
      this.activeRoute = null;
    }

    // Outbound truck respawns
    this.outboundRespawnAt = this.outboundRespawnAt.filter((at) => {
      if (at > this.now) return true;
      this.spawnOutbound(this.now);
      return false;
    });
  }

  private completeRoute(route: ActiveRoute) {
    const order = this.orders.find((o) => o.id === route.orderId);
    if (!order) return;
    for (const line of order.lines) {
      const need = line.qty - line.picked;
      if (need <= 0) continue;
      const s = this.stockOf(line.skuId);
      if (this.ghostSkuId === line.skuId && !this.ghostDiscovered) {
        // The WMS lied. The picker just found an empty location.
        this.ghostDiscovered = true;
        order.stockoutFlag = true;
        const cb = this.curveballs.find((c) => c.kind === "ghost_pallet" && !c.resolved);
        if (cb) {
          cb.targets = ["picker"];
          cb.payload = { skuId: line.skuId, displayed: s.pick };
          this.effects.curveballs.push(cb);
        }
        this.toast(
          "picker",
          `GHOST PALLET! System shows ${s.pick} × ${skuById(line.skuId).name} but the location is EMPTY. Flag the discrepancy!`,
          "alert"
        );
        continue;
      }
      const take = Math.min(need, s.pick);
      s.pick -= take;
      line.picked += take;
      if (take < need) order.stockoutFlag = true;
    }
    const complete = order.lines.every((l) => l.picked >= l.qty);
    if (complete) {
      order.status = "staged";
      order.stockoutFlag = false;
      this.toast("dispatcher", `Order ${order.label} staged — ${order.destination}, ${order.weight}kg`, "info");
    } else {
      order.status = "queued"; // back to the queue: re-pick once stock is fixed
      this.toast("picker", `Order ${order.label} incomplete — stock-out. Back in queue.`, "warn");
    }
  }

  private departDueOutbound() {
    for (const truck of this.outboundTrucks.filter((t) => t.status === "loading")) {
      if (truck.departsAt <= this.now) this.departTruck(truck, true);
    }
  }

  private departTruck(truck: OutboundTruck, auto: boolean) {
    truck.status = "departed";
    let shipped = 0;
    for (const oid of truck.loadedOrderIds) {
      const order = this.orders.find((o) => o.id === oid);
      if (!order) continue;
      order.status = "shipped";
      order.shippedAt = this.now;
      shipped++;
      if (this.now > order.deadline) this.charge("lateShipment", "dispatcher", order.label);
      if (order.destination !== truck.destination) {
        this.wrongDestOrders.add(order.id);
        this.charge("wrongDestination", "dispatcher", `${order.label} → ${truck.destination}`);
      }
      const rush = this.curveballs.find(
        (c) => c.kind === "rush_order" && !c.resolved && c.payload.orderId === order.id
      );
      if (rush) rush.resolved = true;
    }
    this.outboundTrucks = this.outboundTrucks.filter((t) => t !== truck);
    this.outboundRespawnAt.push(this.now + TRUCK_RESPAWN_MS);
    this.toast(
      "dispatcher",
      auto
        ? `${truck.label} left on schedule with ${shipped} order(s)${shipped === 0 ? " — EMPTY truck!" : ""}`
        : `${truck.label} dispatched with ${shipped} order(s)`,
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

  private clearExpiredRackBlock() {
    if (this.blockedCells.length > 0 && this.now >= this.rackBlockUntil) {
      this.blockedCells = [];
      const cb = this.curveballs.find((c) => c.kind === "damaged_rack" && !c.resolved);
      if (cb) cb.resolved = true;
      this.toast("picker", "Aisle cleared — all routes open again", "info");
    }
  }

  private finalizePenalties() {
    for (const order of this.orders) {
      if (order.status !== "shipped" && this.now > order.deadline) {
        order.status = "missed";
        this.charge("missedOrder", "dispatcher", order.label);
      }
    }
    for (const truck of this.inboundTrucks.filter((t) => t.status === "waiting")) {
      this.truckWaitsMs.push(this.now - truck.arrivedAt);
    }
  }

  // =========================================================================
  // CURVEBALL INJECTOR — seeded schedule, role-targeted broadcast
  // =========================================================================

  private fireDueCurveballs() {
    while (
      this.nextCurveballIdx < this.scenario.curveballs.length &&
      this.scenario.curveballs[this.nextCurveballIdx].at <= this.now
    ) {
      const spec = this.scenario.curveballs[this.nextCurveballIdx++];
      this.fireCurveball(spec.kind);
    }
  }

  private fireCurveball(kind: CurveballKind) {
    const cb: Curveball = {
      id: this.newId("cb"),
      kind,
      firedAt: this.now,
      targets: [],
      resolved: false,
      payload: {},
    };

    switch (kind) {
      case "rush_order": {
        // VIP order with a brutal deadline. Destination matches the freshest
        // outbound truck so dispatch IS feasible — if the team reacts fast.
        const truck = [...this.outboundTrucks]
          .filter((t) => t.status === "loading")
          .sort((a, b) => b.departsAt - a.departsAt)[0];
        const destination = truck ? truck.destination : "Lyon";
        const sku = pick(this.rng, this.stock.filter((s) => s.pick >= 8).map((s) => s.skuId)) ?? "a1";
        const order = this.createOrder(
          "VIP — MegaCorp",
          destination,
          [{ skuId: sku, qty: intBetween(this.rng, 4, 8) }],
          this.now + 45_000,
          true
        );
        cb.targets = ["dispatcher", "picker"];
        cb.payload = { orderId: order.id, label: order.label, deadline: order.deadline };
        this.toast("dispatcher", `🚨 RUSH ORDER ${order.label} (VIP) — ships to ${destination} in 45s. Alert your picker!`, "alert");
        break;
      }
      case "damaged_rack": {
        const cluster = pick(this.rng, RACK_BLOCK_CLUSTERS);
        this.blockedCells = [...cluster];
        this.rackBlockUntil = this.now + 75_000;
        cb.targets = ["picker"];
        cb.payload = { cells: cluster, until: this.rackBlockUntil };
        // Ripple: if the current route crosses the wreck, it dies instantly.
        if (this.activeRoute) {
          const blocked = new Set(cluster.map(cellKey));
          if (this.activeRoute.path.some((c) => blocked.has(cellKey(c)))) {
            const order = this.orders.find((o) => o.id === this.activeRoute!.orderId);
            if (order) order.status = "queued";
            this.activeRoute = null;
            this.toast("picker", "💥 Forklift accident! Your route crosses the wreck — REDRAW NOW.", "alert");
          } else {
            this.toast("picker", "💥 Forklift accident — an aisle is blocked for 75s.", "alert");
          }
        } else {
          this.toast("picker", "💥 Forklift accident — an aisle is blocked for 75s.", "alert");
        }
        break;
      }
      case "ghost_pallet": {
        // Silent sabotage: the WMS keeps displaying stock for a SKU whose
        // location is physically empty. Nobody is told — the Picker will
        // discover it mid-route and must flag it to the Replenisher.
        const candidates = this.stock.filter((s) => s.pick >= 8 && s.skuId !== this.ghostSkuId);
        if (candidates.length === 0) return; // nothing worth haunting
        this.ghostSkuId = pick(this.rng, candidates).skuId;
        this.ghostDiscovered = false;
        // targets stay [] => invisible in client state until discovered
        break;
      }
    }

    this.curveballs.push(cb);
    if (cb.targets.length > 0) this.effects.curveballs.push(cb);
  }

  private resolveGhost(announce: boolean) {
    const cb = this.curveballs.find((c) => c.kind === "ghost_pallet" && !c.resolved);
    if (cb) cb.resolved = true;
    if (announce && this.ghostSkuId) {
      this.toast(
        "replenisher",
        `🚨 INVENTORY DISCREPANCY flagged by picker: ${skuById(this.ghostSkuId).name} pick face is actually EMPTY. Emergency transfer needed!`,
        "alert"
      );
    }
    this.ghostSkuId = null;
    this.ghostDiscovered = false;
  }

  // =========================================================================
  // INTENT HANDLERS — one section per role
  // =========================================================================

  // ----- Receiver -----

  assignDock(truckId: string, dockId: string) {
    const truck = this.inboundTrucks.find((t) => t.id === truckId);
    const dock = this.docks.find((d) => d.id === dockId);
    if (!truck || truck.status !== "waiting") throw new Error("Truck not in the yard");
    if (!dock || dock.truckId) throw new Error("Dock occupied");
    dock.truckId = truck.id;
    truck.dockId = dock.id;
    truck.status = "docked";
    truck.pallets.forEach((p) => (p.status = "qc"));
    this.truckWaitsMs.push(this.now - truck.arrivedAt);
    this.trucksServed++;
  }

  qcSwipe(palletId: string, accept: boolean, zone?: AbcZone) {
    const truck = this.inboundTrucks.find((t) => t.pallets.some((p) => p.id === palletId));
    const pallet = truck?.pallets.find((p) => p.id === palletId);
    if (!truck || !pallet || pallet.status !== "qc") throw new Error("Pallet not at QC");
    const damaged = this.damagedPallets.has(pallet.id);

    if (accept) {
      if (!zone) throw new Error("Pick a put-away zone");
      pallet.status = "buffer";
      this.inboundBuffer.push(pallet);
      if (damaged) this.charge("damagedAccepted", "receiver", skuById(pallet.skuId).name);
      if (zone !== skuById(pallet.skuId).zone) this.charge("wrongZone", "receiver", skuById(pallet.skuId).name);
      this.toast("replenisher", `Pallet inbound: ${pallet.qty} × ${skuById(pallet.skuId).name}`, "info");
    } else {
      pallet.status = "rejected";
      if (!damaged) this.charge("goodRejected", "receiver", skuById(pallet.skuId).name);
    }

    // Truck fully worked? Free the dock for the next one in the yard.
    if (truck.pallets.every((p) => p.status !== "qc" && p.status !== "on_truck")) {
      truck.status = "departed";
      const dock = this.docks.find((d) => d.truckId === truck.id);
      if (dock) dock.truckId = null;
      this.inboundTrucks = this.inboundTrucks.filter((t) => t !== truck);
    }
  }

  // ----- Replenisher -----

  putaway(palletId: string, target: "reserve" | "pick") {
    const idx = this.inboundBuffer.findIndex((p) => p.id === palletId);
    if (idx < 0) throw new Error("Pallet not in buffer");
    const pallet = this.inboundBuffer[idx];
    this.inboundBuffer.splice(idx, 1);
    pallet.status = "stored";
    const s = this.stockOf(pallet.skuId);
    if (target === "reserve") {
      s.reserve += pallet.qty;
    } else {
      // Cross-dock straight to the pick face, capped by location max.
      if (this.ghostSkuId === pallet.skuId && !this.ghostDiscovered) {
        s.pick = 0; // restore physical truth before adding real units
        this.resolveGhost(false);
      }
      const space = Math.max(0, s.max - s.pick);
      const moved = Math.min(pallet.qty, space);
      s.pick += moved;
      const leftover = pallet.qty - moved;
      if (leftover > 0) {
        s.reserve += leftover;
        this.toast("replenisher", `Pick face full — ${leftover} units overflowed to reserve`, "warn");
      }
    }
  }

  transfer(skuId: string) {
    const s = this.stockOf(skuId);
    if (this.transferJobs.some((j) => j.skuId === skuId)) throw new Error("Transfer already running");
    const qty = Math.min(s.reserve, Math.max(0, s.max - s.pick));
    if (s.reserve <= 0) throw new Error("No reserve stock");
    if (qty <= 0) throw new Error("Pick face already at max");
    s.reserve -= qty;
    this.transferJobs.push({ skuId, qty, startedAt: this.now, finishAt: this.now + TRANSFER_MS });
  }

  // ----- Picker -----

  startRoute(orderId: string, path: Cell[]) {
    if (this.activeRoute) throw new Error("Already driving a route");
    const order = this.orders.find((o) => o.id === orderId);
    if (!order || order.status !== "queued") throw new Error("Order not in queue");
    this.validateRoute(order, path);
    order.status = "picking";
    const lines = order.lines.filter((l) => l.picked < l.qty).length;
    const duration = path.length * MS_PER_CELL + lines * PICK_MS_PER_LINE;
    this.activeRoute = { orderId, path, startedAt: this.now, finishAt: this.now + duration };
  }

  private validateRoute(order: Order, path: Cell[]) {
    if (path.length < 2) throw new Error("Draw a route first");
    if (!cellEq(path[0], DEPOT)) throw new Error("Route must start at the depot");
    if (!cellEq(path[path.length - 1], STAGING)) throw new Error("Route must end at staging");
    const blocked = new Set(this.blockedCells.map(cellKey));
    for (let i = 0; i < path.length; i++) {
      const c = path[i];
      if (!isWalkable(c.x, c.y)) throw new Error("Route leaves the corridors");
      if (blocked.has(cellKey(c))) throw new Error("Route crosses a blocked aisle");
      if (i > 0 && Math.abs(c.x - path[i - 1].x) + Math.abs(c.y - path[i - 1].y) !== 1)
        throw new Error("Route has gaps");
    }
    const visited = new Set(path.map(cellKey));
    for (const line of order.lines) {
      if (line.picked >= line.qty) continue;
      if (!visited.has(cellKey(skuById(line.skuId).cell)))
        throw new Error(`Route misses ${skuById(line.skuId).name}`);
    }
  }

  flagGhost(skuId: string) {
    if (this.ghostSkuId !== skuId || !this.ghostDiscovered) throw new Error("No discrepancy to flag here");
    const s = this.stockOf(skuId);
    s.pick = 0; // WMS corrected to physical truth
    this.resolveGhost(true);
    for (const o of this.orders) if (o.status === "queued") o.stockoutFlag = false;
    this.toast("picker", "Discrepancy flagged — replenisher alerted ✅", "info");
  }

  // ----- Dispatcher -----

  loadOrder(orderId: string, truckId: string) {
    const order = this.orders.find((o) => o.id === orderId);
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    if (!order || order.status !== "staged") throw new Error("Order not staged");
    if (!truck || truck.status !== "loading") throw new Error("Truck not loading");
    const loaded = truck.loadedOrderIds
      .map((id) => this.orders.find((o) => o.id === id)!)
      .filter(Boolean);
    const w = loaded.reduce((a, o) => a + o.weight, 0) + order.weight;
    const v = loaded.reduce((a, o) => a + o.volume, 0) + order.volume;
    if (w > truck.maxWeight) throw new Error(`Too heavy: ${w}kg > ${truck.maxWeight}kg max`);
    if (v > truck.maxVolume) throw new Error(`No volume left: ${v.toFixed(1)}m³ > ${truck.maxVolume}m³`);
    order.status = "loaded";
    order.assignedTruckId = truck.id;
    truck.loadedOrderIds.push(order.id);
  }

  unloadOrder(orderId: string) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order || order.status !== "loaded" || !order.assignedTruckId) throw new Error("Order not loaded");
    const truck = this.outboundTrucks.find((t) => t.id === order.assignedTruckId);
    if (!truck || truck.status !== "loading") throw new Error("Truck already gone");
    truck.loadedOrderIds = truck.loadedOrderIds.filter((id) => id !== orderId);
    order.status = "staged";
    order.assignedTruckId = null;
  }

  dispatchTruck(truckId: string) {
    const truck = this.outboundTrucks.find((t) => t.id === truckId);
    if (!truck || truck.status !== "loading") throw new Error("Truck not loading");
    this.departTruck(truck, false);
  }

  alertPicker(orderId: string) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error("Unknown order");
    const secs = Math.max(0, Math.round((order.deadline - this.now) / 1000));
    this.toast("picker", `🚨 DISPATCH: jump ${order.label} (${order.clientName}) to the FRONT — ${secs}s to deadline!`, "alert");
  }

  // =========================================================================
  // TELEMETRY — feeds the post-game Team Heatmap
  // =========================================================================

  private sampleTelemetry() {
    const waiting = this.inboundTrucks.filter((t) => t.status === "waiting").length;
    const qcPallets = this.inboundTrucks
      .filter((t) => t.status === "docked")
      .reduce((a, t) => a + t.pallets.filter((p) => p.status === "qc").length, 0);
    const belowMin = this.stock.filter((s) => s.pick < s.min).length;
    const queued = this.orders.filter((o) => o.status === "queued");
    const overdueQueued = queued.filter((o) => this.now > o.deadline).length;
    const staged = this.orders.filter((o) => o.status === "staged");
    const overdueStaged = staged.filter((o) => this.now > o.deadline).length;

    const pressures: Record<Stage, number> = {
      receiving: Math.min(1, waiting * 0.45 + qcPallets * 0.1),
      replenishment: Math.min(1, belowMin * 0.3 + this.inboundBuffer.length * 0.1),
      picking: Math.min(1, queued.length * 0.22 + overdueQueued * 0.2),
      dispatch: Math.min(1, staged.length * 0.3 + overdueStaged * 0.2),
    };

    const key = Math.floor(this.now / HEATMAP_BUCKET_MS);
    let acc = this.buckets.get(key);
    if (!acc) {
      acc = { sums: { receiving: 0, replenishment: 0, picking: 0, dispatch: 0 }, count: 0 };
      this.buckets.set(key, acc);
    }
    for (const stage of Object.keys(pressures) as Stage[]) acc.sums[stage] += pressures[stage];
    acc.count++;
  }

  // =========================================================================
  // SERIALIZATION — what goes on the wire (private truth stripped)
  // =========================================================================

  serialize(): TeamState {
    return {
      teamId: this.teamId,
      teamName: this.teamName,
      clock: { now: this.now, durationMs: GAME_DURATION_MS },
      cost: this.cost,
      shippedCount: this.orders.filter((o) => o.status === "shipped").length,
      orderCount: this.orders.length,
      docks: this.docks,
      inboundTrucks: this.inboundTrucks,
      inboundBuffer: this.inboundBuffer,
      stock: this.stock,
      orders: this.orders,
      outboundTrucks: this.outboundTrucks,
      blockedCells: this.blockedCells,
      activeRoute: this.activeRoute,
      transferJobs: this.transferJobs,
      // Undiscovered ghost pallets stay invisible — discovery is the lesson.
      curveballs: this.curveballs.filter((c) => c.targets.length > 0),
      players: this.players,
    };
  }
}
