/**
 * Tinder-style quality-control swipe deck.
 *
 * UX contract: ONE pallet, ONE decision, ONE gesture.
 *   swipe right  -> accept  -> one tap to pick the ABC put-away zone
 *   swipe left   -> reject
 *
 * Damage is never labelled — the Receiver must READ the inspection cues
 * under time pressure. That reading-under-pressure loop is the training.
 */
import { useRef, useState } from "react";
import { skuById } from "@shared/constants";
import type { AbcZone, Pallet } from "@shared/types";

const SWIPE_THRESHOLD = 100;

const VELOCITY_TEXT: Record<AbcZone, string> = {
  A: "FAST mover",
  B: "MEDIUM mover",
  C: "SLOW mover",
};

interface Props {
  pallets: Pallet[]; // pallets awaiting QC, first = top of deck
  onDecide: (palletId: string, accept: boolean, zone?: AbcZone) => void;
}

export function SwipeQC({ pallets, onDecide }: Props) {
  const [dx, setDx] = useState(0);
  const [zonePickFor, setZonePickFor] = useState<Pallet | null>(null);
  const dragging = useRef(false);
  const startX = useRef(0);

  const top = pallets[0];

  if (!top && !zonePickFor) {
    return <div className="qc-empty">No pallets at QC — dock the next truck!</div>;
  }

  // ---- Step 2: one-tap zone assignment after an accept ----
  if (zonePickFor) {
    const sku = skuById(zonePickFor.skuId);
    return (
      <div className="qc-zone-pick">
        <p>
          ✅ Accepted: <b>{sku.emoji} {sku.name}</b> × {zonePickFor.qty}
          <br />
          <span className="qc-velocity">{VELOCITY_TEXT[sku.zone]} — where does it go?</span>
        </p>
        <div className="zone-buttons">
          {(["A", "B", "C"] as AbcZone[]).map((z) => (
            <button
              key={z}
              className={`btn zone-btn zone-${z}`}
              onClick={() => {
                onDecide(zonePickFor.id, true, z);
                setZonePickFor(null);
              }}
            >
              Zone {z}
              <small>{z === "A" ? "front · fast" : z === "B" ? "middle" : "back · slow"}</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- Step 1: the swipe ----
  const sku = skuById(top.skuId);
  const rotation = dx / 14;
  const verdict = dx > 40 ? "accept" : dx < -40 ? "reject" : null;

  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (dx > SWIPE_THRESHOLD) {
      setZonePickFor(top); // accept -> choose zone
    } else if (dx < -SWIPE_THRESHOLD) {
      onDecide(top.id, false); // reject
    }
    setDx(0);
  };

  return (
    <div className="qc-deck">
      {/* peek of the next card */}
      {pallets[1] && <div className="qc-card qc-card-under" />}

      <div
        className={`qc-card ${verdict ? `verdict-${verdict}` : ""}`}
        style={{ transform: `translateX(${dx}px) rotate(${rotation}deg)` }}
        onPointerDown={(e) => {
          dragging.current = true;
          startX.current = e.clientX;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging.current) setDx(e.clientX - startX.current);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div className="qc-card-head">
          <span className="qc-emoji">{sku.emoji}</span>
          <div>
            <b>{sku.name}</b>
            <div className="qc-qty">{top.qty} units · {VELOCITY_TEXT[sku.zone]}</div>
          </div>
        </div>
        <ul className="qc-cues">
          {top.cues.map((cue, i) => (
            <li key={i}>👀 {cue}</li>
          ))}
        </ul>
        <div className="qc-stamp qc-stamp-accept" style={{ opacity: Math.max(0, Math.min(1, dx / SWIPE_THRESHOLD)) }}>
          ACCEPT ✓
        </div>
        <div className="qc-stamp qc-stamp-reject" style={{ opacity: Math.max(0, Math.min(1, -dx / SWIPE_THRESHOLD)) }}>
          ✗ REJECT
        </div>
      </div>

      <div className="qc-hints">
        <span>← swipe to REJECT</span>
        <span className="qc-count">{pallets.length} in deck</span>
        <span>swipe to ACCEPT →</span>
      </div>
    </div>
  );
}
