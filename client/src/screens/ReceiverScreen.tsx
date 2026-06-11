/**
 * Receiver: inbound triage. Two continuous loops —
 *   1) yard management: assign waiting trucks to free docks (tap, tap)
 *   2) quality control: swipe the docked pallets (SwipeQC)
 */
import { useState } from "react";
import type { Intent, TeamState } from "@shared/types";
import { SwipeQC } from "../components/SwipeQC";
import { fmtClock } from "../useTicker";

export function ReceiverScreen({ state, send }: { state: TeamState; send: (i: Intent) => void }) {
  const [selectedTruck, setSelectedTruck] = useState<string | null>(null);

  const waiting = state.inboundTrucks.filter((t) => t.status === "waiting");
  const qcPallets = state.inboundTrucks
    .filter((t) => t.status === "docked")
    .flatMap((t) => t.pallets.filter((p) => p.status === "qc"));

  return (
    <main className="screen receiver">
      <section className="panel yard">
        <h2>🚛 Yard ({waiting.length} waiting)</h2>
        <div className="yard-row">
          {waiting.map((t) => {
            const waitMs = state.clock.now - t.arrivedAt;
            return (
              <button
                key={t.id}
                className={`yard-truck ${selectedTruck === t.id ? "on" : ""} ${waitMs > 30_000 ? "late" : ""}`}
                onClick={() => setSelectedTruck(t.id)}
              >
                <b>{t.label}</b>
                <span>{t.pallets.length} plt</span>
                <span className="wait">⏱ {fmtClock(waitMs)}</span>
              </button>
            );
          })}
          {waiting.length === 0 && <p className="muted">Yard clear ✅</p>}
        </div>
        <div className="dock-row">
          {state.docks.map((d) => {
            const truck = state.inboundTrucks.find((t) => t.id === d.truckId);
            return (
              <button
                key={d.id}
                className={`dock ${truck ? "busy" : "free"}`}
                disabled={!!truck || !selectedTruck}
                onClick={() => {
                  if (selectedTruck) {
                    send({ type: "assign_dock", truckId: selectedTruck, dockId: d.id });
                    setSelectedTruck(null);
                  }
                }}
              >
                <b>{d.label}</b>
                <span>{truck ? `${truck.label} unloading` : selectedTruck ? "TAP TO DOCK ➜" : "free"}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel qc">
        <h2>🔍 Quality Control</h2>
        <SwipeQC
          pallets={qcPallets}
          onDecide={(palletId, accept, zone) => send({ type: "qc_swipe", palletId, accept, zone })}
        />
      </section>
    </main>
  );
}
