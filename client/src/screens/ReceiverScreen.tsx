/**
 * Réception — 3 étapes :
 *   1. Planification quai : affecter les camions en attente aux quais libres
 *   2. Contrôle livraison : tableau bon de commande vs bon de livraison,
 *      accepter / refuser chaque ligne (produit, quantité, état)
 *   3. Mise en stock : affecter chaque palette acceptée à une zone A/B/C
 *      selon la rotation du produit
 */
import { useState } from "react";
import { STEP_LABELS, productById } from "@shared/constants";
import type { AbcZone, Intent, TeamState } from "@shared/types";
import { StepTabs } from "../components/StepTabs";
import { fmtClock } from "../useTicker";

export function ReceiverScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const [step, setStep] = useState(0);
  const [selectedTruck, setSelectedTruck] = useState<string | null>(null);

  const waiting = state.inboundTrucks.filter((t) => t.status === "waiting");
  const docked = state.inboundTrucks.filter((t) => t.status === "docked");
  const pendingLines = docked.reduce((a, t) => a + t.lines.filter((l) => l.decision === "pending").length, 0);

  return (
    <main className="screen column">
      <StepTabs
        labels={STEP_LABELS.receiver}
        badges={[waiting.length, pendingLines, state.putawayTasks.length]}
        active={step}
        onSelect={setStep}
      />

      {step === 0 && (
        <section className="panel">
          <h2>Camions sur le parc</h2>
          <table className="pro-table">
            <thead>
              <tr><th>Camion</th><th>Fournisseur</th><th>Lignes</th><th>Attente</th><th></th></tr>
            </thead>
            <tbody>
              {waiting.map((t) => (
                <tr key={t.id} className={selectedTruck === t.id ? "on" : ""}>
                  <td><b>{t.label}</b></td>
                  <td>{t.supplier}</td>
                  <td>{t.lines.length}</td>
                  <td className={gameNow() - t.arrivedAt > 45_000 ? "cell-bad" : ""}>{fmtClock(gameNow() - t.arrivedAt)}</td>
                  <td>
                    <button className="btn" onClick={() => setSelectedTruck(t.id)}>Sélectionner</button>
                  </td>
                </tr>
              ))}
              {waiting.length === 0 && <tr><td colSpan={5} className="muted">Parc vide ✅</td></tr>}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>Quais</h2>
          <div className="dock-row">
            {state.docks.map((d) => {
              const truck = state.inboundTrucks.find((t) => t.id === d.truckId);
              return (
                <button
                  key={d.id}
                  className={`dock ${truck ? "busy" : "free"}`}
                  disabled={!!truck || !selectedTruck}
                  onClick={() => {
                    if (selectedTruck) {
                      send({ type: "assign_dock", truckId: selectedTruck, dockId: d.id });
                      setSelectedTruck(null);
                      setStep(1);
                    }
                  }}
                >
                  <b>{d.label}</b>
                  <span>{truck ? `${truck.label} en cours` : selectedTruck ? "AFFECTER ICI ➜" : "libre"}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          {docked.length === 0 && <p className="muted">Aucun camion à quai — passez par la planification.</p>}
          {docked.map((truck) => (
            <div key={truck.id} className="control-block">
              <h2>
                {truck.label} · {truck.supplier} — contrôle réception
              </h2>
              <table className="pro-table">
                <thead>
                  <tr>
                    <th colSpan={2} className="th-group">Bon de commande</th>
                    <th colSpan={2} className="th-group">Bon de livraison</th>
                    <th>État constaté</th>
                    <th>Décision</th>
                  </tr>
                  <tr>
                    <th>Produit</th><th>Qté cmd.</th><th>Produit livré</th><th>Qté livrée</th><th></th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {truck.lines.map((l) => (
                    <tr key={l.id} className={l.decision !== "pending" ? "row-done" : ""}>
                      <td>
                        <b>{l.orderedProductId}</b>
                        <small className="sub">{productById(l.orderedProductId).name}</small>
                      </td>
                      <td>{l.orderedQty}</td>
                      <td>
                        <b>{l.deliveredProductId}</b>
                        <small className="sub">{productById(l.deliveredProductId).name}</small>
                      </td>
                      <td>{l.deliveredQty}</td>
                      <td className="note">{l.conditionNote}</td>
                      <td>
                        {l.decision === "pending" ? (
                          <div className="btn-pair">
                            <button className="btn btn-go" onClick={() => send({ type: "control_line", lineId: l.id, accept: true })}>
                              Accepter
                            </button>
                            <button className="btn btn-flag" onClick={() => send({ type: "control_line", lineId: l.id, accept: false })}>
                              Refuser
                            </button>
                          </div>
                        ) : l.decision === "accepted" ? (
                          <span className="tag tag-ok">Acceptée</span>
                        ) : (
                          <span className="tag tag-bad">Refusée</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Mise en stock — choisir la zone selon la rotation</h2>
          <p className="hint">Zone A = rotation haute (proche expédition) · B = moyenne · C = faible</p>
          <table className="pro-table">
            <thead>
              <tr><th>Produit</th><th>Quantité</th><th>Rotation</th><th>Zone de rangement</th></tr>
            </thead>
            <tbody>
              {state.putawayTasks.map((t) => {
                const p = productById(t.productId);
                return (
                  <tr key={t.id}>
                    <td><b>{t.productId}</b><small className="sub">{p.name}</small></td>
                    <td>{t.qty} u.</td>
                    <td><span className={`tag rot-${p.rotation}`}>{p.rotation}</span></td>
                    <td>
                      <div className="btn-pair">
                        {(["A", "B", "C"] as AbcZone[]).map((z) => (
                          <button key={z} className={`btn zone-btn zone-${z}`} onClick={() => send({ type: "putaway", taskId: t.id, zone: z })}>
                            {z}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {state.putawayTasks.length === 0 && <tr><td colSpan={4} className="muted">Aucune palette en attente de rangement.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
