/**
 * Post-game educational dashboard: leaderboard, real KPIs, the bottleneck
 * heatmap and coaching insights. This screen IS the training debrief.
 */
import { useState } from "react";
import { STAGES, STAGE_LABELS } from "@shared/constants";
import type { TeamReport } from "@shared/types";
import type { Seat } from "../useGame";
import { fmtClock } from "../useTicker";

export function Dashboard({ reports, seat }: { reports: TeamReport[]; seat: Seat | null }) {
  const myTeamId = seat?.teamId ?? reports[0]?.teamId;
  const [viewTeamId, setViewTeamId] = useState(myTeamId);
  const report = reports.find((r) => r.teamId === viewTeamId) ?? reports[0];
  if (!report) return <div className="lobby"><h1>No results</h1></div>;

  return (
    <div className="dashboard">
      <h1>🏁 Session Debrief</h1>

      <section className="panel leaderboard">
        <h2>🏆 Leaderboard</h2>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Team</th><th>Score</th><th>OTIF</th><th>Shipped</th><th>Error cost</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <tr
                key={r.teamId}
                className={r.teamId === viewTeamId ? "on" : ""}
                onClick={() => setViewTeamId(r.teamId)}
              >
                <td>{["🥇", "🥈", "🥉"][i] ?? i + 1}</td>
                <td>{r.teamName}{r.teamId === myTeamId ? " (you)" : ""}</td>
                <td><b>{r.score}</b></td>
                <td>{r.otif.pct}%</td>
                <td>{r.otif.shipped}/{r.otif.total}</td>
                <td>€{r.errorCost.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2 className="detail-title">📋 {report.teamName} — detail</h2>

      <section className="kpi-cards">
        <div className="kpi-card">
          <span className="kpi-value">{report.otif.pct}%</span>
          <span className="kpi-label">OTIF — On-Time In-Full</span>
          <small>{report.otif.onTimeInFull} of {report.otif.total} orders perfect</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-value">{report.dockUtilization.busyPct}%</span>
          <span className="kpi-label">Dock Utilization</span>
          <small>
            avg yard wait {report.dockUtilization.avgWaitSec}s · max {report.dockUtilization.maxWaitSec}s
          </small>
        </div>
        <div className="kpi-card">
          <span className="kpi-value">€{report.errorCost.total}</span>
          <span className="kpi-label">Error Cost</span>
          <small>{report.errorCost.log.length} costly decisions</small>
        </div>
      </section>

      <section className="panel">
        <h2>🌡 Team Heatmap — where did the flow jam?</h2>
        <Heatmap report={report} />
        <p className="heatmap-legend">
          Darker = more backed up · ⭐ = the bottleneck holding everyone else hostage
        </p>
      </section>

      <section className="panel">
        <h2>💸 Error Cost breakdown</h2>
        <table className="cost-table">
          <tbody>
            {report.errorCost.breakdown.map((b) => (
              <tr key={b.label}>
                <td>{b.label}</td>
                <td>{b.count}×</td>
                <td className="cost-amount">€{b.amount}</td>
              </tr>
            ))}
            {report.errorCost.breakdown.length === 0 && (
              <tr><td>Zero-error session — flawless execution 🎯</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel insights">
        <h2>🎓 Coaching insights</h2>
        <ul>
          {report.insights.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>

      <button className="btn btn-big" onClick={() => location.reload()}>
        ↺ NEW SESSION
      </button>
    </div>
  );
}

function Heatmap({ report }: { report: TeamReport }) {
  const { buckets, bucketMs } = report.heatmap;
  return (
    <div className="heatmap" style={{ gridTemplateColumns: `90px repeat(${buckets.length}, 1fr)` }}>
      {STAGES.map((stage) => (
        <div key={stage} className="heatmap-row" style={{ display: "contents" }}>
          <span className="heatmap-stage">{STAGE_LABELS[stage]}</span>
          {buckets.map((b) => {
            const p = b.pressures[stage];
            const isBottleneck = b.bottleneck === stage;
            return (
              <div
                key={b.t}
                className={`heatmap-cell ${isBottleneck ? "bottleneck" : ""}`}
                style={{ backgroundColor: `rgba(239, 68, 68, ${0.08 + p * 0.85})` }}
                title={`${fmtClock(b.t)}–${fmtClock(b.t + bucketMs)} · ${STAGE_LABELS[stage]} pressure ${Math.round(p * 100)}%${isBottleneck ? " · BOTTLENECK" : ""}`}
              >
                {isBottleneck ? "⭐" : ""}
              </div>
            );
          })}
        </div>
      ))}
      <span className="heatmap-stage" />
      {buckets.map((b, i) => (
        <span key={b.t} className="heatmap-time">
          {i % 4 === 0 ? fmtClock(b.t) : ""}
        </span>
      ))}
    </div>
  );
}
