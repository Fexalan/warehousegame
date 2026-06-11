/**
 * Picking — 3 étapes :
 *   1. Plan de prélèvement : choisir l'ORDRE de passage sur le plan
 *   2. Picking : produits à gauche, commandes à droite — affecter produit +
 *      quantité à la commande
 *   3. Contrôle : demandé vs préparé, ligne par ligne, avant envoi à quai
 */
import { useState } from "react";
import { STEP_LABELS, productById } from "@shared/constants";
import type { Anomaly, Intent, Order, TeamState } from "@shared/types";
import { AnomalyPanel } from "../components/AnomalyPanel";
import { PlanMap } from "../components/PlanMap";
import { StepTabs } from "../components/StepTabs";
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
  const [step, setStep] = useState(0);
  const [sequence, setSequence] = useState<string[]>([]);
  const [planOrderId, setPlanOrderId] = useState<string | null>(null);
  const [pickQty, setPickQty] = useState<Record<string, string>>({});
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, Record<string, boolean>>>({});

  const now = gameNow();
  const globalTimer = state.difficulty !== "easy";
  const queued = state.orders
    .filter((o) => o.status === "queued")
    .sort((a, b) => (a.priority === b.priority ? a.deadline - b.deadline : a.priority === "haute" ? -1 : 1));
  const transit = state.orders.filter((o) => o.status === "transit");
  const picking = state.orders.filter((o) => o.status === "picking");

  const planOrder = queued.find((o) => o.id === planOrderId) ?? null;

  const toggleSeq = (pid: string) =>
    setSequence((s) => (s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid]));

  return (
    <main className="screen column">
      <StepTabs
        labels={STEP_LABELS.picker}
        badges={[queued.length, picking.length, picking.length]}
        active={step}
        onSelect={setStep}
      />

      <AnomalyPanel anomalies={state.anomalies} role="picker" send={send}>
        {(a: Anomaly) =>
          a.kind === "stockout" && a.orderId && a.productId ? (
            <>
              <button className="btn btn-warn" onClick={() => send({ type: "stockout_action", orderId: a.orderId!, productId: a.productId!, action: "emergency" })}>
                Réappro d'urgence
              </button>
              <button className="btn" onClick={() => send({ type: "stockout_action", orderId: a.orderId!, productId: a.productId!, action: "partial" })}>
                Expédier partiel
              </button>
              <button className="btn" onClick={() => send({ type: "stockout_action", orderId: a.orderId!, productId: a.productId!, action: "postpone" })}>
                Reporter la commande
              </button>
            </>
          ) : (
            <span className="tag">En attente du poste Stock…</span>
          )
        }
      </AnomalyPanel>

      {step === 0 && (
        <section className="panel plan-panel">
          <div className="plan-orders">
            <h2>Commandes à planifier</h2>
            {queued.map((o) => (
              <button
                key={o.id}
                className={`order-card ${planOrderId === o.id ? "on" : ""} ${o.priority === "haute" ? "rush" : ""}`}
                onClick={() => {
                  setPlanOrderId(o.id);
                  setSequence([]);
                }}
              >
                <div className="order-head">
                  <b>{o.priority === "haute" && "⚑ "}{o.label} · {o.client}</b>
                  {globalTimer && <span className="deadline">⏱ {fmtClock(o.deadline - now)}</span>}
                </div>
                <div className="order-lines">
                  {o.lines.map((l) => (
                    <span key={l.productId} className="line">{l.productId} ×{l.qty}</span>
                  ))}
                </div>
              </button>
            ))}
            {queued.length === 0 && <p className="muted">Aucune commande à planifier.</p>}
            {transit.map((o) => (
              <p key={o.id} className="hint">
                🚶 {o.label} : déplacement en cours… {Math.max(0, Math.ceil(((o.transitUntil ?? 0) - now) / 1000))} s
              </p>
            ))}
          </div>
          <div>
            <h2>Plan de l'entrepôt {planOrder && `— tournée ${planOrder.label}`}</h2>
            {planOrder ? (
              <>
                <PlanMap productIds={planOrder.lines.map((l) => l.productId)} sequence={sequence} onToggle={toggleSeq} />
                <div className="route-controls">
                  <button className="btn" onClick={() => setSequence([])} disabled={sequence.length === 0}>
                    Réinitialiser
                  </button>
                  <button
                    className="btn btn-go"
                    disabled={sequence.length !== planOrder.lines.length}
                    onClick={() => {
                      send({ type: "plan_route", orderId: planOrder.id, sequence });
                      setPlanOrderId(null);
                      setSequence([]);
                    }}
                  >
                    Valider le plan ▶
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Sélectionnez une commande pour tracer la tournée.</p>
            )}
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="panel pick-panel">
          <div>
            <h2>Produits (zone picking)</h2>
            <table className="pro-table">
              <thead><tr><th>Produit</th><th>Stock picking</th><th>Qté</th><th></th></tr></thead>
              <tbody>
                {state.stock.map((s) => (
                  <tr key={s.productId} className={selectedProduct === s.productId ? "on" : ""}>
                    <td><b>{s.productId}</b><small className="sub">{productById(s.productId).name}</small></td>
                    <td className={s.pickingUnits === 0 ? "cell-bad" : ""}>{s.pickingUnits} u.</td>
                    <td>
                      <input
                        className="qty-input"
                        type="number"
                        min={1}
                        value={pickQty[s.productId] ?? ""}
                        placeholder="0"
                        onChange={(e) => setPickQty({ ...pickQty, [s.productId]: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        className="btn"
                        disabled={!pickQty[s.productId]}
                        onClick={() => setSelectedProduct(s.productId)}
                      >
                        {selectedProduct === s.productId ? "Prêt ✓" : "Prendre"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h2>Commandes en préparation {selectedProduct && <span className="hint">→ affecter {pickQty[selectedProduct]} × {selectedProduct}</span>}</h2>
            {picking.map((o) => (
              <div key={o.id} className={`order-card static ${o.priority === "haute" ? "rush" : ""}`}>
                <div className="order-head">
                  <b>{o.priority === "haute" && "⚑ "}{o.label} · {o.client}</b>
                  {globalTimer && <span className="deadline">⏱ {fmtClock(o.deadline - now)}</span>}
                </div>
                <table className="pro-table compact">
                  <tbody>
                    {o.lines.map((l) => (
                      <tr key={l.productId}>
                        <td>{l.productId}</td>
                        <td>demandé {l.qty}</td>
                        <td className={l.preparedQty === l.qty ? "cell-ok" : l.preparedQty > l.qty ? "cell-bad" : ""}>
                          préparé {l.preparedQty}{l.short && " (partiel)"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="btn-pair">
                  <button
                    className="btn btn-go"
                    disabled={!selectedProduct || !pickQty[selectedProduct ?? ""]}
                    onClick={() => {
                      if (selectedProduct) {
                        send({ type: "pick_assign", orderId: o.id, slotProductId: selectedProduct, qty: Number(pickQty[selectedProduct]) });
                        setSelectedProduct(null);
                      }
                    }}
                  >
                    Affecter à cette commande
                  </button>
                  <button className="btn" onClick={() => setStep(2)}>Aller au contrôle →</button>
                </div>
              </div>
            ))}
            {picking.length === 0 && <p className="muted">Aucune commande en préparation — validez un plan de prélèvement.</p>}
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Contrôle avant envoi à quai</h2>
          {picking.map((o) => (
            <ControlBlock key={o.id} order={o} marks={marks[o.id] ?? {}} setMarks={(m) => setMarks({ ...marks, [o.id]: m })} send={send} />
          ))}
          {picking.length === 0 && <p className="muted">Rien à contrôler.</p>}
        </section>
      )}
    </main>
  );
}

function ControlBlock({
  order,
  marks,
  setMarks,
  send,
}: {
  order: Order;
  marks: Record<string, boolean>;
  setMarks: (m: Record<string, boolean>) => void;
  send: (i: Intent) => void;
}) {
  const allMarked = order.lines.every((l) => marks[l.productId] !== undefined);
  return (
    <div className="control-block">
      <h3>{order.label} · {order.client} → {order.destination}</h3>
      <table className="pro-table">
        <thead>
          <tr><th>Produit demandé</th><th>Qté demandée</th><th>Préparé</th><th>Verdict</th></tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.productId}>
              <td><b>{l.productId}</b><small className="sub">{productById(l.productId).name}</small></td>
              <td>{l.qty}</td>
              <td>
                {l.preparedQty} u.
                {l.preparedProductId && l.preparedProductId !== l.productId && (
                  <small className="sub cell-bad">contenu : {l.preparedProductId}</small>
                )}
                {l.damagedUnits > 0 && <small className="sub cell-bad">{l.damagedUnits} u. endommagées</small>}
                {l.short && <small className="sub">validé partiel</small>}
              </td>
              <td>
                <div className="btn-pair">
                  <button
                    className={`btn ${marks[l.productId] === true ? "btn-go" : ""}`}
                    onClick={() => setMarks({ ...marks, [l.productId]: true })}
                  >
                    Conforme
                  </button>
                  <button
                    className={`btn ${marks[l.productId] === false ? "btn-flag" : ""}`}
                    onClick={() => setMarks({ ...marks, [l.productId]: false })}
                  >
                    Non conforme
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn btn-go"
        disabled={!allMarked}
        onClick={() => send({ type: "pick_control", orderId: order.id, conformMarks: marks })}
      >
        Valider le contrôle → envoi à quai
      </button>
    </div>
  );
}
