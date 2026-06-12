/**
 * Solo — Stockage. Three steps:
 *   1. Réapprovisionnement : commander si stock < min (jusqu'au max), sinon non
 *   2. Rempotage : transférer des palettes réserve → picking quand sous le min
 *   3. Approche : amener les palettes aux quais selon le plan du jour
 */
import { useMemo, useState } from "react";
import { InfoTab } from "../InfoTab";
import { type StockageData, SOLO_STEP_INFO, SOLO_STEP_LABELS, genStockage } from "../data";
import { mulberry32 } from "../rng";
import type { SoloApi } from "../SoloApp";

const STEPS = SOLO_STEP_LABELS.stockage;
const INFO = SOLO_STEP_INFO.stockage;

export function StockageRole({ api, seed }: { api: SoloApi; seed: number }) {
  const data: StockageData = useMemo(() => genStockage(mulberry32(seed), api.tuning), [seed, api.tuning]);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false]);

  // step 1: decision per ref: { ref: { order: boolean, qty: number } }
  const [decisions, setDecisions] = useState<Record<string, { order: boolean; qty: number }>>({});
  // step 2: transferred units per ref
  const [transfers, setTransfers] = useState<Record<string, number>>({});
  // step 3: approche { ref: { quai, pallets } }
  const [approche, setApproche] = useState<Record<string, { quai: 1 | 2; pallets: number }>>({});

  function finishMaybe(next: [boolean, boolean, boolean]) {
    if (next.every(Boolean)) api.finish();
  }

  function validateReappro() {
    const rows = data.reappro;
    if (Object.keys(decisions).length < rows.length) return;
    let correct = 0;
    for (const r of rows) {
      const dec = decisions[r.ref];
      if (!dec) continue;
      if (dec.order === r.shouldOrder) {
        if (!dec.order) correct++;
        else {
          // ordering: reward when quantity reaches max (±10%)
          const target = r.suggestedQty;
          const ok = Math.abs(dec.qty - target) <= Math.max(2, target * 0.1);
          if (ok) correct++; else api.penalize(`Quantité commandée incorrecte (${r.ref})`, 12);
        }
      } else {
        api.penalize(r.shouldOrder ? `Réappro manquant (${r.ref})` : `Commande inutile (${r.ref})`, 15);
      }
    }
    const score = Math.round((correct / rows.length) * 100);
    api.completeTask(0, score, STEPS[0]);
    const next: [boolean, boolean, boolean] = [true, done[1], done[2]];
    setDone(next); setStep(1); finishMaybe(next);
  }

  function validateRempotage() {
    // Correct = transfer something for slots below min, and nothing for slots OK.
    const needing = data.reserve.filter((p) => p.pickBelowMin);
    const okSlots = data.reserve.filter((p) => !p.pickBelowMin);
    let correct = 0;
    for (const p of needing) {
      const t = transfers[p.ref] ?? 0;
      if (t > 0 && t % p.unitsPerPallet === 0) correct++;
      else api.penalize(`Rempotage manquant/incorrect (${p.ref})`, 12);
    }
    for (const p of okSlots) {
      const t = transfers[p.ref] ?? 0;
      if (t === 0) correct++;
      else api.penalize(`Rempotage inutile (${p.ref})`, 8);
    }
    const total = needing.length + okSlots.length;
    const score = total ? Math.round((correct / total) * 100) : 100;
    api.completeTask(1, score, STEPS[1]);
    const next: [boolean, boolean, boolean] = [done[0], true, done[2]];
    setDone(next); setStep(2); finishMaybe(next);
  }

  function validateApproche() {
    const plan = data.approchePlan;
    if (Object.keys(approche).length < plan.length) return;
    let correct = 0;
    for (const line of plan) {
      const a = approche[line.ref];
      if (a && a.quai === line.quai && a.pallets === line.pallets) correct++;
      else api.penalize(`Approche non conforme au plan (${line.ref})`, 12);
    }
    const score = Math.round((correct / plan.length) * 100);
    api.completeTask(2, score, STEPS[2]);
    const next: [boolean, boolean, boolean] = [done[0], done[1], true];
    setDone(next); finishMaybe(next);
  }

  return (
    <main className="screen column solo-screen">
      <nav className="step-tabs">
        {STEPS.map((label, i) => (
          <button key={i} className={`step-tab ${step === i ? "on" : ""} ${done[i] ? "step-done" : ""}`} onClick={() => setStep(i)}>
            {i + 1}. {label} {done[i] && "✓"}
          </button>
        ))}
      </nav>
      <InfoTab title={STEPS[step]} text={INFO[step]} />

      {step === 0 && (
        <section className="panel">
          <h2>Réapprovisionnement</h2>
          <p className="hint">Si le stock passe sous le seuil min, commandez jusqu'au seuil max. Sinon, ne commandez pas.</p>
          <table className="pro-table">
            <thead>
              <tr><th>Article</th><th>Stock actuel</th><th>Seuil min</th><th>Seuil max</th><th>Décision</th></tr>
            </thead>
            <tbody>
              {data.reappro.map((r) => {
                const dec = decisions[r.ref];
                const below = r.stock < r.min;
                return (
                  <tr key={r.ref} className={dec ? "row-done" : ""}>
                    <td><b>{r.ref}</b><small className="sub">{r.name}</small></td>
                    <td className={below ? "cell-bad" : ""}><b>{r.stock}</b></td>
                    <td>{r.min}</td>
                    <td>{r.max}</td>
                    <td>
                      {!dec || dec.order ? (
                        <div className="solo-order-row">
                          <input
                            className="qty-input"
                            type="number"
                            placeholder={String(r.suggestedQty)}
                            value={dec?.qty ?? ""}
                            onChange={(e) => setDecisions((d) => ({ ...d, [r.ref]: { order: true, qty: Number(e.target.value) } }))}
                          />
                          <button className="btn btn-go" onClick={() => setDecisions((d) => ({ ...d, [r.ref]: { order: true, qty: d[r.ref]?.qty || r.suggestedQty } }))}>Commander</button>
                          <button className="btn-link" onClick={() => setDecisions((d) => ({ ...d, [r.ref]: { order: false, qty: 0 } }))}>Ne pas commander</button>
                        </div>
                      ) : (
                        <span className="tag">Ne pas commander <button className="btn-link" onClick={() => setDecisions((d) => { const n = { ...d }; delete n[r.ref]; return n; })}>↺</button></span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={Object.keys(decisions).length < data.reappro.length} onClick={validateReappro}>
            Valider ({Object.keys(decisions).length}/{data.reappro.length} décisions)
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="rempotage-grid">
          <div className="panel">
            <h2>Zone stock (palettes)</h2>
            {data.reserve.map((p) => (
              <div key={p.ref} className={`order-card static ${p.pickBelowMin ? "rush" : ""}`}>
                <div className="order-head">
                  <b>{p.ref}</b>
                  <span className="tag">{p.pallets} palette(s)</span>
                </div>
                <small className="sub">{p.name} — {p.unitsPerPallet} u./palette {p.pickBelowMin && "· picking sous le min ⚠️"}</small>
                <div className="solo-order-row">
                  <input
                    className="qty-input"
                    type="number"
                    placeholder={`Multiple de ${p.unitsPerPallet}`}
                    value={transfers[p.ref] ?? ""}
                    onChange={(e) => setTransfers((t) => ({ ...t, [p.ref]: Number(e.target.value) }))}
                  />
                  <button className="btn btn-go" onClick={() => setTransfers((t) => ({ ...t, [p.ref]: (t[p.ref] || 0) + p.unitsPerPallet }))}>+1 palette</button>
                </div>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Zone picking (unités)</h2>
            <table className="pro-table">
              <thead><tr><th>Article</th><th>Stock</th><th>Min</th><th>Max</th></tr></thead>
              <tbody>
                {data.pickingSlots.map((s) => (
                  <tr key={s.ref}>
                    <td><b>{s.ref}</b></td>
                    <td className={s.stock < s.min ? "cell-bad" : ""}><b>{s.stock}</b></td>
                    <td>{s.min}</td>
                    <td>{s.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-big" onClick={validateRempotage}>Valider le rempotage</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Approche</h2>
          <div className="solo-plan-banner">
            <b>Plan d'approche du jour :</b>
            {data.approchePlan.map((l) => (
              <span key={l.ref} className="tag">{l.pallets} pal. {l.ref} → Quai {l.quai}</span>
            ))}
          </div>
          <table className="pro-table">
            <thead><tr><th>Réf</th><th>Disponible</th><th>Nb palettes</th><th>Quai</th></tr></thead>
            <tbody>
              {data.approcheStock.map((p) => {
                const a = approche[p.ref];
                return (
                  <tr key={p.ref} className={a ? "row-done" : ""}>
                    <td><b>{p.ref}</b><small className="sub">{p.name}</small></td>
                    <td>{p.available} pal.</td>
                    <td>
                      <input className="qty-input" type="number" min={0} max={p.available} value={a?.pallets ?? ""} onChange={(e) => setApproche((s) => ({ ...s, [p.ref]: { quai: s[p.ref]?.quai ?? 1, pallets: Number(e.target.value) } }))} />
                    </td>
                    <td>
                      <div className="btn-pair">
                        {[1, 2].map((q) => (
                          <button key={q} className={`btn ${a?.quai === q ? "btn-go" : ""}`} onClick={() => setApproche((s) => ({ ...s, [p.ref]: { pallets: s[p.ref]?.pallets ?? 0, quai: q as 1 | 2 } }))}>Quai {q}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={Object.keys(approche).length < data.approchePlan.length} onClick={validateApproche}>Valider l'approche</button>
        </section>
      )}
    </main>
  );
}
