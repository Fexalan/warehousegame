/**
 * Picker's dynamic routing map.
 *
 * UX contract: finger/mouse down on the depot, DRAG through the corridors,
 * lift, hit GO. The drawn length is real time cost (MS_PER_CELL), so a lazy
 * route is a slow route. Blocked aisles (damaged-rack curveball) appear live
 * and invalidate any path through them — forcing the instant redraw the
 * curveball is designed to teach.
 */
import { useMemo, useRef, useState } from "react";
import {
  DEPOT,
  GRID_H,
  GRID_W,
  MS_PER_CELL,
  PICK_MS_PER_LINE,
  SKUS,
  STAGING,
  cellEq,
  cellKey,
  isWalkable,
  skuById,
} from "@shared/constants";
import type { ActiveRoute, Cell, Order, TeamState } from "@shared/types";

const CS = 52; // cell size in px
const PAD = 6;

interface Props {
  state: TeamState;
  order: Order | null; // selected order to route
  path: Cell[];
  setPath: (p: Cell[]) => void;
  onGo: () => void;
  gameNow: () => number;
}

export function RouteMap({ state, order, path, setPath, onGo, gameNow }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drawing, setDrawing] = useState(false);

  const blocked = useMemo(() => new Set(state.blockedCells.map(cellKey)), [state.blockedCells]);
  const targets = useMemo(
    () =>
      order
        ? order.lines.filter((l) => l.picked < l.qty).map((l) => skuById(l.skuId).cell)
        : [],
    [order]
  );
  const visited = useMemo(() => new Set(path.map(cellKey)), [path]);
  const targetsCovered = targets.every((t) => visited.has(cellKey(t)));
  const endsAtStaging = path.length > 0 && cellEq(path[path.length - 1], STAGING);
  const ready = !!order && path.length > 1 && targetsCovered && endsAtStaging;

  const etaSec = order
    ? Math.round(
        (path.length * MS_PER_CELL +
          order.lines.filter((l) => l.picked < l.qty).length * PICK_MS_PER_LINE) /
          1000
      )
    : 0;

  // ---- pointer -> grid cell ----
  const cellAt = (e: React.PointerEvent): Cell | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const scale = rect.width / (GRID_W * CS + PAD * 2);
    const x = Math.floor(((e.clientX - rect.left) / scale - PAD) / CS);
    const y = Math.floor(((e.clientY - rect.top) / scale - PAD) / CS);
    if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return null;
    return { x, y };
  };

  const canStep = (c: Cell) => isWalkable(c.x, c.y) && !blocked.has(cellKey(c));

  const extendTo = (cell: Cell) => {
    setPathSafe((prev) => {
      const last = prev[prev.length - 1];
      if (!last || cellEq(cell, last)) return prev;
      // backtrack: sliding back onto the previous cell pops the last step
      if (prev.length > 1 && cellEq(cell, prev[prev.length - 2])) return prev.slice(0, -1);
      // interpolate straight drags across several cells
      const steps: Cell[] = [];
      let cur = last;
      while (!cellEq(cur, cell)) {
        const dx = Math.sign(cell.x - cur.x);
        const dy = cur.x === cell.x ? Math.sign(cell.y - cur.y) : 0;
        cur = { x: cur.x + dx, y: cur.y + dy };
        if (!canStep(cur)) return prev; // hit a rack/blocked aisle: stop
        steps.push(cur);
        if (steps.length > GRID_W + GRID_H) return prev;
      }
      return [...prev, ...steps];
    });
  };

  // setPath comes from the parent as a plain setter; emulate functional form
  const setPathSafe = (fn: (prev: Cell[]) => Cell[]) => setPath(fn(path));

  const onPointerDown = (e: React.PointerEvent) => {
    if (state.activeRoute || !order) return;
    const cell = cellAt(e);
    if (!cell) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (path.length === 0) {
      if (cellEq(cell, DEPOT)) {
        setPath([DEPOT]);
        setDrawing(true);
      }
    } else {
      setDrawing(true);
      extendTo(cell);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const cell = cellAt(e);
    if (cell) extendTo(cell);
  };

  // ---- live forklift position while a route runs ----
  const forklift = forkliftPos(state.activeRoute, gameNow());

  return (
    <div className="routemap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRID_W * CS + PAD * 2} ${GRID_H * CS + PAD * 2}`}
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrawing(false)}
        onPointerCancel={() => setDrawing(false)}
      >
        {/* grid */}
        {Array.from({ length: GRID_H }, (_, y) =>
          Array.from({ length: GRID_W }, (_, x) => {
            const key = `${x},${y}`;
            const walk = isWalkable(x, y);
            const isBlocked = blocked.has(key);
            return (
              <rect
                key={key}
                x={PAD + x * CS + 1}
                y={PAD + y * CS + 1}
                width={CS - 2}
                height={CS - 2}
                rx={4}
                className={isBlocked ? "cell-blocked" : walk ? "cell-floor" : "cell-rack"}
              />
            );
          })
        )}

        {/* drawn path */}
        {path.length > 1 && (
          <polyline
            className="route-line"
            points={path.map((c) => `${PAD + c.x * CS + CS / 2},${PAD + c.y * CS + CS / 2}`).join(" ")}
          />
        )}

        {/* SKU pick points with live pick-face stock */}
        {SKUS.map((sku) => {
          const stock = state.stock.find((s) => s.skuId === sku.id);
          const isTarget = targets.some((t) => cellEq(t, sku.cell));
          const done = isTarget && visited.has(cellKey(sku.cell));
          return (
            <g key={sku.id} pointerEvents="none">
              {isTarget && (
                <circle
                  cx={PAD + sku.cell.x * CS + CS / 2}
                  cy={PAD + sku.cell.y * CS + CS / 2}
                  r={CS / 2 - 3}
                  className={done ? "target-ring done" : "target-ring"}
                />
              )}
              <text x={PAD + sku.cell.x * CS + CS / 2} y={PAD + sku.cell.y * CS + CS / 2 + 2} className="cell-emoji">
                {sku.emoji}
              </text>
              <text x={PAD + sku.cell.x * CS + CS / 2} y={PAD + sku.cell.y * CS + CS - 6} className="cell-stock">
                {stock?.pick ?? 0}
              </text>
            </g>
          );
        })}

        {/* blocked markers */}
        {state.blockedCells.map((c) => (
          <text key={cellKey(c)} x={PAD + c.x * CS + CS / 2} y={PAD + c.y * CS + CS / 2 + 6} className="cell-emoji" pointerEvents="none">
            🚧
          </text>
        ))}

        {/* depot & staging */}
        <text x={PAD + DEPOT.x * CS + CS / 2} y={PAD + DEPOT.y * CS + CS / 2 + 6} className="cell-emoji" pointerEvents="none">
          🏠
        </text>
        <text x={PAD + STAGING.x * CS + CS / 2} y={PAD + STAGING.y * CS + CS / 2 + 6} className="cell-emoji" pointerEvents="none">
          📤
        </text>

        {/* live forklift */}
        {forklift && (
          <text x={PAD + forklift.x * CS + CS / 2} y={PAD + forklift.y * CS + CS / 2 + 6} className="cell-emoji forklift" pointerEvents="none">
            🛻
          </text>
        )}
      </svg>

      <div className="route-controls">
        {state.activeRoute ? (
          <span className="route-running">🛻 Picking… {Math.max(0, Math.ceil((state.activeRoute.finishAt - gameNow()) / 1000))}s</span>
        ) : (
          <>
            <span className="route-eta">
              {path.length > 0 ? `${path.length} cells · ~${etaSec}s` : order ? "Draw from 🏠 depot" : "Select an order"}
              {order && !targetsCovered && path.length > 0 && " · pick points missing"}
              {order && targetsCovered && !endsAtStaging && " · finish at 📤"}
            </span>
            <button className="btn" onClick={() => setPath([])} disabled={path.length === 0}>
              Clear
            </button>
            <button className="btn btn-go" onClick={onGo} disabled={!ready}>
              GO ▶
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function forkliftPos(route: ActiveRoute | null, now: number): Cell | null {
  if (!route) return null;
  const idx = Math.min(route.path.length - 1, Math.floor((now - route.startedAt) / MS_PER_CELL));
  return route.path[Math.max(0, idx)];
}
