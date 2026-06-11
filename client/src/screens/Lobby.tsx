import { useState } from "react";
import { MODES, ROLES, ROLE_LABELS } from "@shared/constants";
import type { Difficulty, LobbyState, RoleId } from "@shared/types";
import type { Seat } from "../useGame";

const ROLE_BLURBS: Record<RoleId, string> = {
  receiver: "Quais, contrôle livraison, mise en stock ABC",
  replenisher: "Réappro, rempotage, approche",
  picker: "Plan de prélèvement, picking, contrôle",
  dispatcher: "Planification camions, contrôle palettes, chargement",
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
  startGame: (difficulty: Difficulty) => void;
}) {
  const [name, setName] = useState("");
  const [gameId, setGameId] = useState("DEMO");
  const [teamId, setTeamId] = useState("1");
  const [role, setRole] = useState<RoleId>("receiver");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");

  if (phase === "lobby" && seat) {
    const teams = lobby?.teams.filter((t) => t.players.length > 0) ?? [];
    return (
      <div className="lobby">
        <h1>🏭 Simulateur Entrepôt</h1>
        <p className="lobby-sub">
          Session <b>{seat.gameId}</b> — vous êtes <b>{ROLE_LABELS[seat.role]}</b>, <b>Équipe {seat.teamId}</b>
        </p>
        <div className="lobby-teams">
          {teams.map((t) => (
            <div key={t.teamId} className={`lobby-team ${t.teamId === seat.teamId ? "mine" : ""}`}>
              <h3>Équipe {t.teamId}</h3>
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

        <div className="mode-select">
          {(Object.keys(MODES) as Difficulty[]).map((d) => (
            <button key={d} className={`mode-card ${difficulty === d ? "on" : ""}`} onClick={() => setDifficulty(d)}>
              <b>{MODES[d].label}</b>
              <small>{MODES[d].description}</small>
            </button>
          ))}
        </div>

        <button className="btn btn-big" onClick={() => startGame(difficulty)}>
          ▶ LANCER LA SESSION (toutes les équipes)
        </button>
      </div>
    );
  }

  return (
    <div className="lobby">
      <h1>🏭 Simulateur Entrepôt</h1>
      <p className="lobby-sub">4 postes, 1 chaîne logistique. Réception → Stock → Picking → Expédition.</p>
      <div className="join-form">
        <label>
          Votre nom
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" maxLength={14} />
        </label>
        <label>
          Code session
          <input value={gameId} onChange={(e) => setGameId(e.target.value.toUpperCase())} maxLength={10} />
        </label>
        <label>
          Équipe
          <div className="chip-row">
            {["1", "2", "3", "4", "5"].map((t) => (
              <button key={t} className={`chip ${teamId === t ? "on" : ""}`} onClick={() => setTeamId(t)}>
                Équipe {t}
              </button>
            ))}
          </div>
        </label>
        <label>
          Poste
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
          REJOINDRE LA SESSION
        </button>
      </div>
    </div>
  );
}
