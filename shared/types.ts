/**
 * Shared domain model for the professional, step-based warehouse simulator.
 * Imported by both server (authoritative engine) and client (rendering).
 */

export type RoleId = "receiver" | "replenisher" | "picker" | "dispatcher";
export type Difficulty = "easy" | "normal" | "realistic";
export type AbcZone = "A" | "B" | "C";
export type Stage = "reception" | "stock" | "picking" | "expedition";
export type Rotation = "haute" | "moyenne" | "faible";

export interface Cell {
  x: number;
  y: number;
}

export interface Product {
  id: string; // "PRD-101"
  name: string;
  rotation: Rotation; // haute -> zone A, moyenne -> B, faible -> C
  zone: AbcZone;
  cell: Cell; // picking location on the warehouse plan
  unitsPerPallet: number;
  unitWeight: number; // kg per unit
  fragile: boolean;
}

export interface ModeConfig {
  label: string;
  description: string;
  /** false => per-role timers that only run while that role has a backlog (Easy) */
  globalTimer: boolean;
  /** true => upstream errors are logged but corrected before reaching the next role */
  supervisor: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// RECEPTION
// ---------------------------------------------------------------------------

/** One line of a delivery, shown against the matching purchase-order line. */
export interface DeliveryLine {
  id: string;
  orderedProductId: string; // bon de commande
  orderedQty: number;
  deliveredProductId: string; // what is physically on the truck
  deliveredQty: number;
  conditionNote: string; // inspection observation ("RAS", "Cartons écrasés"...)
  decision: "pending" | "accepted" | "declined";
}

export interface InboundTruck {
  id: string;
  label: string;
  supplier: string;
  arrivedAt: number; // game-relative ms
  dockId: string | null;
  status: "waiting" | "docked" | "departed";
  lines: DeliveryLine[];
}

export interface Dock {
  id: string;
  label: string;
  truckId: string | null;
}

export interface PutawayTask {
  id: string;
  productId: string;
  qty: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// STOCK
// ---------------------------------------------------------------------------

export interface StockItem {
  productId: string;
  reserveUnits: number;
  pickingUnits: number;
  /** réapprovisionnement thresholds (reserve, in units) */
  reserveMin: number;
  reserveMax: number;
  /** rempotage thresholds (picking zone, in units) */
  pickMin: number;
  pickMax: number;
  onOrderUnits: number; // ordered from supplier, not yet delivered
}

export interface TransferJob {
  productId: string; // destination picking slot
  units: number;
  finishAt: number;
}

export interface ApprocheTask {
  id: string;
  orderId: string;
  orderLabel: string;
  productId: string;
  pallets: number;
  status: "pending" | "done";
}

// ---------------------------------------------------------------------------
// PICKING & ORDERS
// ---------------------------------------------------------------------------

export interface OrderLine {
  productId: string;
  qty: number;
  preparedQty: number;
  /** realistic mode: what was physically put in the order (may differ) */
  preparedProductId: string | null;
  damagedUnits: number;
  short: boolean; // picker chose to ship partial
}

export type OrderStatus =
  | "queued" // awaiting plan de prélèvement
  | "transit" // picker travelling (duration = planned route distance)
  | "picking" // assigning products to the order
  | "control" // contrôle before staging
  | "staged" // at expedition, awaiting truck assignment
  | "loaded"
  | "shipped"
  | "missed";

export interface Order {
  id: string;
  label: string;
  client: string;
  destination: string;
  priority: "haute" | "normale";
  createdAt: number;
  deadline: number; // ignored for scoring in Easy mode
  lines: OrderLine[];
  /** full-pallet requirement satisfied by the Replenisher's "approche" step */
  fullPallet: { productId: string; pallets: number; fulfilled: boolean } | null;
  status: OrderStatus;
  planDistance: number | null;
  optimalDistance: number | null;
  transitUntil: number | null;
  truckId: string | null;
  /** expedition pallet check performed and approved */
  expeditionChecked: boolean;
  /** visible condition problems at control steps (realistic cascade + staging incidents) */
  defects: string[];
  weight: number; // total kg
  shippedAt: number | null;
}

// ---------------------------------------------------------------------------
// EXPEDITION
// ---------------------------------------------------------------------------

export interface OutboundTruck {
  id: string;
  label: string;
  destination: string;
  maxWeight: number;
  /** auto-departure (game ms); null in Easy mode (no departure pressure) */
  departsAt: number | null;
  assignedOrderIds: string[];
  /** loading sequence chosen at the chargement step */
  loadedOrderIds: string[];
  loadingClosed: boolean;
  status: "loading" | "departed";
}

// ---------------------------------------------------------------------------
// SUPERVISOR & ANOMALIES
// ---------------------------------------------------------------------------

/** Easy/Normal: an upstream error intercepted before it cascaded. */
export interface SupervisorEvent {
  at: number;
  role: RoleId;
  step: string; // "Contrôle réception", "Rempotage", ...
  error: string;
  original: string; // what the player did
  corrected: string; // what the supervisor passed downstream instead
  penalty: number;
}

/** Realistic: a propagated problem someone downstream must now handle. */
export interface Anomaly {
  id: string;
  kind: "slot_mismatch" | "stockout" | "damaged_flow" | "misplaced_pallet";
  role: RoleId; // who must handle it
  productId: string | null;
  orderId: string | null;
  detail: string;
  status: "visible" | "resolved";
  createdAt: number;
}

// ---------------------------------------------------------------------------
// TEAM STATE (the wire snapshot)
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  name: string;
  role: RoleId;
  connected: boolean;
}

export interface RoleTimer {
  activeMs: number;
  running: boolean;
}

export interface TeamState {
  teamId: string;
  teamName: string;
  difficulty: Difficulty;
  clock: { now: number; durationMs: number };
  roleTimers: Record<RoleId, RoleTimer>;
  cost: number;
  shippedCount: number;
  orderCount: number;
  supervisorCount: number;

