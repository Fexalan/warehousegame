/**
 * Single-player ("Entraînement") mode container.
 *
 * A trainee picks ONE role and ONE difficulty, then works that role's three
 * steps alone against randomly-generated, self-contained data. No server, no
 * teammates. The existing multiplayer team mode is untouched.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MODES } from "@shared/constants";
import type { Difficulty } from "@shared/types";
import {
  SOLO_ROLE_BLURBS,
  SOLO_ROLE_LABELS,
  SOLO_ROLES,
  SOLO_STEP_LABELS,
  SOLO_TUNING,
  type SoloRole,
} from "./data";
import { ReceptionRole } from "./roles/Reception";
import { StockageRole } from "./roles/Stockage";
import { PreparationRole } from "./roles/Preparation";
import { ExpeditionRole } from "./roles/Expedition";
import { SoloDebrief } from "./SoloDebrief";

export interface TaskResult {
  index: number;
  label: string;
  score: number; // 0..100
}
export interface ScoreEvent {
  label: string;
  amount: number;
}

/** Handed to each role screen; the role drives its own 3 steps through it. */
export interface SoloApi {
  difficulty: Difficulty;
  tuning: (typeof SOLO_TUNING)[Difficulty];
  hints: boolean;
  /** log a mistake (Normal/Réaliste apply a penalty; Facile is penalty-free) */
  penalize: (label: string, base: number) => void;
  /** validate a task with a 0..100 score; advances the running total */
  completeTask: (index: number, score: number, label: string) => void;
  /** end the session and show the debrief */
  finish: () => void;
}

const ROLE_COMPONENTS: Record<SoloRole, (p: { api: SoloApi; seed: number }) => JSX.Element> = {
  reception: ReceptionRole,
  stockage: StockageRole,
  preparation: PreparationRole,
  expedition: ExpeditionRole,
};

type Phase = "setup" | "playing" | "debrief";

export function SoloApp({ onExit }: { onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [role, setRole] = useState<SoloRole>("reception");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [seed, setSeed] = useState(0);

  const [score, setScore] = useState(0);
  const [tasks, setTasks] = useState<TaskResult[]>([]);
  const [positives, setPositives] = useState<ScoreEvent[]>([]);
  const [penalties, setPenalties] = useState<ScoreEvent[]>([]);
  const [lastAction, setLastAction] = useState("Aucune action récente");
  const [remaining, setRemaining] = useState(0);
  const startedAt = useRef(0);
  const finishedRef = useRef(false);

  const tuning = SOLO_TUNING[difficulty];

  function begin() {
    setSeed((Math.random() * 1e9) | 0);
    setScore(0);
    setTasks([]);
    setPositives([]);
    setPenalties([]);
    setLastAction("Aucune action récente");
    finishedRef.current = false;
    startedAt.current = Date.now();
    setRemaining(tuning.durationSec);
    setPhase("playing");
  }

  // Countdown (Normal/Réaliste). Facile (durationSec 0) counts up, never fails.
  useEffect(() => {
    if (phase !== "playing") return;
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      if (tuning.durationSec > 0) {
        const left = tuning.durationSec - elapsed;
        setRemaining(left);
        if (left <= 0 && !finishedRef.current) finishSession();
      } else {
        setRemaining(elapsed); // count up
      }
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, difficulty]);

  function finishSession() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setPhase("debrief");
  }

  const api: SoloApi = useMemo(
    () => ({
      difficulty,
      tuning,
      hints: tuning.hints,
      penalize: (label, base) => {
        const amount = Math.round(base * tuning.penaltyMult);
        if (amount <= 0) return; // Facile: penalty-free
        setPenalties((p) => [...p, { label, amount }]);
        setScore((s) => Math.max(0, s - amount));
        setLastAction(`−${amount} ${label}`);
      },
      completeTask: (index, taskScore, label) => {
        const s = Math.max(0, Math.min(100, Math.round(taskScore)));
        setTasks((t) => (t.some((x) => x.index === index) ? t : [...t, { index, label, score: s }]));
        setPositives((p) => [...p, { label: `${label} validé`, amount: s }]);
        setScore((sc) => sc + s);
        setLastAction(`+${s} ${label} validé`);
      },
      finish: finishSession,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [difficulty],
  );

  // ---- SETUP ----
  if (phase === "setup") {
    return (
      <div className="lobby">
        <button className="btn solo-back" onClick={onExit}>← Retour</button>
        <h1>🎓 Mode Entraînement</h1>
        <p className="lobby-sub">
          Choisissez un poste et entraînez-vous seul. Vos données sont générées aléatoirement et
          indépendantes des autres postes.
        </p>

        <label className="solo-label">Poste à apprendre</label>
        <div className="role-grid">
          {SOLO_ROLES.map((r) => (
            <button key={r} className={`role-card ${role === r ? "on" : ""}`} onClick={() => setRole(r)}>
              <b>{SOLO_ROLE_LABELS[r]}</b>
              <small>{SOLO_ROLE_BLURBS[r]}</small>
              <small className="solo-steps">
                {SOLO_STEP_LABELS[r].map((s, i) => `${i + 1}. ${s}`).join("  ·  ")}
              </small>
            </button>
          ))}
        </div>

        <label className="solo-label">Difficulté</label>
        <div className="mode-select">
          {(Object.keys(MODES) as Difficulty[]).map((d) => (
            <button key={d} className={`mode-card ${difficulty === d ? "on" : ""}`} onClick={() => setDifficulty(d)}>
              <b>{MODES[d].label}</b>
              <small>{MODES[d].description}</small>
            </button>
          ))}
        </div>

        <button className="btn btn-big" onClick={begin}>
          ▶ Commencer l'entraînement — {SOLO_ROLE_LABELS[role]}
        </button>
      </div>
    );
  }

  // ---- DEBRIEF ----
  if (phase === "debrief") {
    return (
      <SoloDebrief
        role={role}
        difficulty={difficulty}
        score={score}
        tasks={tasks}
        positives={positives}
        penalties={penalties}
        onReplay={() => setPhase("setup")}
        onExit={onExit}
      />
    );
  }

  // ---- PLAYING ----
  const RoleComp = ROLE_COMPONENTS[role];
  const clock = remaining;
  const mm = Math.max(0, Math.floor(Math.abs(clock) / 60));
  const ss = Math.max(0, Math.abs(clock) % 60);
  const clockStr = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  const urgent = tuning.durationSec > 0 && remaining <= 30;

  return (
    <div className="app solo-app">
      <header className="hud solo-hud">
        <div className="solo-hud-id">
          <span className="hud-role-name">{SOLO_ROLE_LABELS[role]}</span>
          <span className="hud-team">Entraînement · {MODES[difficulty].label.split(" —")[0]}</span>
        </div>
        <div className={`hud-clock ${urgent ? "urgent" : ""}`}>
          {tuning.durationSec === 0 && <span className="timer-dot on">●</span>}
          🕑 {clockStr}
        </div>
        <div className="hud-kpis">
          <div>🏆 Score <b>{score}</b></div>
          <div className="solo-last">{lastAction}</div>
          <button className="btn" onClick={finishSession}>Terminer</button>
        </div>
      </header>
      <RoleComp api={api} seed={seed} />
    </div>
  );
}
