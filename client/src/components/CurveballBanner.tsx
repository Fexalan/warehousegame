import type { Curveball } from "@shared/types";
import { fmtClock } from "../useTicker";

const TITLES: Record<Curveball["kind"], string> = {
  rush_order: "🚨 VIP RUSH ORDER",
  damaged_rack: "💥 FORKLIFT ACCIDENT",
  ghost_pallet: "👻 GHOST PALLET",
};

/**
 * Full-width interrupt banner for role-targeted curveballs. Demands a tap to
 * dismiss — the point is to force an immediate, conscious decision.
 */
export function CurveballBanner({
  curveball,
  dismiss,
  gameNow,
}: {
  curveball: Curveball | null;
  dismiss: () => void;
  gameNow: () => number;
}) {
  if (!curveball) return null;

  let detail = "";
  if (curveball.kind === "rush_order") {
    const deadline = (curveball.payload.deadline as number) ?? 0;
    detail = `Order ${curveball.payload.label} must ship in ${fmtClock(deadline - gameNow())}. Jump it to the front of the queue!`;
  } else if (curveball.kind === "damaged_rack") {
    detail = "An aisle is blocked. Any route through it is dead — redraw immediately.";
  } else {
    detail = "The system stock is wrong — the location is empty. Flag the discrepancy so replenishment can fix it.";
  }

  return (
    <div className="curveball-overlay" onClick={dismiss}>
      <div className={`curveball curveball-${curveball.kind}`}>
        <h2>{TITLES[curveball.kind]}</h2>
        <p>{detail}</p>
        <button className="btn btn-big">GOT IT — GO!</button>
      </div>
    </div>
  );
}
