/**
 * Solo — Préparation. Three steps:
 *   1. Plan de Prélèvement : ordonner les emplacements (chemin le plus court)
 *   2. Picking : prélever la quantité, gérer les manques (reporter/substituer)
 *   3. Contrôle & Emballage : décision selon défaut + affectation au bon quai
 */
import { useMemo, useState } from "react";
import { InfoTab } from "../InfoTab";
import {
  type ControlOrder,
  type PickTarget,
  type PreparationData,
  SOLO_STEP_INFO,
  SOLO_STEP_LABELS,
  genPreparation,
} from "../data";
import { mulberry32 } from "../rng";
import type { SoloApi } from "../SoloApp";

const STEPS = SOLO_STEP_LABELS.preparation;
const INFO = SOLO_STEP_INFO.preparation;
const DECISIONS = ["Valider", "Reconditionner", "Bloquer"];

/** Parse "B3-01" → coordinate on a coarse grid for path-length scoring. */
function coord(slot: string): { x: number; y: number } {
  const col = slot.charCodeAt(0) - 65; // A=0..D=3
  const x = Number(slot[1]) || 1; // 1..5
  const suffix = slot.endsWith("02") ? 1 : 0;
  return { x, y: col * 2 + suffix };
}
const ENTRY = { x: 0, y: 0 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function tourLength(order: PickTarget[]): number {
  let total = 0;
  let cur = ENTRY;
  for (const t of order) { total += dist(cur, coord(t.slot)); cur = coord(t.slot); }
  return total;
}
/** brute-force optimal for the small target set (≤7). */
function optimalLength(targets: PickTarget[]): number {
  if (targets.length <= 1) return tourLength(targets);
  let best = Infinity;
  const perm = (arr: PickTarget[], k: number) => {
    if (k === arr.length) { best = Math.min(best, tourLength(arr)); return; }
    for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
  };
  perm(targets.slice(), 0);
  return best;
}

export function PreparationRole({ api, seed }: { api: SoloApi; seed: number }) {
  const data: PreparationData = useMemo(() => genPreparation(mulberry32(seed), api.tuning), [seed, api.tuning]);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false]);

  // step 1: ordered sequence of target ids
  const [seq, setSeq] = useState<string[]>([]);
  // step 2: picking { id: { qty, handling } }
  const [picks, setPicks] = useState<Record<string, { qty: number; handling?: "report" | "substitute" }>>({});
  // step 3: { cmd: { decision, quai } }
  const [ctrl, setCtrl] = useState<Record<string, { decision?: string; quai?: 1 | 2 }>>({});

  const optimal = useMemo(() => optimalLength(data.targets), [data.targets]);

  function finishMaybe(next: [boolean, boolean, boolean]) { if (next.every(Boolean)) api.finish(); }

  function toggleSeq(id: string) {
    setSeq((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function validatePlan() {
    if (seq.length < data.targets.length) return;
    const ordered = seq.map((id) => data.targets.find((t) => t.id === id)!);
    const len = tourLength(ordered);
    const ratio = len > 0 ? optimal / len : 1;
    const score = Math.round(Math.max(0.3, ratio) * 100);
    if (ratio < 0.85) api.penalize("Chemin de prélèvement non optimal", 15);
    api.completeTask(0, score, STEPS[0]);
    const next: [boolean, boolean, boolean] = [true, done[1], done[2]];
    setDone(next); setStep(1); finishMaybe(next);
  }

  function validatePicking() {
    let correct = 0;
    for (const t of data.targets) {
      const p = picks[t.id];
      const short = t.available < t.required;
      if (!p) continue;
      if (short) {
        if (p.handling === "report" || p.handling === "substitute") correct++;
        else api.penalize(`Manque non géré (${t.ref})`, 12);
      } else {
        if (p.qty === t.required) correct++;
        else api.penalize(`Quantité prélevée incorrecte (${t.ref})`, 10);
      }
    }
    const answered = data.targets.every((t) => {
      const p = picks[t.id];
      const short = t.available < t.required;
      return p && (short ? !!p.handling : p.qty > 0);
    });
    if (!answered) return;
    const score = Math.round((correct / data.targets.length) * 100);
    api.completeTask(1, score, STEPS[1]);
    const next: [boolean, boolean, boolean] = [done[0], true, done[2]];
    setDone(next); setStep(2); finishMaybe(next);
  }

  function validateControl() {
    const orders = data.control;
    const allAnswered = orders.every((o) => ctrl[o.cmd]?.decision && ctrl[o.cmd]?.quai);
    if (!allAnswered) return;
    let correct = 0;
    for (const o of orders) {
      const c = ctrl[o.cmd];
      const decOk = o.defect === "Aucun" ? c.decision === "Valider" : c.decision !== "Valider";
      const quaiOk = c.quai === o.expectedQuai;
      if (decOk) correct += 0.5; else api.penalize(`Décision contrôle erronée (${o.cmd})`, 12);
      if (quaiOk) correct += 0.5; else api.penalize(`Mauvais quai (${o.cmd})`, 8);
    }
    const score = Math.round((correct / orders.length) * 100);
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
          <h2>Plan de prélèvement</h2>
          <p className="hint">Cliquez les emplacements dans l'ordre de passage pour tracer le chemin le plus court.</p>
          <div className="solo-pathgrid">
            {data.targets.map((t) => {
              const order = seq.indexOf(t.id);
              return (
                <button key={t.id} className={`path-cell ${order >= 0 ? "picked" : ""}`} onClick={() => toggleSeq(t.id)}>
                  {order >= 0 && <span className="path-seq">{order + 1}</span>}
                  <b>{t.slot}</b>
                  <small>{t.ref}</small>
                </button>
              );
            })}
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            {seq.length}/{data.targets.length} emplacements ordonnés
            {seq.length === data.targets.length && (
              <> · distance choisie {tourLength(seq.map((id) => data.targets.find((t) => t.id === id)!))} (optimale {optimal})</>
            )}
          </p>
          <button className="btn btn-big" disabled={seq.length < data.targets.length} onClick={validatePlan}>Valider le plan</button>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Picking</h2>
          <p className="hint">Prélevez la quantité requise. En cas de manque (disponible &lt; requis), reportez ou substituez.</p>
          <table className="pro-table">
            <thead><tr><th>Emplacement</th><th>Réf</th><th>Requis</th><th>Disponible</th><th>Commande</th><th>Action</th></tr></thead>
            <tbody>
              {data.targets.map((t) => {
                const short = t.available < t.required;
                const p = picks[t.id];
                return (
                  <tr key={t.id} className={p && (short ? p.handling : p.qty > 0) ? "row-done" : short ? "row-alert" : ""}>
                    <td><b>{t.slot}</b></td>
                    <td>{t.ref}<small className="sub">{t.name}</small></td>
                    <td>{t.required}</td>
                    <td className={short ? "cell-bad" : "cell-ok"}>{t.available}</td>
                    <td>{t.cmd}</td>
                    <td>
                      {short ? (
                        <div className="btn-pair">
                          <button className={`btn ${p?.handling === "report" ? "btn-warn" : ""}`} onClick={() => setPicks((s) => ({ ...s, [t.id]: { qty: t.available, handling: "report" } }))}>Reporter</button>
                          <button className={`btn ${p?.handling === "substitute" ? "btn-warn" : ""}`} onClick={() => setPicks((s) => ({ ...s, [t.id]: { qty: t.available, handling: "substitute" } }))}>Substituer</button>
                        </div>
                      ) : (
                        <input className="qty-input" type="number" min={0} max={t.available} placeholder={String(t.required)} value={p?.qty ?? ""} onChange={(e) => setPicks((s) => ({ ...s, [t.id]: { qty: Number(e.target.value) } }))} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-big" onClick={validatePicking}>Valider le picking</button>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Contrôle & emballage</h2>
          <p className="hint">Sans défaut → Valider. Avec défaut → Reconditionner ou Bloquer. Puis affectez au quai de la destination.</p>
          <table className="pro-table">
            <thead><tr><th>Commande</th><th>Réf</th><th>Destination</th><th>Défaut</th><th>Décision</th><th>Quai</th></tr></thead>
            <tbody>
              {data.control.map((o) => {
                const c = ctrl[o.cmd];
                return (
                  <tr key={o.cmd} className={c?.decision && c?.quai ? "row-done" : ""}>
                    <td><b>{o.cmd}</b></td>
                    <td>{o.ref}<small className="sub">{o.name}</small></td>
                    <td>{o.destination}</td>
                    <td className={o.defect !== "Aucun" ? "cell-bad" : ""}>{o.defect}</td>
                    <td>
                      <select className="solo-select" value={c?.decision ?? ""} onChange={(e) => setCtrl((s) => ({ ...s, [o.cmd]: { ...s[o.cmd], decision: e.target.value } }))}>
                        <option value="" disabled>Choisir…</option>
                        {DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                    <td>
                      <div className="btn-pair">
                        {[1, 2].map((q) => (
                          <button key={q} className={`btn ${c?.quai === q ? "btn-go" : ""}`} onClick={() => setCtrl((s) => ({ ...s, [o.cmd]: { ...s[o.cmd], quai: q as 1 | 2 } }))}>Quai {q}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-big" onClick={validateControl}>Valider le contrôle</button>
        </section>
      )}
    </main>
  );
}
