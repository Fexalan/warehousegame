/**
 * Socket layer: rooms, intent routing, the 4 Hz broadcast loop.
 *
 * Room topology (asymmetric broadcast):
 *   g:{game}                      — everyone in the session (lobby, game_over)
 *   g:{game}:t:{team}             — one team's 4 screens (state snapshots)
 *   g:{game}:t:{team}:r:{role}    — a single role (targeted toasts/anomalies)
 */
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { TICK_MS } from "../../shared/constants";
import type {
  Difficulty,
  GameOverPayload,
  Intent,
  JoinPayload,
  LobbyState,
  PlayerInfo,
  RoleId,
  StartPayload,
  TeamReport,
} from "../../shared/types";
import { TeamEngine } from "./engine";
import { buildReport } from "./kpi";
import { hashSeed } from "./rng";

const PORT = Number(process.env.PORT ?? 3001);

interface SeatKey {
  gameId: string;
  teamId: string;
  role: RoleId;
  name: string;
}

interface Game {
  id: string;
  status: "lobby" | "running" | "over";
  difficulty: Difficulty;
  seed: number;
  startedAtWall: number;
  engines: Map<string, TeamEngine>;
  seats: Map<string, SeatKey>;
  interval: ReturnType<typeof setInterval> | null;
  reports: TeamReport[] | null;
}

const games = new Map<string, Game>();

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Warehouse simulator — game server running\n");
});

const io = new Server(httpServer, { cors: { origin: "*" } });

const teamRoom = (g: string, t: string) => `g:${g}:t:${t}`;
const roleRoom = (g: string, t: string, r: RoleId) => `g:${g}:t:${t}:r:${r}`;

function getGame(gameId: string): Game {
  let game = games.get(gameId);
  if (!game) {
    game = {
      id: gameId,
      status: "lobby",
      difficulty: "normal",
      seed: hashSeed(`${gameId}:${Date.now()}`),
      startedAtWall: 0,
      engines: new Map(),
      seats: new Map(),
      interval: null,
      reports: null,
    };
    games.set(gameId, game);
  }
  return game;
}

function teamPlayers(game: Game, teamId: string): PlayerInfo[] {
  const players: PlayerInfo[] = [];
  for (const [socketId, seat] of game.seats) {
    if (seat.teamId !== teamId) continue;
    const connected = io.sockets.sockets.get(socketId)?.connected ?? false;
    players.push({ name: seat.name, role: seat.role, connected });
  }
  return players;
}

function lobbyState(game: Game): LobbyState {
  const teamIds = new Set<string>(["1", "2", "3", "4", "5"]);
  for (const seat of game.seats.values()) teamIds.add(seat.teamId);
  return {
    gameId: game.id,
    status: game.status,
    difficulty: game.difficulty,
    teams: [...teamIds].sort().map((teamId) => ({ teamId, players: teamPlayers(game, teamId) })),
  };
}

function broadcastLobby(game: Game) {
  io.to(`g:${game.id}`).emit("lobby", lobbyState(game));
}

function startGame(game: Game, difficulty: Difficulty) {
  if (game.status !== "lobby") return;
  const teamIds = new Set([...game.seats.values()].map((s) => s.teamId));
  if (teamIds.size === 0) return;

  game.status = "running";
  game.difficulty = difficulty;
  game.startedAtWall = Date.now();
  for (const teamId of teamIds) {
    // Same seed + same difficulty for every team: identical workload.
    const engine = new TeamEngine(teamId, `Équipe ${teamId}`, game.seed, difficulty);
    engine.players = teamPlayers(game, teamId);
    game.engines.set(teamId, engine);
  }
  broadcastLobby(game);
  game.interval = setInterval(() => tickGame(game), TICK_MS);
}

function tickGame(game: Game) {
  const now = Date.now() - game.startedAtWall;
  let allOver = game.engines.size > 0;

  for (const [teamId, engine] of game.engines) {
    const effects = engine.tick(now);
    if (!effects.gameOver) allOver = false;

    for (const toast of effects.toasts) {
      const room = toast.role === "all" ? teamRoom(game.id, teamId) : roleRoom(game.id, teamId, toast.role);
      io.to(room).emit("toast", { message: toast.message, severity: toast.severity });
    }
    io.to(teamRoom(game.id, teamId)).emit("state", engine.serialize());
  }

  if (allOver) endGame(game);
}

