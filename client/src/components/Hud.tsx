import { MODES, ROLE_LABELS } from "@shared/constants";
import type { TeamState } from "@shared/types";
import type { Seat } from "../useGame";
import { useSessionTimer } from "../useSessionTimer";
import { fmtClock } from "../useTicker";

export function Hud({ state, seat, gameNow }: { state: TeamState; seat: Seat; gameNow: () => number }) {
  const timer = useSessionTimer(state, seat.role, gameNow);
  const urgent = timer.kind === "countdown" && timer.displayMs < 60_000;

  return (
    <header className="hud">
      <div className="hud-role">
        <span className="hud-role-name">{ROLE_LABELS[seat.role]}</span>
        <span className="hud-team">
          {state.teamName} · {MODES[state.difficulty].label.split(" — ")[0]}
        </span>
      </div>
      <div className={`hud-clock ${urgent ? "urgent" : ""}`} title={timer.kind === "countdown" ? "Temps restant (équipe)" : "Votre temps actif (ne tourne que si vous avez du travail)"}>
        {timer.kind === "stopwatch" && (
          <span className={`timer-dot ${timer.running ? "on" : ""}`}>●</span>
        )}
        {fmtClock(timer.displayMs)}
      </div>
      <div className="hud-kpis">
        <span title="Commandes expédiées / total">📦 {state.shippedCount}/{state.orderCount}</span>
        <span className="hud-cost" title="Coût d'erreur cumulé">💸 {state.cost} €</span>
        {state.supervisorCount > 0 && (
          <span title="Interventions du superviseur">🧑‍🏫 {state.supervisorCount}</span>
        )}
      </div>
    </header>
  );
}
