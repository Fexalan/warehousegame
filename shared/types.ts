/**
 * Shared domain model for "The Ripple Effect".
 * Imported by both server (authoritative engine) and client (rendering).
 *
 * Anti-cheat note: fields the players must *discover* (pallet damage, ghost
 * stock) are intentionally NOT part of these wire types. The server keeps
 * them in private engine state and only the consequences are broadcast.
 */

export type RoleId = "receiver" | "replenisher" | "picker" | "dispatcher";
export type AbcZone = "A" | "B" | "C";
export type Stage = "receiving" | "replenishment" | "picking" | "dispatch";

export interface Cell {
  x: number;
  y: number;
}

export interface Sku {
  id: string;
  name: string;
  emoji: string;
  zone: AbcZone; // velocity class -> correct put-away zone
  cell: Cell; // pick point on the warehouse grid (walkable)
  unitWeight: number; // kg
  unitVolume: number; // m3
}

/** Inbound pallet. `cues` are the inspection hints shown on the QC swipe card. */
export interface Pallet {
  id: string;
  skuId: string;
  qty: number;
  cues: string[];
  status: "on_truck" | "qc" | "buffer" | "stored" | "rejected";
}

export interface InboundTruck {
  id: string;
  label: string;
  arrivedAt: number; // game-relative ms
  dockId: string | null;
  status: "waiting" | "docked" | "departed";
  pallets: Pallet[];
}

export interface Dock {
  id: string;
  label: string;
  truckId: string | null;
}

export interface StockLevel {
  skuId: string;
  reserve: number;
  pick: number; // what the WMS *displays* — a ghost-pallet curveball can make this lie
  min: number;
  max: number;
}

export interface OrderLine {
  skuId: string;
  qty: number;
  picked: number;
}

export interface Order {
  id: string;
  label: string;
  clientName: string;
  destination: string;
  lines: OrderLine[];
  createdAt: number;
  deadline: number; // game-relative ms
  priority: boolean; // rush orders
  status: "queued" | "picking" | "staged" | "loaded" | "shipped" | "missed";
  weight: number;
  volume: number;
  stockoutFlag: boolean; // picker hit a ghost pallet on this order
  assignedTruckId: string | null;
  shippedAt: number | null;
}

export interface OutboundTruck {
  id: string;
  label: string;
  destination: string;
  departsAt: number; // auto-departure deadline (game-relative ms)
  maxWeight: number;
  maxVolume: number;
  loadedOrderIds: string[];
  status: "loading" | "departed";
}

export interface ActiveRoute {
  orderId: string;
  path: Cell[];
  startedAt: number;
  finishAt: number;
}

export interface TransferJob {
  skuId: string;
  qty: number;
  startedAt: number;
  finishAt: number;
}

export type CurveballKind = "rush_order" | "damaged_rack" | "ghost_pallet";

export interface Curveball {
  id: string;
  kind: CurveballKind;
  firedAt: number;
  targets: RoleId[];
  resolved: boolean;
  /** kind-specific public payload (rush: orderId, rack: cells+until, ghost: skuId once discovered) */
  payload: Record<string, unknown>;
}

export interface PlayerInfo {
  name: string;
  role: RoleId;
  connected: boolean;
}

/** Full team snapshot broadcast to all 4 role screens (each renders its slice). */
export interface TeamState {
  teamId: string;
  teamName: string;
  clock: { now: number; durationMs: number };
  cost: number;
  shippedCount: number;
  orderCount: number;
  docks: Dock[];
  inboundTrucks: InboundTruck[];
  inboundBuffer: Pallet[];
  stock: StockLevel[];
  orders: Order[];
  outboundTrucks: OutboundTruck[];
  blockedCells: Cell[];
  activeRoute: ActiveRoute | null;
  transferJobs: TransferJob[];
  curveballs: Curveball[];
  players: PlayerInfo[];
}

// ---------------------------------------------------------------------------
// End-of-game educational report
// ---------------------------------------------------------------------------

export interface CostEvent {
  at: number;
  label: string;
  amount: number;
  role: RoleId;
}

export interface HeatmapBucket {
  /** bucket start, game-relative ms */
  t: number;
  /** 0..1 pressure per stage (how "backed up" that stage was) */
  pressures: Record<Stage, number>;
  /** stage that was the bottleneck during this bucket, if any */
  bottleneck: Stage | null;
}

export interface TeamReport {
  teamId: string;
  teamName: string;
  score: number;
  otif: { pct: number; onTimeInFull: number; total: number; shipped: number };
  dockUtilization: { busyPct: number; avgWaitSec: number; maxWaitSec: number; trucksServed: number };
  errorCost: {
    total: number;
    breakdown: { label: string; count: number; amount: number }[];
    log: CostEvent[];
  };
  heatmap: { bucketMs: number; buckets: HeatmapBucket[] };
  insights: string[];
}

// ---------------------------------------------------------------------------
// Socket protocol
// ---------------------------------------------------------------------------

export interface LobbyTeam {
  teamId: string;
  players: PlayerInfo[];
}

export interface LobbyState {
  gameId: string;
  status: "lobby" | "running" | "over";
  teams: LobbyTeam[];
}

export interface ToastMsg {
  message: string;
  severity: "info" | "warn" | "alert";
}

/** Client -> server intents. The server validates everything. */
export type Intent =
  | { type: "assign_dock"; truckId: string; dockId: string }
  | { type: "qc_swipe"; palletId: string; accept: boolean; zone?: AbcZone }
  | { type: "putaway"; palletId: string; target: "reserve" | "pick" }
  | { type: "transfer"; skuId: string }
  | { type: "start_route"; orderId: string; path: Cell[] }
  | { type: "flag_ghost"; skuId: string }
  | { type: "load_order"; orderId: string; truckId: string }
  | { type: "unload_order"; orderId: string }
  | { type: "dispatch_truck"; truckId: string }
  | { type: "alert_picker"; orderId: string };

export interface JoinPayload {
  gameId: string;
  teamId: string;
  name: string;
  role: RoleId;
}

export interface GameOverPayload {
  reports: TeamReport[]; // sorted by score desc
}