function endGame(game: Game) {
  if (game.interval) clearInterval(game.interval);
  game.interval = null;
  game.status = "over";
  const reports = [...game.engines.values()].map(buildReport).sort((a, b) => b.score - a.score);
  game.reports = reports;
  const payload: GameOverPayload = { reports };
  io.to(`g:${game.id}`).emit("game_over", payload);
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

io.on("connection", (socket: Socket) => {
  socket.on("join", (payload: JoinPayload, ack?: (res: { ok: boolean; error?: string }) => void) => {
    const { gameId, teamId, name, role } = payload;
    if (!gameId || !teamId || !name || !role) {
      ack?.({ ok: false, error: "Champs manquants" });
      return;
    }
    const game = getGame(gameId);

    for (const [sid, seat] of game.seats) {
      if (seat.teamId === teamId && seat.role === role) {
        const other = io.sockets.sockets.get(sid);
        if (other?.connected && sid !== socket.id) {
          ack?.({ ok: false, error: `Le poste est déjà occupé dans l'équipe ${teamId}` });
          return;
        }
        game.seats.delete(sid);
      }
    }

    game.seats.set(socket.id, { gameId, teamId, role, name });
    socket.join(`g:${gameId}`);
    socket.join(teamRoom(gameId, teamId));
    socket.join(roleRoom(gameId, teamId, role));

    const engine = game.engines.get(teamId);
    if (engine) engine.players = teamPlayers(game, teamId);

    ack?.({ ok: true });
    broadcastLobby(game);

    if (game.status === "running" && engine) socket.emit("state", engine.serialize());
    if (game.status === "over" && game.reports) socket.emit("game_over", { reports: game.reports });
  });

  socket.on("start_game", (payload?: StartPayload) => {
    const seat = findSeat(socket.id);
    if (seat) startGame(getGame(seat.gameId), payload?.difficulty ?? "normal");
  });

  socket.on("intent", (intent: Intent) => {
    const seat = findSeat(socket.id);
    if (!seat) return;
    const game = games.get(seat.gameId);
    const engine = game?.engines.get(seat.teamId);
    if (!game || !engine || game.status !== "running") return;

    try {
      dispatchIntent(engine, intent);
    } catch (err) {
      socket.emit("toast", { message: (err as Error).message, severity: "warn" });
    }
  });

  socket.on("disconnect", () => {
    const seat = findSeat(socket.id);
    if (!seat) return;
    const game = games.get(seat.gameId);
    if (!game) return;
    const engine = game.engines.get(seat.teamId);
    if (engine) engine.players = teamPlayers(game, seat.teamId);
    broadcastLobby(game);
  });
});

function findSeat(socketId: string): SeatKey | null {
  for (const game of games.values()) {
    const seat = game.seats.get(socketId);
    if (seat) return seat;
  }
  return null;
}

function dispatchIntent(engine: TeamEngine, intent: Intent) {
  switch (intent.type) {
    // réception
    case "assign_dock":
      return engine.assignDock(intent.truckId, intent.dockId);
    case "control_line":
      return engine.controlLine(intent.lineId, intent.accept);
    case "putaway":
      return engine.putaway(intent.taskId, intent.zone);
    // stock
    case "replenish_order":
      return engine.replenishOrder(intent.productId, intent.qty);
    case "rempotage":
      return engine.rempotage(intent.palletProductId, intent.slotProductId);
    case "approche_send":
      return engine.approcheSend(intent.taskId);
    case "resolve_anomaly":
      return engine.resolveAnomaly(intent.anomalyId);
    // picking
    case "plan_route":
      return engine.planRoute(intent.orderId, intent.sequence);
    case "pick_assign":
      return engine.pickAssign(intent.orderId, intent.slotProductId, intent.qty);
    case "stockout_action":
      return engine.stockoutAction(intent.orderId, intent.productId, intent.action);
    case "pick_control":
      return engine.pickControl(intent.orderId, intent.conformMarks);
    // expédition
    case "assign_truck":
      return engine.assignTruck(intent.orderId, intent.truckId);
    case "unassign_truck":
      return engine.unassignTruck(intent.orderId);
    case "pallet_check":
      return engine.palletCheck(intent.orderId, intent.approve);
    case "load_item":
      return engine.loadItem(intent.truckId, intent.orderId);
    case "close_loading":
      return engine.closeLoading(intent.truckId);
    case "dispatch_truck":
      return engine.dispatchTruck(intent.truckId);
  }
}

httpServer.listen(PORT, () => {
  console.log(`🏭 Warehouse simulator server listening on :${PORT}`);
});
