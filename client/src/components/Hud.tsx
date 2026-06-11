import { ROLE_LABELS } from "@shared/constants";
import type { TeamState } from "@shared/types";
import type { Seat } from "../useGame";
import { fmtClock } from "../useTicker";

export function Hud({ state, seat, gameNow }: { state: TeamState; seat: Seat; gameNow: () => number }) {
  const remaining = state.clock.durationMs - gameNow();
  const urgent = remaining < 60_000;
  return (
    <header className="hud">
      <div className="hud-role">
        <span className="hud-role-name">{ROLE_LABELS[seat.role]}</span>
        <span className="hud-team">{state.teamName}</span>
      </div>
      <div className={`hud-clock ${urgent ? "urgent" : ""}`}>{fmtClock(remaining)}</div>
      <div className="hud-kpis">
        <span title="Orders shipped / total">
          📦 {state.shippedCount}/{state.orderCount}
        </span>
        <span className="hud-cost" title="Error cost so far">
          💸 €{state.cost}
        </span>
      </div>
    </header>
  );
}
