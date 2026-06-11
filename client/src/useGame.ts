/**
 * Single socket connection + client game state machine.
 * The client is a pure renderer: it sends intents, the server owns truth.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type {
  Curveball,
  GameOverPayload,
  Intent,
  JoinPayload,
  LobbyState,
  RoleId,
  TeamReport,
  TeamState,
  ToastMsg,
} from "@shared/types";

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `${location.protocol}//${location.hostname}:3001`;

export interface Seat {
  gameId: string;
  teamId: string;
  name: string;
  role: RoleId;
}

export interface Toast extends ToastMsg {
  id: number;
}

export interface GameClient {
  phase: "join" | "lobby" | "playing" | "over";
  seat: Seat | null;
  lobby: LobbyState | null;
  state: TeamState | null;
  reports: TeamReport[] | null;
  toasts: Toast[];
  curveball: Curveball | null;
  joinError: string | null;
  join: (seat: Seat) => void;
  startGame: () => void;
  send: (intent: Intent) => void;
  dismissCurveball: () => void;
  /** server-synchronized game clock (game-relative ms), smooth between snapshots */
  gameNow: () => number;
}

let toastId = 0;

export function useGame(): GameClient {
  const socketRef = useRef<Socket | null>(null);
  const [phase, setPhase] = useState<GameClient["phase"]>("join");
  const [seat, setSeat] = useState<Seat | null>(null);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [state, setState] = useState<TeamState | null>(null);
  const [reports, setReports] = useState<TeamReport[] | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [curveball, setCurveball] = useState<Curveball | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // wall-clock offset so countdowns animate smoothly between 4 Hz snapshots
  const clockOffset = useRef(0);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("lobby", (l: LobbyState) => {
      setLobby(l);
      setPhase((p) => (p === "join" ? p : l.status === "lobby" ? "lobby" : p));
    });

    socket.on("state", (s: TeamState) => {
      clockOffset.current = Date.now() - s.clock.now;
      setState(s);
      setPhase((p) => (p === "over" ? p : "playing"));
    });

    socket.on("toast", (t: ToastMsg) => {
      const toast: Toast = { ...t, id: ++toastId };
      setToasts((prev) => [...prev.slice(-3), toast]);
      const ttl = t.severity === "alert" ? 6000 : 3500;
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== toast.id)), ttl);
    });

    socket.on("curveball", (cb: Curveball) => {
      setCurveball(cb);
    });

    socket.on("game_over", (payload: GameOverPayload) => {
      setReports(payload.reports);
      setCurveball(null);
      setPhase("over");
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const join = useCallback((s: Seat) => {
    setJoinError(null);
    const payload: JoinPayload = s;
    socketRef.current?.emit("join", payload, (res: { ok: boolean; error?: string }) => {
      if (res.ok) {
        setSeat(s);
        setPhase("lobby");
      } else {
        setJoinError(res.error ?? "Could not join");
      }
    });
  }, []);

  const startGame = useCallback(() => {
    socketRef.current?.emit("start_game");
  }, []);

  const send = useCallback((intent: Intent) => {
    socketRef.current?.emit("intent", intent);
  }, []);

  const dismissCurveball = useCallback(() => setCurveball(null), []);

  const gameNow = useCallback(() => Date.now() - clockOffset.current, []);

  return {
    phase, seat, lobby, state, reports, toasts, curveball, joinError,
    join, startGame, send, dismissCurveball, gameNow,
  };
}
