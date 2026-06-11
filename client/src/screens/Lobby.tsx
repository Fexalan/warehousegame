import { useState } from "react";
import { ROLES, ROLE_LABELS } from "@shared/constants";
import type { LobbyState, RoleId } from "@shared/types";
import type { Seat } from "../useGame";

const ROLE_BLURBS: Record<RoleId, string> = {
  receiver: "Dock trucks, swipe pallets, triage quality",
  replenisher: "Keep pick faces stocked, cross-dock smart",
  picker: "Draw the fastest routes, beat deadlines",
  dispatcher: "Load trucks, balance capacity, ship on time",
};

export function Lobby({
  phase,
  lobby,
  seat,
  joinError,
  join,
  startGame,
}: {
  phase: "join" | "lobby" | "playing" | "over";
  lobby: LobbyState | null;
  seat: Seat | null;
  joinError: string | null;
  join: (seat: Seat) => void;
  startGame: () => void;
}) {
  const [name, setName] = useState("");
  const [gameId, setGameId] = useState("DEMO");
  const [teamId, setTeamId] = useState("1");
  const [role, setRole] = useState<RoleId>("receiver");

  if (phase === "lobby" && seat) {
    const teams = lobby?.teams.filter((t) => t.players.length > 0) ?? [];
    return (
      <div className="lobby">
        <h1>🏭 The Ripple Effect</h1>
        <p className="lobby-sub">
          Session <b>{seat.gameId}</b> — you are <b>{ROLE_LABELS[seat.role]}</b> on <b>Team {seat.teamId}</b>
        </p>
        <div className="lobby-teams">
          {teams.map((t) => (
            <div key={t.teamId} className={`lobby-team ${t.teamId === seat.teamId ? "mine" : ""}`}>
              <h3>Team {t.teamId}</h3>
              {ROLES.map((r) => {
                const p = t.players.find((pl) => pl.role === r);
                return (
                  <div key={r} className={`lobby-seat ${p ? "filled" : ""}`}>
                    <span>{ROLE_LABELS[r]}</span>
                    <span>{p ? `${p.name} ${p.connected ? "🟢" : "🔴"}` : "—"}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <button className="btn btn-big" onClick={startGame}>
          ▶ START 7-MINUTE SESSION (all teams)
        </button>
        <p className="lobby-hint">Empty seats stay idle — that team will feel the bottleneck.</p>
      </div>
    );
  }

  return (
    <div className="lobby">
      <h1>🏭 The Ripple Effect</h1>
      <p className="lobby-sub">Continuous-flow warehouse simulator — 4 roles, 1 supply chain, 7 minutes.</p>
      <div className="join-form">
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" maxLength={14} />
        </label>
        <label>
          Session code
          <input value={gameId} onChange={(e) => setGameId(e.target.value.toUpperCase())} maxLength={10} />
        </label>
        <label>
          Team
          <div className="chip-row">
            {["1", "2", "3", "4", "5"].map((t) => (
              <button key={t} className={`chip ${teamId === t ? "on" : ""}`} onClick={() => setTeamId(t)}>
                Team {t}
              </button>
            ))}
          </div>
        </label>
        <label>
          Role
          <div className="role-grid">
            {ROLES.map((r) => (
              <button key={r} className={`role-card ${role === r ? "on" : ""}`} onClick={() => setRole(r)}>
                <b>{ROLE_LABELS[r]}</b>
                <small>{ROLE_BLURBS[r]}</small>
              </button>
            ))}
          </div>
        </label>
        {joinError && <p className="join-error">{joinError}</p>}
        <button
          className="btn btn-big"
          disabled={!name.trim() || !gameId.trim()}
          onClick={() => join({ gameId: gameId.trim(), teamId, name: name.trim(), role })}
        >
          JOIN SESSION
        </button>
      </div>
    </div>
  );
}