  docks: Dock[];
  inboundTrucks: InboundTruck[];
  putawayTasks: PutawayTask[];

  stock: StockItem[];
  transferJobs: TransferJob[];
  approcheTasks: ApprocheTask[];

  orders: Order[];
  outboundTrucks: OutboundTruck[];

  anomalies: Anomaly[]; // visible, unresolved
  players: PlayerInfo[];
}

// ---------------------------------------------------------------------------
// End-of-game report
// ---------------------------------------------------------------------------

export interface CostEvent {
  at: number;
  label: string;
  amount: number;
  role: RoleId;
  supervised: boolean; // intercepted by the supervisor (easy/normal)
}

export interface HeatmapBucket {
  t: number;
  pressures: Record<Stage, number>;
  bottleneck: Stage | null;
}

export interface TeamReport {
  teamId: string;
  teamName: string;
  difficulty: Difficulty;
  score: number;
  otif: { pct: number; onTimeInFull: number; total: number; shipped: number };
  dockUtilization: { busyPct: number; avgWaitSec: number; maxWaitSec: number; trucksServed: number };
  errorCost: {
    total: number;
    breakdown: { label: string; count: number; amount: number }[];
    byRole: Record<RoleId, number>;
    log: CostEvent[];
  };
  supervisor: SupervisorEvent[];
  roleTimers: Record<RoleId, RoleTimer>;
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
  difficulty: Difficulty;
  teams: LobbyTeam[];
}

export interface ToastMsg {
  message: string;
  severity: "info" | "warn" | "alert";
}

/** Client -> server intents. The server validates everything. */
export type Intent =
  // reception
  | { type: "assign_dock"; truckId: string; dockId: string }
  | { type: "control_line"; lineId: string; accept: boolean }
  | { type: "putaway"; taskId: string; zone: AbcZone }
  // stock
  | { type: "replenish_order"; productId: string; qty: number }
  | { type: "rempotage"; palletProductId: string; slotProductId: string }
  | { type: "approche_send"; taskId: string }
  | { type: "resolve_anomaly"; anomalyId: string }
  // picking
  | { type: "plan_route"; orderId: string; sequence: string[] }
  | { type: "pick_assign"; orderId: string; slotProductId: string; qty: number }
  | { type: "stockout_action"; orderId: string; productId: string; action: "emergency" | "partial" | "postpone" }
  | { type: "pick_control"; orderId: string; conformMarks: Record<string, boolean> }
  // expedition
  | { type: "assign_truck"; orderId: string; truckId: string }
  | { type: "unassign_truck"; orderId: string }
  | { type: "pallet_check"; orderId: string; approve: boolean }
  | { type: "load_item"; truckId: string; orderId: string }
  | { type: "close_loading"; truckId: string }
  | { type: "dispatch_truck"; truckId: string };

export interface JoinPayload {
  gameId: string;
  teamId: string;
  name: string;
  role: RoleId;
}

export interface StartPayload {
  difficulty: Difficulty;
}

export interface GameOverPayload {
  reports: TeamReport[];
}
