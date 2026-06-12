/**
 * Solo end-of-session debrief — a per-role performance dashboard.
 * Inspired by the reference's grade card, evolved with the trainee's own
 * difficulty context, per-task bars, strengths and improvement axes.
 */
import { MODES } from "@shared/constants";
import type { Difficulty } from "@shared/types";
import { SOLO_ROLE_LABELS, SOLO_STEP_LABELS, type SoloRole } from "./data";
import type { ScoreEvent, TaskResult } from "./SoloApp";

function grade(pct: number): { letter: string; label: string } {
  if (pct >= 90) return { letter: "A", label: "Excellent" };
  if (pct >= 75) return { letter: "B", label: "Très bien" };
  if (pct >= 60) return { letter: "C", label: "Satisfaisant" };
  if (pct >= 40) return { letter: "D", label: "À renforcer" };
  return { letter: "E", label: "Insuffisant" };
}

export function SoloDebrief({
  role,
  difficulty,
  score,
  tasks,
  positives,
  penalties,
  onReplay,
  onExit,
}: {
  role: SoloRole;
  difficulty: Difficulty;
  score: number;
  tasks: TaskResult[];
  positives: ScoreEvent[];
  penalties: ScoreEvent[];
  onReplay: () => void;
  onExit: () => void;
}) {
  const stepLabels = SOLO_STEP_LABELS[role];
  const maxScore = 300; // 3 tasks × 100
  const pct = Math.round((score / maxScore) * 100);
  const g = grade(pct);
  const done = tasks.length;

  const topPositives = [...positives].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const topPenalties = [...penalties].sort((a, b) => b.amount - a.amount).slice(0, 3);

  const best = [...tasks].sort((a, b) => b.score - a.score)[0];
  const worst = [...tasks].sort((a, b) => a.score - b.score)[0];
  const missing = [0, 1, 2].filter((i) => !tasks.some((t) => t.index === i));

  return (
    <div className="dashboard solo-debrief">
      <div className="solo-grade-banner">🏆 Entraînement terminé</div>
      <h1>Tableau de Bord — {SOLO_ROLE_LABELS[role]}</h1>
      <p className="lobby-sub">
        Difficulté : {MODES[difficulty].label.split(" —")[0]} · Analyse de votre performance
      </p>

      <div className="kpi-cards">
        <div className="kpi-card grade-card">
          <div className={`grade-letter grade-${g.letter}`}>{g.letter}</div>
          <div className="kpi-label">{g.label}</div>
          <div className="kpi-value small">{score} <small>/ {maxScore} pts</small></div>
          <small>{done}/3 tâches complétées</small>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">✓ Taux de réussite</div>
          <div className="kpi-value">{pct}%</div>
          <small>{tasks.reduce((a, t) => a + t.score, 0)} pts gagnés</small>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">⚡ Progression</div>
          <div className="kpi-value">{Math.round((done / 3) * 100)}%</div>
          <small>du rôle complété</small>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">⚠️ Pénalités</div>
          <div className="kpi-value small">{penalties.reduce((a, p) => a + p.amount, 0)} pts</div>
          <small>{penalties.length} erreur(s)</small>
        </div>
      </div>

      <section className="panel">
        <h2>Performance par tâche (max 100 pts / tâche)</h2>
        <div className="task-bars">
          {stepLabels.map((label, i) => {
            const t = tasks.find((x) => x.index === i);
            return (
              <div key={i} className="task-bar">
                <div className="task-bar-head">
                  <span className="tag">{label}</span>
                  <b>{t ? `${t.score}/100` : "—"}</b>
                </div>
                <div className="cap-bar">
                  <div className="cap-fill" style={{ width: `${t ? t.score : 0}%` }} />
                </div>
                <small className="muted">{t ? "Complétée" : "Non complétée"}</small>
              </div>
            );
          })}
        </div>
      </section>

      <div className="solo-debrief-cols">
        <section className="panel">
          <h2>Top actions positives</h2>
          {topPositives.length === 0 && <p className="muted">Aucune action enregistrée.</p>}
          {topPositives.map((p, i) => (
            <div key={i} className="debrief-row positive">
              <span>{p.label}</span>
              <b className="cell-ok">+{p.amount}</b>
            </div>
          ))}
        </section>
        <section className="panel">
          <h2>Top pénalités</h2>
          {topPenalties.length === 0 && <p className="muted">Aucune pénalité enregistrée. 👏</p>}
          {topPenalties.map((p, i) => (
            <div key={i} className="debrief-row negative">
              <span>{p.label}</span>
              <b className="cell-bad">−{p.amount}</b>
            </div>
          ))}
        </section>
      </div>

      <div className="solo-debrief-cols">
        <section className="panel insights">
          <h2>Points forts</h2>
          <ul>
            {best && best.score >= 60 && (
              <li>⭐ Bonne maîtrise de « {stepLabels[best.index]} » ({best.score}/100 pts).</li>
            )}
            {penalties.length === 0 && <li>✅ Aucune erreur commise sur cette session.</li>}
            {best && best.score < 60 && <li>Continuez à vous entraîner pour consolider vos acquis.</li>}
          </ul>
        </section>
        <section className="panel insights">
          <h2>Axes d'amélioration</h2>
          <ul>
            {missing.map((i) => (
              <li key={i}>⚠️ Tâche « {stepLabels[i]} » non complétée.</li>
            ))}
            {worst && worst.score < 75 && tasks.length === 3 && (
              <li>📈 Revoir « {stepLabels[worst.index]} » (score le plus bas : {worst.score}/100).</li>
            )}
            {missing.length === 0 && worst && worst.score >= 75 && (
              <li>👌 Performance homogène sur les trois tâches. Tentez la difficulté supérieure.</li>
            )}
          </ul>
        </section>
      </div>

      <div className="solo-debrief-actions">
        <button className="btn btn-big" onClick={onReplay}>↻ Rejouer / changer de poste</button>
        <button className="btn" onClick={onExit}>Accueil</button>
      </div>
    </div>
  );
}
