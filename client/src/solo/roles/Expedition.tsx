/**
 * Solo — Expédition. Three steps:
 *   1. Planification : affecter les commandes aux camions (ville + capacité)
 *   2. Contrôle Palettes : décision selon le défaut constaté
 *   3. Chargement : ordonner les palettes (lourdes d'abord, fragiles en dernier)
 */
import { useMemo, useState } from "react";
import { InfoTab } from "../InfoTab";
import {
  type ExpeditionData,
  type ShipOrder,
  SOLO_STEP_INFO,
  SOLO_STEP_LABELS,
  genExpedition,
} from "../data";
import { mulberry32 } from "../rng";
import type { SoloApi } from "../SoloApp";

const STEPS = SOLO_STEP_LABELS.expedition;
const INFO = SOLO_STEP_INFO.expedition;
const PALLET_DECISIONS = ["Valider", "Corriger", "Réaffecter", "Retarder"];

/** load rank: heavy goes first (0), fragile last (2), the rest in the middle (1). */
function loadRank(o: ShipOrder): number {
  if (o.heavy) return 0;
  if (o.fragile) return 2;
  return 1;
}

export function ExpeditionRole({ api, seed }: { api: SoloApi; seed: number }) {
  const data: ExpeditionData = useMemo(() => genExpedition(mulberry32(seed), api.tuning), [seed, api.tuning]);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false]);

  // step 1: { cmd: truckId | "report" }
  const [assign, setAssign] = useState<Record<string, string>>({});
  // step 2: { cmd: decision }
  const [ctrl, setCtrl] = useState<Record<string, string>>({});
  // step 3: loading sequence (subset of order cmds)
  const loadSet = useMemo(() => data.orders.slice(0, Math.min(5, data.orders.length)), [data.orders]);
  const [seq, setSeq] = useState<string[]>([]);

  function finishMaybe(next: [boolean, boolean, boolean]) { if (next.every(Boolean)) api.finish(); }

  function validatePlanning() {
    const orders = data.orders;
    if (orders.some((o) => !assign[o.cmd])) return;
    // capacity used per truck
    const used: Record<string, number> = {};
    let correct = 0;
    for (const o of orders) {
      const a = assign[o.cmd];
      if (a === "report") {
        if (o.priority === "basse") correct++;
        else api.penalize(`Report d'une priorité ${o.priority} (${o.cmd})`, 15);
        continue;
      }
      const truck = data.trucks.find((t) => t.id === a)!;
      used[a] = (used[a] ?? 0) + o.pallets;
      const destOk = truck.destination === o.destination;
      const capOk = used[a] <= truck.capacity;
      if (destOk && capOk) correct++;
      else if (!destOk) api.penalize(`Mauvaise destination (${o.cmd}→${truck.destination})`, 18);
      else api.penalize(`Capacité dépassée (${truck.id})`, 12);
    }
    const score = Math.round((correct / orders.length) * 100);
    api.completeTask(0, score, STEPS[0]);
    const next: [boolean, boolean, boolean] = [true, done[1], done[2]];
    setDone(next); setStep(1); finishMaybe(next);
  }

  function validateControl() {
    const orders = data.orders;
    if (orders.some((o) => !ctrl[o.cmd])) return;
    let correct = 0;
    for (const o of orders) {
      const decision = ctrl[o.cmd];
      const conform = !o.unstable;
      if (conform ? decision === "Valider" : decision !== "Valider") correct++;
      else api.penalize(`Décision palette erronée (${o.cmd})`, 12);
    }
    const score = Math.round((correct / orders.length) * 100);
    api.completeTask(1, score, STEPS[1]);
    const next: [boolean, boolean, boolean] = [done[0], true, done[2]];
    setDone(next); setStep(2); finishMaybe(next);
  }

  function toggleSeq(cmd: string) {
    setSeq((s) => (s.includes(cmd) ? s.filter((x) => x !== cmd) : [...s, cmd]));
  }

  function validateLoading() {
    if (seq.length < loadSet.length) return;
    const ordered = seq.map((c) => loadSet.find((o) => o.cmd === c)!);
    let good = 0, total = 0;
    for (let i = 0; i < ordered.length - 1; i++) {
      total++;
      if (loadRank(ordered[i]) <= loadRank(ordered[i + 1])) good++;
      else api.penalize(`Ordre de chargement risqué (${ordered[i].cmd})`, 10);
    }
    const score = total ? Math.round((good / total) * 100) : 100;
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
          <h2>Planification des expéditions</h2>
          <p className="hint">Affectez chaque commande à un camion de la bonne ville sans dépasser sa capacité. Ne reportez que les priorités basses.</p>
          <div className="solo-plan-banner">
            <b>Flotte du jour :</b>
            {data.trucks.map((t) => (
              <span key={t.id} className="tag">{t.id} · {t.destination} · cap. {t.capacity} · {t.departure}</span>
            ))}
          </div>
          <table className="pro-table">
            <thead><tr><th>Commande</th><th>Destination</th><th>Palettes</th><th>Priorité</th><th>Affectation</th></tr></thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.cmd} className={assign[o.cmd] ? "row-done" : ""}>
                  <td><b>{o.cmd}</b><small className="sub">{o.ref}</small></td>
                  <td>{o.destination}</td>
                  <td>{o.pallets}</td>
                  <td><span className={`tag prio-${o.priority}`}>{o.priority}</span></td>
                  <td>
                    <select className="solo-select" value={assign[o.cmd] ?? ""} onChange={(e) => setAssign((s) => ({ ...s, [o.cmd]: e.target.value }))}>
                      <option value="" disabled>Choisir…</option>
                      {data.trucks.map((t) => <option key={t.id} value={t.id}>{t.id} ({t.destination})</option>)}
                      <option value="report">⏭ Reporter à demain</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={data.orders.some((o) => !assign[o.cmd])} onClick={validatePlanning}>Valider le planning</button>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Contrôle des palettes</h2>
          <p className="hint">Palette conforme → Valider. Palette instable → Corriger, Réaffecter ou Retarder.</p>
          <table className="pro-table">
            <thead><tr><th>Commande</th><th>Destination</th><th>Défaut</th><th>Décision</th></tr></thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.cmd} className={ctrl[o.cmd] ? "row-done" : ""}>
                  <td><b>{o.cmd}</b></td>
                  <td>{o.destination}</td>
                  <td className={o.unstable ? "cell-bad" : ""}>{o.unstable ? "Palette instable" : "Aucun"}</td>
                  <td>
                    <select className="solo-select" value={ctrl[o.cmd] ?? ""} onChange={(e) => setCtrl((s) => ({ ...s, [o.cmd]: e.target.value }))}>
                      <option value="" disabled>Choisir…</option>
                      {PALLET_DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-big" disabled={data.orders.some((o) => !ctrl[o.cmd])} onClick={validateControl}>Valider ce contrôle</button>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h2>Chargement</h2>
          <p className="hint">Cliquez les palettes dans l'ordre de chargement : lourdes d'abord, fragiles en dernier.</p>
          <div className="solo-load-grid">
            {loadSet.map((o) => {
              const order = seq.indexOf(o.cmd);
              return (
                <button key={o.cmd} className={`order-card ${order >= 0 ? "on" : ""}`} onClick={() => toggleSeq(o.cmd)}>
                  <div className="order-head">
                    <b>{o.cmd}</b>
                    {order >= 0 && <span className="path-seq">#{order + 1}</span>}
                  </div>
                  <small className="sub">{o.ref} · {o.pallets} pal.</small>
                  <div className="order-lines">
                    {o.heavy && <span className="tag tag-warn">lourde</span>}
                    {o.fragile && <span className="tag tag-bad">fragile</span>}
                    {o.unstable && <span className="tag tag-bad">instable</span>}
                    {!o.heavy && !o.fragile && !o.unstable && <span className="tag">standard</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>{seq.length}/{loadSet.length} palettes séquencées</p>
          <button className="btn btn-big" disabled={seq.length < loadSet.length} onClick={validateLoading}>Valider le départ</button>
        </section>
      )}
    </main>
  );
}
