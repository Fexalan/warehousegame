/**
 * Picker: order queue + route drawing. The prioritization decision (which
 * order next?) is deliberately the player's — rush orders flash, deadlines
 * tick, and the queue is sorted by urgency only as a hint.
 */
import { useState } from "react";
import { skuById } from "@shared/constants";
import type { Cell, Intent, TeamState } from "@shared/types";
import { RouteMap } from "../components/RouteMap";
import { fmtClock } from "../useTicker";

export function PickerScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState<Cell[]>([]);

  const queue = state.orders
    .filter((o) => o.status === "queued")
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.deadline - b.deadline);

  const selected = queue.find((o) => o.id === selectedId) ?? null;
  const now = gameNow();

  return (
    <main className="screen picker">
      <section className="panel order-queue">
        <h2>📋 Pick Queue ({queue.length})</h2>
        <div className="order-list">
          {queue.map((o) => {
            const left = o.deadline - now;
            return (
              <button
                key={o.id}
                className={`order-card ${o.id === selectedId ? "on" : ""} ${o.priority ? "rush" : ""} ${left < 25_000 ? "late" : ""}`}
                onClick={() => {
                  setSelectedId(o.id);
                  setPath([]);
                }}
              >
                <div className="order-head">
                  <b>
                    {o.priority && "🚨 "}
                    {o.label} · {o.clientName}
                  </b>
                  <span className="deadline">⏱ {fmtClock(left)}</span>
                </div>
                <div className="order-lines">
                  {o.lines.map((l) => {
                    const sku = skuById(l.skuId);
                    const open = l.qty - l.picked;
                    return (
                      <span key={l.skuId} className={`line ${open === 0 ? "done" : ""}`}>
                        {sku.emoji} ×{open > 0 ? open : "✓"}
                      </span>
                    );
                  })}
                  <span className="dest">→ {o.destination}</span>
                </div>
                {o.stockoutFlag && (
                  <div className="stockout">
                    ⚠ Stock-out hit!
                    {o.lines
                      .filter((l) => l.picked < l.qty)
                      .map((l) => (
                        <button
                          key={l.skuId}
                          className="btn btn-flag"
                          onClick={(e) => {
                            e.stopPropagation();
                            send({ type: "flag_ghost", skuId: l.skuId });
                          }}
                        >
                          🚩 Flag {skuById(l.skuId).name}
                        </button>
                      ))}
                  </div>
                )}
              </button>
            );
          })}
          {queue.length === 0 && <p className="muted">Queue empty — breathe while you can.</p>}
        </div>
      </section>

      <section className="panel map-panel">
        <h2>
          🗺 Route {selected ? `for ${selected.label}` : ""}
          {state.blockedCells.length > 0 && <span className="blocked-warn"> · 🚧 AISLE BLOCKED</span>}
        </h2>
        <RouteMap
          state={state}
          order={selected}
          path={path}
          setPath={setPath}
          gameNow={gameNow}
          onGo={() => {
            if (selected) {
              send({ type: "start_route", orderId: selected.id, path });
              setPath([]);
              setSelectedId(null);
            }
          }}
        />
      </section>
    </main>
  );
}
