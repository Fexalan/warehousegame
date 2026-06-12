/**
 * Solo — Réception. Three steps:
 *   1. Planification : affecter les camions aux quais (urgents d'abord, équilibré)
 *   2. Déchargement & Contrôle : commandé vs reçu, identifier l'écart
 *   3. Mise en Stock : ranger selon la rotation (Forte→A, Moyenne→B, Faible→C)
 */
import { useMemo, useState } from "react";
import { InfoTab } from "../InfoTab";
import {
  type Discrepancy,
  type ReceptionData,
  ROTATION_LABEL,
  ROTATION_TO_ZONE,
  SOLO_STEP_INFO,
  SOLO_STEP_LABELS,
  type SoloZone,
  genReception,
  productByRef,
} from "../data";
import { mulberry32 } from "../rng";
import type { SoloApi } from "../SoloApp";

const STEPS = SOLO_STEP_LABELS.reception;
const INFO = SOLO_STEP_INFO.reception;
const DISCREPANCIES: Discrepancy[] = ["OK", "Manque", "Surplus", "Erreur de REF"];
const ZONES: SoloZone[] = ["A", "B", "C"];

export function ReceptionRole({ api, seed }: { api: SoloApi; seed: number }) {
  const data: ReceptionData = useMemo(() => genReception(mulberry32(seed), api.tuning), [seed, api.tuning]);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false]);

  // step 1: dock assignment { truckId: 1|2 }
  const [docks, setDocks] = useState<Record<string, 1 | 2>>({});
  // step 2: observation per line
  const [obs, setObs] = useState<Record<string, Discrepancy>>({});
  // step 3: zone per putaway
  const [zones, setZones] = useState<Record<string, SoloZone>>({});

  function finishMaybe(next: [boolean, boolean, boolean]) {
    if (next.every(Boolean)) api.finish();
  }

  // ---- step 1 ----
  function validatePlanning() {
    const trucks = data.trucks;
    if (Object.keys(docks).length < trucks.length) return;
    // score on how balanced the two docks' total durations are
    let q1 = 0, q2 = 0;
    for (const t of trucks) {
      const d = docks[t.id];
      if (d === 1) q1 += t.duration; else q2 += t.duration;
    }
    const balance = 1 - Math.min(1, Math.abs(q1 - q2) / Math.max(q1 + q2, 1));
    const score = Math.round(balance * 100);
    if (balance < 0.7) api.penalize("Quais déséquilibrés", 20);
    api.completeTask(0, score, STEPS[0]);
    const next: [boolean, boolean, boolean] = [true, done[1], done[2]];
    setDone(next);
    setStep(1);
    finishMaybe(next);
  }

  // ---- step 2 ----
  function validateControl() {
    const lines = data.trucks.flatMap((t) => t.lines);
    let correct = 0;
    for (const l of lines) {
      const choice = obs[l.id];
      if (!choice) continue;
      if (choice === l.truth) correct++;
      else api.penalize(`Écart mal qualifié (${l.orderedRef})`, 15);
    }
    const answered = Object.keys(obs).length;
    if (answered < lines.length) return;
    const score = Math.round((correct / lines.length) * 100);
    api.completeTask(1, score, STEPS[1]);
    const next: [boolean, boolean, boolean] = [done[0], true, done[2]];
    setDone(next);
    setStep(2);
    finishMaybe(next);
  }

  // ---- step 3 ----
  function validatePutaway() {
    const tasks = data.putaways;
    if (Object.keys(zones).length < tasks.length) return;
    let correct = 0;
    for (const t of tasks) {
      const z = zones[t.id];
      if (z === ROTATION_TO_ZONE[t.rotation]) correct++;
      else api.penalize(`Mauvaise zone ABC (${t.ref})`, 15);
    }
    const score = Math.round((correct / tasks.length) * 100);
    api.completeTask(2, score, STEPS[2]);
    const next: [boolean, boolean, boolean] = [done[0], done[1], true];
    setDone(next);
    finishMaybe(next);
  }

  const lines = data.trucks.flatMap((t) => t.lines);

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
          <h2>Planification des arrivées</h2>
          <p className="hint">Affectez chaque camion à un quai. Placez les urgents en premier et équilibrez la charge.</p>
          <table className="pro-table">
            <thead>
              <tr><th>Fournisseur</th><th>Type</th><th>Taille</th><th>Durée</th><th>Priorité</th><th>Quai</th></tr>
            </thead>
            <tbody>
              {data.trucks.map((t) => (
                <tr key={t.id} className={docks[t.id] ? "row-done" : ""}>
                  <td><b>{t.supplier}</b></td>
                  <td>{t.type}</td>
                  <td>{t.size}</td>
                  <td>{t.duration} min</td>
                  <td><span className={`tag prio-${t.priority.toLowerCase()}`}>{t.priority}</span></td>
                  <td>
                    <div className="btn-pair">
                      {[1, 2].map((q) => (
                        <button key={q} className={`btn ${docks[t.id] === q ? "btn-go" : ""}`} onClick={() => setDocks((d) => ({ ...d, [t.id]: q as 1 | 2 }))}>
                          Quai {q}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="solo-dock-load">
            {[1, 2].map((q) => {
              const load = data.trucks.filter((t) => docks[t.id] === q).reduce((a, t) => a + t.duration, 0);
              return <span key={q} className="tag">Quai {q} : {load} min</span>;
            })}
          </div>
          <button className="btn btn-big" disabled={Object.keys(docks).length < data.trucks.length} onClick={validatePlanning}>
            Valider le planning
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Déchargement & contrôle</h2>
          <p className="hint">Comparez référence et quantité commandées vs reçues, puis qualifiez chaque ligne.</p>
          <table className="pro-table">
            <thead>
              <tr><th>Réf. commandée</th><th>Qté cmd</th><th>Réf. reçue</th><th>Qté reçue</th><th>Observation</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const wrongRef = l.receivedRef !== l.orderedRef;
                return (
                  <tr key={l.id} className={obs[l.id] ? "row-done" : ""}>
                    <td><b>{l.orderedRef}</b></td>
                    <td>{l.orderedQty}</td>
                    <td className={wrongRef ? "cell-bad" : ""}><b>{l.receivedRef}</b></td>
                    <td className={l.receivedQty !== l.orderedQty ? "cell-bad" : ""}>{l.receivedQty}</td>
                    <td>
                      <select className="solo-select" value={obs[l.id] ?? ""} onChange={(e) => setObs((o) => ({ ...o, [l.id]: e.target.value as Discrepancy }))}>
                        <option value="" disabled>Choisir…</option>
                        {DISCREPANCIES.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                      {api.hints && obs[l.id] && obs[l.id] === l.truth && <span className="tag tag-ok"> ✓</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={Object.keys(obs).length < lines.length} onClick={validateControl}>
            Valider le contrôle
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Mise en stock</h2>
          <p className="hint">Forte → Zone A · Moyenne → Zone B · Faible → Zone C</p>
          <table className="pro-table">
            <thead>
              <tr><th>Référence</th><th>Quantité</th><th>Rotation</th><th>Zone</th></tr>
            </thead>
            <tbody>
              {data.putaways.map((t) => (
                <tr key={t.id} className={zones[t.id] ? "row-done" : ""}>
                  <td><b>{t.ref}</b><small className="sub">{productByRef(t.ref).name}</small></td>
                  <td>{t.qty} u.</td>
                  <td><span className={`tag rot-${t.rotation}`}>{ROTATION_LABEL[t.rotation]}</span></td>
                  <td>
                    <div className="btn-pair">
                      {ZONES.map((z) => (
                        <button key={z} className={`btn zone-btn zone-${z} ${zones[t.id] === z ? "btn-go" : ""}`} onClick={() => setZones((s) => ({ ...s, [t.id]: z }))}>
                          {z}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={Object.keys(zones).length < data.putaways.length} onClick={validatePutaway}>
            Valider la mise en stock
          </button>
        </section>
      )}
    </main>
  );
}
