/**
 * Replenisher: min/max watchkeeping. Two loops —
 *   1) inbound buffer: store to reserve OR cross-dock straight to pick face
 *   2) pick-face levels: one-tap transfers before the Picker starves
 */
import { SKUS, TRANSFER_MS, skuById } from "@shared/constants";
import type { Intent, TeamState } from "@shared/types";

export function ReplenisherScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const now = gameNow();

  return (
    <main className="screen replenisher">
      <section className="panel">
        <h2>📥 Inbound Buffer ({state.inboundBuffer.length})</h2>
        <div className="buffer-row">
          {state.inboundBuffer.map((p) => {
            const sku = skuById(p.skuId);
            const stock = state.stock.find((s) => s.skuId === p.skuId);
            const lowPick = stock ? stock.pick < stock.min : false;
            return (
              <div key={p.id} className="buffer-card">
                <b>
                  {sku.emoji} {sku.name}
                </b>
                <span>{p.qty} units · Zone {sku.zone}</span>
                <div className="buffer-actions">
                  <button className="btn" onClick={() => send({ type: "putaway", palletId: p.id, target: "reserve" })}>
                    🏬 Reserve
                  </button>
                  <button
                    className={`btn ${lowPick ? "btn-go" : ""}`}
                    onClick={() => send({ type: "putaway", palletId: p.id, target: "pick" })}
                    title="Skip storage, straight to the pick face"
                  >
                    ⚡ Cross-dock
                  </button>
                </div>
              </div>
            );
          })}
          {state.inboundBuffer.length === 0 && <p className="muted">Buffer empty — watch the levels below.</p>}
        </div>
      </section>

      <section className="panel">
        <h2>📊 Pick Face Levels (min/max)</h2>
        <div className="stock-table">
          {SKUS.map((sku) => {
            const s = state.stock.find((x) => x.skuId === sku.id)!;
            const job = state.transferJobs.find((j) => j.skuId === sku.id);
            const pct = Math.min(100, (s.pick / s.max) * 100);
            const level = s.pick <= 0 ? "empty" : s.pick < s.min ? "low" : "ok";
            return (
              <div key={sku.id} className={`stock-row level-${level}`}>
                <span className="stock-name">
                  {sku.emoji} {sku.name}
                </span>
                <div className="stock-bar">
                  <div className={`stock-fill level-${level}`} style={{ width: `${pct}%` }} />
                  <div className="stock-min" style={{ left: `${(s.min / s.max) * 100}%` }} />
                  <span className="stock-num">
                    {s.pick}/{s.max}
                  </span>
                </div>
                <span className="stock-reserve">res {s.reserve}</span>
                {job ? (
                  <span className="transfer-progress">
                    ⏳ {Math.max(0, Math.ceil((job.finishAt - now) / 1000))}s
                  </span>
                ) : (
                  <button
                    className={`btn ${level !== "ok" ? "btn-go" : ""}`}
                    disabled={s.reserve <= 0 || s.pick >= s.max}
                    onClick={() => send({ type: "transfer", skuId: sku.id })}
                    title={`Move reserve stock to the pick face (${TRANSFER_MS / 1000}s)`}
                  >
                    ➜ Transfer
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
