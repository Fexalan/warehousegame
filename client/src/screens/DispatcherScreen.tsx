/**
 * Expédition — 3 étapes :
 *   1. Planification : affecter les commandes à quai aux camions
 *      (destination, capacité, priorité)
 *   2. Contrôle palettes : état de chaque palette — bon pour chargement ou
 *      refus (retour en re-préparation)
 *   3. Chargement : charger dans le BON ORDRE (le lourd d'abord, le fragile
 *      en dernier — ce qui est chargé après se retrouve dessus)
 */
import { useState } from "react";
import { STEP_LABELS, productById } from "@shared/constants";
import type { Intent, Order, OutboundTruck, TeamState } from "@shared/types";
import { StepTabs } from "../components/StepTabs";
import { fmtClock } from "../useTicker";

function orderFragile(o: Order): boolean {
  return o.lines.some((l) => productById(l.productId).fragile);
}

export function DispatcherScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const [step, setStep] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const now = gameNow();
  const globalTimer = state.difficulty !== "easy";

  const staged = state.orders.filter((o) => o.status === "staged");
  const unassigned = staged.filter((o) => !o.truckId);
  const toCheck = staged.filter((o) => o.truckId && !o.expeditionChecked);
  const trucks = state.outboundTrucks.filter((t) => t.status === "loading");
  const toLoad = staged.filter((o) => o.truckId && o.expeditionChecked).length;

  const selected = unassigned.find((o) => o.id === selectedOrder) ?? null;

  return (
    <main className="screen column">
      <StepTabs
        labels={STEP_LABELS.dispatcher}
        badges={[unassigned.length, toCheck.length, toLoad]}
        active={step}
        onSelect={setStep}
      />

      {step === 0 && (
        <section className="panel">
          <h2>Commandes à quai</h2>
          <table className="pro-table">
            <thead>
              <tr><th>Commande</th><th>Client</th><th>Destination</th><th>Priorité</th><th>Poids</th>{globalTimer && <th>Deadline</th>}<th></th></tr>
            </thead>
            <tbody>
              {unassigned.map((o) => (
                <tr key={o.id} className={selectedOrder === o.id ? "on" : ""}>
                  <td><b>{o.label}</b></td>
                  <td>{o.client}</td>
                  <td><b>{o.destination}</b></td>
                  <td>{o.priority === "haute" ? <span className="tag tag-bad">HAUTE</span> : "normale"}</td>
                  <td>{o.weight} kg{o.fullPallet && <small className="sub">+ palette approche</small>}</td>
                  {globalTimer && <td className={o.deadline - now < 40_000 ? "cell-bad" : ""}>{fmtClock(o.deadline - now)}</td>}
                  <td><button className="btn" onClick={() => setSelectedOrder(o.id)}>Sélectionner</button></td>
                </tr>
              ))}
              {unassigned.length === 0 && <tr><td colSpan={7} className="muted">Rien à planifier — en attente du picking…</td></tr>}
            </tbody>
          </table>

          <h2 style={{ marginTop: 16 }}>Camions au départ {selected && <span className="hint">→ affecter {selected.label} ({selected.destination}, {selected.weight} kg)</span>}</h2>
          <div className="truck-row">
            {trucks.map((t) => {
              const assigned = t.assignedOrderIds.map((id) => state.orders.find((o) => o.id === id)!).filter(Boolean);
              const w = assigned.reduce((a, o) => a + o.weight, 0);
              const mismatch = selected ? selected.destination !== t.destination : false;
              const overflow = selected ? w + selected.weight > t.maxWeight : false;
              return (
                <div key={t.id} className={`truck-card ${t.departsAt !== null && t.departsAt - now < 30_000 ? "leaving" : ""}`}>
                  <div className="truck-head">
                    <b>{t.label} → {t.destination}</b>
                    {t.departsAt !== null && <span className="deadline">départ {fmtClock(t.departsAt - now)}</span>}
                  </div>
                  <div className="cap-bar">
                    <div className={`cap-fill ${w / t.maxWeight > 0.9 ? "full" : ""}`} style={{ width: `${Math.min(100, (w / t.maxWeight) * 100)}%` }} />
                    <span>{w}/{t.maxWeight} kg</span>
                  </div>
                  <div className="truck-load">
                    {assigned.map((o) => (
                      <button key={o.id} className="chip" title="Désaffecter" onClick={() => send({ type: "unassign_truck", orderId: o.id })} disabled={o.status !== "staged"}>
                        {o.label} {o.status === "loaded" ? "📦" : "✕"}
                      </button>
                    ))}
                    {assigned.length === 0 && <span className="muted">vide</span>}
                  </div>
                  {selected && (
                    <button
                      className={`btn ${mismatch || overflow ? "btn-warn" : "btn-go"}`}
                      onClick={() => {
                        send({ type: "assign_truck", orderId: selected.id, truckId: t.id });
                        setSelectedOrder(null);
                      }}
                    >
                      Affecter ici{mismatch && " (⚠ destination)"}{overflow && " (⚠ capacité)"}
                    </button>
                  )}
                  {assigned.length === 0 && (
                    <button className="btn" title="Renvoyer le camion vide pour libérer le quai" onClick={() => send({ type: "dispatch_truck", truckId: t.id })}>
                      Libérer le quai (camion vide)
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Contrôle des palettes avant chargement</h2>
          <table className="pro-table">
            <thead>
              <tr><th>Commande</th><th>Camion</th><th>État constaté</th><th>Décision</th></tr>
            </thead>
            <tbody>
              {toCheck.map((o) => {
                const truck = state.outboundTrucks.find((t) => t.id === o.truckId);
                return (
                  <tr key={o.id} className={o.defects.length > 0 ? "row-alert" : ""}>
                    <td><b>{o.label}</b><small className="sub">{o.client}</small></td>
                    <td>{truck?.label} → {truck?.destination}</td>
                    <td className="note">{o.defects.length > 0 ? o.defects.join(" ; ") : "RAS — palette filmée, stable"}</td>
                    <td>
                      <div className="btn-pair">
                        <button className="btn btn-go" onClick={() => send({ type: "pallet_check", orderId: o.id, approve: true })}>
                          Bon pour chargement
                        </button>
                        <button className="btn btn-flag" onClick={() => send({ type: "pallet_check", orderId: o.id, approve: false })}>
                          Refuser
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {toCheck.length === 0 && <tr><td colSpan={4} className="muted">Aucune palette à contrôler.</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Chargement — l'ordre compte</h2>
          <p className="hint">Ce qui est chargé après se retrouve AU-DESSUS : chargez le lourd d'abord, le fragile en dernier.</p>
          <div className="truck-row">
            {trucks.map((t) => {
              const ready = staged.filter((o) => o.truckId === t.id && o.expeditionChecked);
              const loaded = t.loadedOrderIds.map((id) => state.orders.find((o) => o.id === id)!).filter(Boolean);
              return (
                <div key={t.id} className="truck-card">
                  <div className="truck-head">
                    <b>{t.label} → {t.destination}</b>
                    {t.departsAt !== null && <span className="deadline">départ {fmtClock(t.departsAt - now)}</span>}
                  </div>
                  <h4>À charger</h4>
                  {ready.map((o) => (
                    <div key={o.id} className="load-item">
                      <span>
                        <b>{o.label}</b> · {o.weight} kg
                        {orderFragile(o) && <span className="tag tag-warn">FRAGILE</span>}
                        {o.priority === "haute" && <span className="tag tag-bad">prioritaire</span>}
                      </span>
                      <button className="btn" disabled={t.loadingClosed} onClick={() => send({ type: "load_item", truckId: t.id, orderId: o.id })}>
                        Charger →
                      </button>
                    </div>
                  ))}
                  {ready.length === 0 && <p className="muted">rien en attente</p>}
                  <h4>Chargé (du fond vers la porte)</h4>
                  <ol className="load-sequence">
                    {loaded.map((o) => (
                      <li key={o.id}>
                        {o.label} · {o.weight} kg{orderFragile(o) && " · fragile"}
                      </li>
                    ))}
                  </ol>
                  <div className="btn-pair">
                    {!t.loadingClosed ? (
                      <button className="btn" disabled={loaded.length === 0} onClick={() => send({ type: "close_loading", truckId: t.id })}>
                        Clôturer le chargement
                      </button>
                    ) : (
                      <button className="btn btn-go" onClick={() => send({ type: "dispatch_truck", truckId: t.id })}>
                        🚚 Départ camion
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
