/**
 * Debrief : classement, KPIs réels, heatmap des goulots, registre des
 * interventions du Superviseur, coûts par poste et conseils de formation.
 */
import { useState } from "react";
import { MODES, ROLES, ROLE_LABELS, STAGES, STAGE_LABELS } from "@shared/constants";
import type { TeamReport } from "@shared/types";
import type { Seat } from "../useGame";
import { fmtClock } from "../useTicker";

export function Dashboard({ reports, seat }: { reports: TeamReport[]; seat: Seat | null }) {
  const myTeamId = seat?.teamId ?? reports[0]?.teamId;
  const [viewTeamId, setViewTeamId] = useState(myTeamId);
  const report = reports.find((r) => r.teamId === viewTeamId) ?? reports[0];
  if (!report) return <div className="lobby"><h1>Aucun résultat</h1></div>;
  const easy = report.difficulty === "easy";

  return (
    <div className="dashboard">
      <h1>🏁 Débrief de session — {MODES[report.difficulty].label.split(" — ")[0]}</h1>

      <section className="panel leaderboard">
        <h2>🏆 Classement</h2>
        <table>
          <thead>
            <tr><th>#</th><th>Équipe</th><th>Score</th><th>OTIF</th><th>Expédiées</th><th>Coût d'erreur</th></tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <tr key={r.teamId} className={r.teamId === viewTeamId ? "on" : ""} onClick={() => setViewTeamId(r.teamId)}>
                <td>{["🥇", "🥈", "🥉"][i] ?? i + 1}</td>
                <td>{r.teamName}{r.teamId === myTeamId ? " (vous)" : ""}</td>
                <td><b>{r.score}</b></td>
                <td>{r.otif.pct}%</td>
                <td>{r.otif.shipped}/{r.otif.total}</td>
                <td>{r.errorCost.total} €</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2 className="detail-title">📋 {report.teamName} — détail</h2>

      <section className="kpi-cards">
        <div className="kpi-card">
          <span className="kpi-value">{report.otif.pct}%</span>
          <span className="kpi-label">OTIF — On-Time In-Full</span>
          <small>{report.otif.onTimeInFull} commandes parfaites sur {report.otif.total}</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-value">{report.dockUtilization.busyPct}%</span>
          <span className="kpi-label">Utilisation des quais</span>
          <small>attente moy. {report.dockUtilization.avgWaitSec} s · max {report.dockUtilization.maxWaitSec} s</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-value">{report.errorCost.total} €</span>
          <span className="kpi-label">Coût d'erreur</span>
          <small>{report.errorCost.log.length} décisions pénalisées</small>
        </div>
        {easy && (
          <div className="kpi-card">
            <span className="kpi-label">Temps actif par poste</span>
            {ROLES.map((r) => (
              <small key={r}>{ROLE_LABELS[r]} : {fmtClock(report.roleTimers[r].activeMs)}</small>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>🌡 Heatmap équipe — où le flux a-t-il coincé ?</h2>
        <Heatmap report={report} />
        <p className="heatmap-legend">Plus c'est foncé, plus le poste était engorgé · ⭐ = goulot qui bloquait les autres</p>
      </section>

      {report.supervisor.length > 0 && (
        <section className="panel">
          <h2>🧑‍🏫 Interventions du Superviseur ({report.supervisor.length})</h2>
          <p className="hint">Chaque ligne est une erreur corrigée avant d'atteindre le poste suivant — en mode Réaliste, elle se serait propagée.</p>
          <table className="cost-table">
            <thead>
              <tr><th>Quand</th><th>Poste</th><th>Étape</th><th>Ce qui a été fait</th><th>Correction appliquée</th><th>Pénalité</th></tr>
            </thead>
            <tbody>
              {report.supervisor.map((e, i) => (
                <tr key={i}>
                  <td>{fmtClock(e.at)}</td>
                  <td>{ROLE_LABELS[e.role]}</td>
                  <td>{e.step}</td>
                  <td>{e.original}</td>
                  <td>{e.corrected}</td>
                  <td className="cost-amount">{e.penalty} €</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>💸 Coût d'erreur par poste</h2>
        <div className="role-cost-row">
          {ROLES.map((r) => (
            <div key={r} className="kpi-card">
              <span className="kpi-value small">{report.errorCost.byRole[r]} €</span>
              <span className="kpi-label">{ROLE_LABELS[r]}</span>
            </div>
          ))}
        </div>
        <table className="cost-table" style={{ marginTop: 12 }}>
          <tbody>
            {report.errorCost.breakdown.map((b) => (
              <tr key={b.label}>
                <td>{b.label}</td>
                <td>{b.count}×</td>
                <td className="cost-amount">{b.amount} €</td>
              </tr>
            ))}
            {report.errorCost.breakdown.length === 0 && <tr><td>Session sans erreur — exécution parfaite 🎯</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel insights">
        <h2>🎓 Conseils de formation</h2>
        <ul>
          {report.insights.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>

      <button className="btn btn-big" onClick={() => location.reload()}>↺ NOUVELLE SESSION</button>
    </div>
  );
}

function Heatmap({ report }: { report: TeamReport }) {
  const { buckets, bucketMs } = report.heatmap;
  return (
    <div className="heatmap" style={{ gridTemplateColumns: `90px repeat(${buckets.length}, 1fr)` }}>
      {STAGES.map((stage) => (
        <div key={stage} style={{ display: "contents" }}>
          <span className="heatmap-stage">{STAGE_LABELS[stage]}</span>
          {buckets.map((b) => {
            const p = b.pressures[stage];
            const isBottleneck = b.bottleneck === stage;
            return (
              <div
                key={b.t}
                className={`heatmap-cell ${isBottleneck ? "bottleneck" : ""}`}
                style={{ backgroundColor: `rgba(239, 68, 68, ${0.08 + p * 0.85})` }}
                title={`${fmtClock(b.t)}–${fmtClock(b.t + bucketMs)} · ${STAGE_LABELS[stage]} ${Math.round(p * 100)}%${isBottleneck ? " · GOULOT" : ""}`}
              >
                {isBottleneck ? "⭐" : ""}
              </div>
            );
          })}
        </div>
      ))}
      <span className="heatmap-stage" />
      {buckets.map((b, i) => (
        <span key={b.t} className="heatmap-time">{i % 4 === 0 ? fmtClock(b.t) : ""}</span>
      ))}
    </div>
  );
}
