/**
 * Dispatcher: load planning under deadlines. Tap a staged order, tap a
 * truck — capacity, destination match and departure clocks do the teaching.
 */
import { useState } from "react";
import { skuById } from "@shared/constants";
import type { Intent, Order, OutboundTruck, TeamState } from "@shared/types";
import { fmtClock } from "../useTicker";

export function DispatcherScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = gameNow();

  const staged = state.orders
    .filter((o) => o.status === "staged")
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.deadline - b.deadline);
  const selected = staged.find((o) => o.id === selectedId) ?? null;
  const rush = state.orders.find((o) => o.priority && !["shipped", "missed"].includes(o.status));

  return (
    <main className="screen dispatcher">
      {rush && (
        <div className="rush-bar">
          🚨 VIP {rush.label} → {rush.destination} · ⏱ {fmtClock(rush.deadline - now)} · status: {rush.status}
          {["queued", "picking"].includes(rush.status) && (
            <button className="btn btn-flag" onClick={() => send({ type: "alert_picker", orderId: rush.id })}>
              📣 ALERT PICKER
            </button>
          )}
        </div>
      )}

      <section className="panel">
        <h2>📦 Staging ({staged.length})</h2>
        <div className="order-list horizontal">
          {staged.map((o) => (
            <button
              key={o.id}
              className={`order-card ${o.id === selectedId ? "on" : ""} ${o.priority ? "rush" : ""} ${o.deadline - now < 25_000 ? "late" : ""}`}
              onClick={() => setSelectedId(o.id === selectedId ? null : o.id)}
            >
              <div className="order-head">
                <b>
                  {o.priority && "🚨 "}
                  {o.label} · {o.clientName}
                </b>
                <span className="deadline">⏱ {fmtClock(o.deadline - now)}</span>
              </div>
              <div className="order-lines">
                {o.lines.map((l) => (
                  <span key={l.skuId} className="line">
                    {skuById(l.skuId).emoji}×{l.qty}
                  </span>
                ))}
              </div>
              <div className="order-meta">
                → <b>{o.destination}</b> · {o.weight}kg · {o.volume}m³
              </div>
            </button>
          ))}
          {staged.length === 0 && <p className="muted">Nothing staged — waiting on picking…</p>}
        </div>
        {selected && <p className="hint">Now tap a truck to load {selected.label} ⤵</p>}
      </section>

      <section className="panel">
        <h2>🚚 Outbound Bays</h2>
        <div className="truck-row">
          {state.outboundTrucks
            .filter((t) => t.status === "loading")
            .map((t) => (
              <TruckCard
                key={t.id}
                truck={t}
                orders={state.orders}
                now={now}
                selected={selected}
                onLoad={() => selected && send({ type: "load_order", orderId: selected.id, truckId: t.id })}
                onUnload={(orderId) => send({ type: "unload_order", orderId })}
                onDispatch={() => send({ type: "dispatch_truck", truckId: t.id })}
              />
            ))}
        </div>
      </section>
    </main>
  );
}

function TruckCard({
  truck,
  orders,
  now,
  selected,
  onLoad,
  onUnload,
  onDispatch,
}: {
  truck: OutboundTruck;
  orders: Order[];
  now: number;
  selected: Order | null;
  onLoad: () => void;
  onUnload: (orderId: string) => void;
  onDispatch: () => void;
}) {
  const loaded = truck.loadedOrderIds
    .map((id) => orders.find((o) => o.id === id))
    .filter((o): o is Order => !!o);
  const w = loaded.reduce((a, o) => a + o.weight, 0);
  const v = loaded.reduce((a, o) => a + o.volume, 0);
  const left = truck.departsAt - now;
  const destMismatch = selected ? selected.destination !== truck.destination : false;
  const wouldOverflow = selected ? w + selected.weight > truck.maxWeight || v + selected.volume > truck.maxVolume : false;

  return (
    <div className={`truck-card ${left < 20_000 ? "leaving" : ""}`}>
      <div className="truck-head">
        <b>
          {truck.label} → {truck.destination}
        </b>
        <span className="deadline">departs {fmtClock(left)}</span>
      </div>
      <CapBar label="kg" value={w} max={truck.maxWeight} />
      <CapBar label="m³" value={v} max={truck.maxVolume} />
      <div className="truck-load">
        {loaded.map((o) => (
          <button key={o.id} className="chip" onClick={() => onUnload(o.id)} title="Tap to unload">
            {o.label} ✕
          </button>
        ))}
        {loaded.length === 0 && <span className="muted">empty</span>}
      </div>
      <div className="truck-actions">
        {selected && (
          <button className={`btn ${destMismatch || wouldOverflow ? "btn-warn" : "btn-go"}`} onClick={onLoad}>
            ⬅ Load {selected.label}
            {destMismatch && " (⚠ wrong dest!)"}
            {wouldOverflow && " (⚠ over capacity)"}
          </button>
        )}
        <button className="btn" disabled={loaded.length === 0} onClick={onDispatch}>
          🚀 Dispatch now
        </button>
      </div>
    </div>
  );
}

function CapBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="cap-bar">
      <div className={`cap-fill ${pct > 90 ? "full" : ""}`} style={{ width: `${pct}%` }} />
      <span>
        {Math.round(value * 10) / 10}/{max} {label}
      </span>
    </div>
  );
}
