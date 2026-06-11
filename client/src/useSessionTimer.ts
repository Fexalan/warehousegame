/**
 * TIMER ARCHITECTURE — one hook, two clock models.
 *
 * Normal / Réaliste (globalTimer): one synchronized countdown for the whole
 * team, derived from the server clock (never the local one — the snapshot
 * carries `clock.now` and we keep a wall-clock offset, so refreshes and
 * laggy tabs all agree).
 *
 * Facile (per-role timers): the SERVER owns the rule "your timer only runs
 * while your queue has a backlog" (engine.updateRoleTimers). The snapshot
 * carries `{activeMs, running}` per role; this hook only extrapolates the
 * value between 4 Hz snapshots so the display ticks smoothly. The client
 * never decides whether a timer runs — it would drift and it would be
 * cheatable.
 */
import { useEffect, useRef, useState } from "react";
import { MODES } from "@shared/constants";
import type { RoleId, TeamState } from "@shared/types";

export interface SessionTimer {
  /** what the HUD should display, in ms */
  displayMs: number;
  /** global modes: time remaining; easy: my accumulated active time */
  kind: "countdown" | "stopwatch";
  /** easy mode: is MY queue currently running my timer? */
  running: boolean;
}

export function useSessionTimer(state: TeamState, role: RoleId, gameNow: () => number): SessionTimer {
  const mode = MODES[state.difficulty];
  // Re-render at 4 Hz so the displayed value ticks between snapshots.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);

  // Remember when the last snapshot arrived (wall clock) to extrapolate.
  const snapRef = useRef({ at: Date.now(), serverNow: state.clock.now, timers: state.roleTimers });
  if (snapRef.current.serverNow !== state.clock.now) {
    snapRef.current = { at: Date.now(), serverNow: state.clock.now, timers: state.roleTimers };
  }

  if (mode.globalTimer) {
    return {
      kind: "countdown",
      running: true,
      displayMs: Math.max(0, state.clock.durationMs - gameNow()),
    };
  }

  // Easy: extrapolate my activeMs only while the server says it's running.
  const snap = snapRef.current;
  const mine = snap.timers[role];
  const extra = mine.running ? Date.now() - snap.at : 0;
  return { kind: "stopwatch", running: mine.running, displayMs: mine.activeMs + extra };
}
