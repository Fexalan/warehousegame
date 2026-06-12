/**
 * Collaborative (multiplayer) mode — the original game, unchanged in behaviour.
 * Extracted from App so that the socket connection (useGame) only mounts when
 * the player actually chooses the team session, never during solo training.
 */
import { Hud } from "./components/Hud";
import { Toasts } from "./components/Toasts";
import { Dashboard } from "./screens/Dashboard";
import { DispatcherScreen } from "./screens/DispatcherScreen";
import { Lobby } from "./screens/Lobby";
import { PickerScreen } from "./screens/PickerScreen";
import { ReceiverScreen } from "./screens/ReceiverScreen";
import { ReplenisherScreen } from "./screens/ReplenisherScreen";
import { useGame } from "./useGame";
import { useTicker } from "./useTicker";

export function TeamApp({ onExit }: { onExit: () => void }) {
  const game = useGame();
  useTicker(250); // re-render for countdowns & progress bars

  if (game.phase === "over" && game.reports) {
    return <Dashboard reports={game.reports} seat={game.seat} />;
  }

  if (game.phase === "playing" && game.state && game.seat) {
    const { state, seat } = game;
    const screen = {
      receiver: <ReceiverScreen state={state} send={game.send} gameNow={game.gameNow} />,
      replenisher: <ReplenisherScreen state={state} send={game.send} gameNow={game.gameNow} />,
      picker: <PickerScreen state={state} send={game.send} gameNow={game.gameNow} />,
      dispatcher: <DispatcherScreen state={state} send={game.send} gameNow={game.gameNow} />,
    }[seat.role];

    return (
      <div className="app">
        <Hud state={state} seat={seat} gameNow={game.gameNow} />
        {screen}
        <Toasts toasts={game.toasts} />
      </div>
    );
  }

  return (
    <div className="team-wrap">
      <button className="btn solo-back" onClick={onExit}>← Accueil</button>
      <Lobby
        phase={game.phase}
        lobby={game.lobby}
        seat={game.seat}
        joinError={game.joinError}
        join={game.join}
        startGame={game.startGame}
      />
    </div>
  );
}
