/**
 * Plan de prélèvement : plan de l'entrepôt, cliquer les produits de la
 * commande DANS L'ORDRE de la tournée. La distance affichée est celle du
 * plus court chemin réel entre les arrêts (couloirs).
 */
import { DEPOT, GRID_H, GRID_W, PRODUCTS, STAGING, isWalkable } from "@shared/constants";
import { tourDistance } from "@shared/grid";

const CS = 50;
const PAD = 6;

export function PlanMap({
  productIds,
  sequence,
  onToggle,
}: {
  productIds: string[]; // products of the order
  sequence: string[]; // chosen visit order so far
  onToggle: (productId: string) => void;
}) {
  const cells = sequence.map((pid) => PRODUCTS.find((p) => p.id === pid)!.cell);
  const dist = sequence.length > 0 ? tourDistance(cells) : 0;

  return (
    <div className="planmap">
      <svg viewBox={`0 0 ${GRID_W * CS + PAD * 2} ${GRID_H * CS + PAD * 2}`}>
        {Array.from({ length: GRID_H }, (_, y) =>
          Array.from({ length: GRID_W }, (_, x) => (
            <rect
              key={`${x},${y}`}
              x={PAD + x * CS + 1}
              y={PAD + y * CS + 1}
              width={CS - 2}
              height={CS - 2}
              rx={4}
              className={isWalkable(x, y) ? "cell-floor" : "cell-rack"}
            />
          ))
        )}

        {/* zone bands */}
        <text x={PAD + 2 * CS} y={PAD + 14} className="zone-label">Zone A</text>
        <text x={PAD + 5 * CS} y={PAD + 14} className="zone-label">Zone B</text>
        <text x={PAD + 9 * CS} y={PAD + 14} className="zone-label">Zone C</text>

        {/* products */}
        {PRODUCTS.map((p) => {
          const inOrder = productIds.includes(p.id);
          const seqIdx = sequence.indexOf(p.id);
          const cx = PAD + p.cell.x * CS + CS / 2;
          const cy = PAD + p.cell.y * CS + CS / 2;
          return (
            <g
              key={p.id}
              className={`plan-product ${inOrder ? "needed" : "dimmed"}`}
              onClick={() => inOrder && onToggle(p.id)}
              style={{ cursor: inOrder ? "pointer" : "default" }}
            >
              <circle cx={cx} cy={cy} r={CS / 2 - 4} className={seqIdx >= 0 ? "plan-dot picked" : inOrder ? "plan-dot target" : "plan-dot"} />
              <text x={cx} y={cy - 2} className="plan-id">{p.id.replace("PRD-", "")}</text>
              {seqIdx >= 0 && (
                <text x={cx} y={cy + 14} className="plan-seq">n°{seqIdx + 1}</text>
              )}
            </g>
          );
        })}

        <text x={PAD + DEPOT.x * CS + CS / 2} y={PAD + DEPOT.y * CS + CS / 2 + 5} className="cell-emoji">🚪</text>
        <text x={PAD + DEPOT.x * CS + CS / 2} y={PAD + DEPOT.y * CS + CS - 4} className="cell-stock">départ</text>
        <text x={PAD + STAGING.x * CS + CS / 2} y={PAD + STAGING.y * CS + CS / 2 + 5} className="cell-emoji">📤</text>
        <text x={PAD + STAGING.x * CS + CS / 2} y={PAD + STAGING.y * CS + CS - 4} className="cell-stock">quai</text>
      </svg>
      <div className="plan-meta">
        <span>
          Tournée : {sequence.length}/{productIds.length} arrêts
          {sequence.length > 0 && <> · distance estimée : <b>{dist} cases</b></>}
        </span>
      </div>
    </div>
  );
}
