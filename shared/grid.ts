/**
 * Warehouse plan distances, shared by server (plan validation, optimal
 * computation) and client (live distance preview while clicking the plan).
 */
import { DEPOT, STAGING, cellKey, isWalkable } from "./constants";
import type { Cell } from "./types";

/** BFS shortest path length between two cells along corridors. */
export function bfsDistance(from: Cell, to: Cell): number {
  if (from.x === to.x && from.y === to.y) return 0;
  const queue: [Cell, number][] = [[from, 0]];
  const seen = new Set([cellKey(from)]);
  while (queue.length) {
    const [cur, d] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: cur.x + dx, y: cur.y + dy };
      if (!isWalkable(n.x, n.y) || seen.has(cellKey(n))) continue;
      if (n.x === to.x && n.y === to.y) return d + 1;
      seen.add(cellKey(n));
      queue.push([n, d + 1]);
    }
  }
  return Infinity;
}

/** Total tour distance: depot -> each stop in sequence -> staging. */
export function tourDistance(stops: Cell[]): number {
  let total = 0;
  let cur = DEPOT;
  for (const stop of stops) {
    total += bfsDistance(cur, stop);
    cur = stop;
  }
  return total + bfsDistance(cur, STAGING);
}

/** Best possible tour over all stop permutations (orders have ≤ 4 lines). */
export function optimalTour(stops: Cell[]): number {
  if (stops.length <= 1) return tourDistance(stops);
  let best = Infinity;
  const permute = (rest: Cell[], acc: Cell[]) => {
    if (rest.length === 0) {
      best = Math.min(best, tourDistance(acc));
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    }
  };
  permute(stops, []);
  return best;
}
