/**
 * Stock — 3 étapes :
 *   1. Réapprovisionnement : tableau stocks / seuils min-max, calculer et
 *      commander la quantité pour remonter au max
 *   2. Rempotage : palettes en réserve -> emplacements picking selon les
 *      quantités (choisir la palette PUIS l'emplacement : l'erreur est possible)
 *   3. Approche : palettes complètes demandées à quai, à envoyer directement
 */
import { useState } from "react";
import { PRODUCTS, STEP_LABELS, productById } from "@shared/constants";
import type { Intent, TeamState } from "@shared/types";
import { AnomalyPanel } from "../components/AnomalyPanel";
import { StepTabs } from "../components/StepTabs";

export function ReplenisherScreen({
  state,
  send,
  gameNow,
}: {
  state: TeamState;
  send: (i: Intent) => void;
  gameNow: () => number;
}) {
  const [step, setStep] = useState(0);
  const [orderQty, setOrderQty] = useState<Record<string, string>>({});
  const [selectedPallet, setSelectedPallet] = useState<string | null>(null);

  const reapproNeeded = state.stock.filter((s) => s.reserveUnits + s.onOrderUnits < s.reserveMin).length;
  const rempotageNeeded = state.stock.filter(
    (s) => s.pickingUnits < s.pickMin && s.reserveUnits >= productById(s.productId).unitsPerPallet
  ).length;
  const approchePending = state.approcheTasks.filter((t) => t.status === "pending").length;

  return (
    <main className="screen column">
      <StepTabs
        labels={STEP_LABELS.replenisher}
        badges={[reapproNeeded, rempotageNeeded, approchePending]}
        active={step}
        onSelect={setStep}
      />

      <AnomalyPanel anomalies={state.anomalies} role="replenisher" send={send} />

      {step === 0 && (
        <section className="panel">
          <h2>Réapprovisionnement fournisseur</h2>
          <p className="hint">Si réserve + en commande &lt; seuil min : commander la quantité qui ramène le stock au max.</p>
          <table className="pro-table">
            <thead>
              <tr><th>Produit</th><th>Réserve</th><th>En commande</th><th>Seuil min</th><th>Seuil max</th><th>Quantité à commander</th><th></th></tr>
            </thead>
            <tbody>
              {state.stock.map((s) => {
                const under = s.reserveUnits + s.onOrderUnits < s.reserveMin;
                return (
                  <tr key={s.productId} className={under ? "row-alert" : ""}>
                    <td><b>{s.productId}</b><small className="sub">{productById(s.productId).name}</small></td>
                    <td>{s.reserveUnits} u.</td>
                    <td>{s.onOrderUnits > 0 ? `${s.onOrderUnits} u.` : "—"}</td>
                    <td>{s.reserveMin}</td>
                    <td>{s.reserveMax}</td>
                    <td>
                      <input
                        className="qty-input"
                        type="number"
                        min={0}
                        placeholder="0"
                        value={orderQty[s.productId] ?? ""}
                        onChange={(e) => setOrderQty({ ...orderQty, [s.productId]: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        className={`btn ${under ? "btn-go" : ""}`}
                        disabled={!orderQty[s.productId]}
                        onClick={() => {
                          send({ type: "replenish_order", productId: s.productId, qty: Number(orderQty[s.productId]) });
                          setOrderQty({ ...orderQty, [s.productId]: "" });
                        }}
                      >
                        Commander
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Rempotage réserve → picking</h2>
          <p className="hint">
            1) Sélectionnez une palette en réserve. 2) Cliquez l'emplacement picking de destination. Une palette
            complète = {""}toutes les unités d'un coup : vérifiez le seuil max.
          </p>
          <div className="rempotage-grid">
            <div>
              <h3>Palettes en réserve</h3>
              <table className="pro-table">
                <thead><tr><th>Produit</th><th>Palettes</th><th>Unités / palette</th><th></th></tr></thead>
                <tbody>
                  {state.stock.map((s) => {
                    const p = productById(s.productId);
                    const pallets = Math.floor(s.reserveUnits / p.unitsPerPallet);
                    return (
                      <tr key={s.productId} className={selectedPallet === s.productId ? "on" : ""}>
                        <td><b>{s.productId}</b><small className="sub">{p.name}</small></td>
                        <td>{pallets}</td>
                        <td>{p.unitsPerPallet} u.</td>
                        <td>
                          <button className="btn" disabled={pallets === 0} onClick={() => setSelectedPallet(s.productId)}>
                            {selectedPallet === s.productId ? "Sélectionnée ✓" : "Prendre"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <h3>Emplacements picking {selectedPallet && <span className="hint">→ destination de la palette {selectedPallet}</span>}</h3>
              <table className="pro-table">
                <thead><tr><th>Emplacement</th><th>Stock picking</th><th>Min</th><th>Max</th><th></th></tr></thead>
                <tbody>
                  {state.stock.map((s) => {
                    const job = state.transferJobs.find((j) => j.productId === s.productId);
                    const low = s.pickingUnits < s.pickMin;
                    return (
                      <tr key={s.productId} className={low ? "row-alert" : ""}>
                        <td><b>{s.productId}</b></td>
                        <td className={low ? "cell-bad" : ""}>{s.pickingUnits} u.</td>
                        <td>{s.pickMin}</td>
                        <td>{s.pickMax}</td>
                        <td>
                          {job ? (
                            <span className="tag">⏳ {Math.max(0, Math.ceil((job.finishAt - gameNow()) / 1000))} s</span>
                          ) : (
                            <button
                              className={`btn ${low && selectedPallet === s.productId ? "btn-go" : ""}`}
                              disabled={!selectedPallet}
                              onClick={() => {
                                if (selectedPallet) {
                                  send({ type: "rempotage", palletProductId: selectedPallet, slotProductId: s.productId });
                                  setSelectedPallet(null);
                                }
                              }}
                            >
                              Rempoter ici
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Approche — palettes complètes demandées à quai</h2>
          <table className="pro-table">
            <thead><tr><th>Commande</th><th>Produit</th><th>Palettes</th><th>Réserve dispo</th><th></th></tr></thead>
            <tbody>
              {state.approcheTasks.filter((t) => t.status === "pending").map((t) => {
                const p = productById(t.productId);
                const s = state.stock.find((x) => x.productId === t.productId)!;
                const needed = p.unitsPerPallet * t.pallets;
                const ok = s.reserveUnits >= needed;
                return (
                  <tr key={t.id} className={ok ? "" : "row-alert"}>
                    <td><b>{t.orderLabel}</b></td>
                    <td><b>{t.productId}</b><small className="sub">{p.name}</small></td>
                    <td>{t.pallets} ({needed} u.)</td>
                    <td className={ok ? "" : "cell-bad"}>{s.reserveUnits} u.</td>
                    <td>
                      <button className="btn btn-go" disabled={!ok} onClick={() => send({ type: "approche_send", taskId: t.id })}>
                        Envoyer au quai
                      </button>
                    </td>
                  </tr>
                );
              })}
              {approchePending === 0 && <tr><td colSpan={5} className="muted">Aucune demande d'approche en attente.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
