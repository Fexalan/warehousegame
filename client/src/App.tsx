/**
 * Entry router. The game offers two coexisting modes:
 *   • Session équipe  — the original real-time multiplayer simulator (TeamApp)
 *   • Entraînement solo — a single-player trainer for one role (SoloApp)
 * Neither replaces the other; the Home screen lets you choose.
 */
import { useState } from "react";
import { SoloApp } from "./solo/SoloApp";
import { TeamApp } from "./TeamApp";

type Mode = "home" | "team" | "solo";

export default function App() {
  const [mode, setMode] = useState<Mode>("home");

  if (mode === "team") return <TeamApp onExit={() => setMode("home")} />;
  if (mode === "solo") return <SoloApp onExit={() => setMode("home")} />;

  return (
    <div className="lobby home">
      <h1>🏭 Simulateur Entrepôt</h1>
      <p className="lobby-sub">
        Réception → Stockage → Préparation → Expédition. Apprenez les gestes du métier, seul ou en équipe.
      </p>
      <div className="home-cards">
        <button className="home-card" onClick={() => setMode("solo")}>
          <span className="home-emoji">🎓</span>
          <b>Entraînement solo</b>
          <small>Choisissez un poste et entraînez-vous seul, à votre rythme. Données générées aléatoirement, indépendantes des autres postes. Idéal pour la formation rapide d'un nouvel opérateur.</small>
          <span className="home-go">Commencer →</span>
        </button>
        <button className="home-card" onClick={() => setMode("team")}>
          <span className="home-emoji">👥</span>
          <b>Session équipe</b>
          <small>Jusqu'à 5 équipes de 4. Chaque joueur tient un poste de la même chaîne logistique en temps réel, avec les 3 niveaux de difficulté (Facile · Normal · Réaliste).</small>
          <span className="home-go">Rejoindre →</span>
        </button>
      </div>
    </div>
  );
}
