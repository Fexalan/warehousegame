# The Ripple Effect — Architecture & Data Flow

A continuous-flow, asymmetric co-op warehouse simulator. 7 minutes, 5 teams,
4 interdependent roles per team. This document explains the real-time
architecture and where each mechanic lives in the code.

---

## 1. Architecture & Data Flow

### Why WebSocket (authoritative server) over Firebase

Both were evaluated. The deciding factor is that this game is a **simulation
with a heartbeat**, not a shared document:

| Requirement | Firebase RTDB/Firestore | Authoritative WebSocket server |
| --- | --- | --- |
| Continuous spawning (trucks/orders every N sec) | Needs Cloud Functions cron or a "host client" (cheatable, dies on refresh) | Native: a 4 Hz `setInterval` per game |
| Server-side validation (capacity, route legality, swipe truth) | Security rules can't express "route must visit pick points" | One `validateRoute()` function |
| Hidden information (damaged pallets, ghost stock) | Clients read the document — secrets leak | Private engine fields, stripped at serialization |
| Identical scenario for 5 competing teams | Hard to coordinate | One seed, one PRNG, five engines |
| Latency for "lightning-fast" UI | 100–300 ms round trips through commit layers | 10–50 ms socket round trip |

**Verdict:** `socket.io` + an in-memory authoritative engine. Firebase remains a
great fit for the *meta* layer (auth, saved reports, trainer accounts) and a
hybrid is noted at the end of this section.

### The one rule that makes asymmetry work

> Clients never mutate state. They send **intents**; the server validates,
> mutates one shared `TeamState`, and broadcasts the new snapshot to all four
> screens.

```
 Receiver ──┐  intent: qc_swipe          ┌──▶ Receiver   (renders yard/QC slice)
 Replenisher┤  intent: transfer          ├──▶ Replenisher(renders stock slice)
 Picker ────┼─────────▶ TeamEngine ──────┼──▶ Picker     (renders queue/map slice)
 Dispatcher ┘  intent: load_order  4 Hz  └──▶ Dispatcher (renders staging slice)
                        │
                        └── telemetry log ──▶ KPI report at minute 7
```

Because all four screens render *slices of the same snapshot*, the ripple
effect is automatic: when the Receiver stalls, the Replenisher's inbound
buffer dries up, the Picker's pick-face numbers fall on the map, and the
Dispatcher's staging lane empties — with zero extra synchronization code.

### Room topology (asymmetric broadcast)

`server/src/index.ts`:

```
g:{game}                    everyone        → lobby updates, game_over
g:{game}:t:{team}           one team        → 4 Hz TeamState snapshots
g:{game}:t:{team}:r:{role}  a single role   → targeted curveballs & toasts
```

A curveball that only concerns the Picker is emitted to
`g:DEMO:t:3:r:picker` — the other three screens never even receive the
packet. That is the "asymmetric data flow" requirement in one line of code.

### Wire protocol

| Direction | Event | Payload |
| --- | --- | --- |
| C→S | `join` | `{gameId, teamId, name, role}` (ack with ok/error) |
| C→S | `start_game` | — (starts ALL teams on the same seed) |
| C→S | `intent` | discriminated union, see `shared/types.ts` (`Intent`) |
| S→C | `state` | full `TeamState` snapshot, 4 Hz, team room |
| S→C | `curveball` | `Curveball`, role room only |
| S→C | `toast` | `{message, severity}`, role room or single socket |
| S→C | `game_over` | all `TeamReport`s, ranked |

Full snapshots (not diffs) are deliberate: a `TeamState` is ~10–20 KB of JSON,
4 Hz × 20 clients is trivial, and snapshots make reconnects free (a refreshed
tab just renders the next snapshot). If state grew 10×, the upgrade path is
JSON-patch diffs per room — the client is already a pure `state → UI` function
so nothing else changes.

### Time & fairness

* All timestamps are **game-relative ms**; the client computes a wall-clock
  offset from each snapshot (`useGame.ts: clockOffset`) so countdowns animate
  smoothly between 4 Hz updates with no clock-skew bugs.
* All 5 teams get the **same PRNG seed** (`server/src/rng.ts`,
  `scenario.ts`): identical trucks, identical orders, identical curveball
  schedule. Leaderboard differences are pure decision quality.

### Hidden information

Two facts are private engine state, never serialized
(`engine.ts: damagedPallets`, `ghostSkuId`):

* whether a pallet is damaged — the Receiver must *read the inspection cues*;
* the ghost pallet — the WMS keeps displaying stock until the Picker
  physically discovers the empty location.

### Hybrid Firebase option (if you need it later)

Keep the WebSocket engine, add Firebase around it: Firebase Auth for trainer
logins, Firestore for persisting `TeamReport`s across cohorts (longitudinal
training analytics), Hosting for the client. The engine then writes one
document per finished session — Firestore is excellent at exactly that.

---

## 2. Rapid UI/UX — where the two key components live

* **Receiver QC swipe deck:** `client/src/components/SwipeQC.tsx`
  One pallet, one gesture. Drag right past 100 px → accept → single tap for
  the ABC zone (the card shows "FAST/MEDIUM/SLOW mover", the player maps it
  to a zone — that mapping *is* the lesson). Drag left → reject. Damage is
  expressed only through inspection cues; misreads are billed by the engine.

* **Picker routing map:** `client/src/components/RouteMap.tsx`
  SVG grid, finger-drag from the depot through corridors. Route length is
  real time cost (`MS_PER_CELL`), straight drags are interpolated, sliding
  backwards pops the path, blocked aisles (🚧) refuse the pen. GO is enabled
  only when every pick point is covered and the route ends at staging — the
  server re-validates everything (`engine.ts: validateRoute`).

## 3. Curveball injector

`server/src/scenario.ts` (seeded schedule: one of each kind + one random,
jittered across the session) and `engine.ts: fireCurveball()` (effects +
role targeting). Broadcast happens in `index.ts: tickGame()` via role rooms.

* **Rush order** → targets dispatcher+picker; destination is chosen to match
  a live outbound truck so success is possible but only with fast hand-offs.
* **Damaged rack** → targets picker; if the *active* route crosses the wreck
  it is cancelled mid-drive and the order drops back into the queue.
* **Ghost pallet** → targets nobody at first (silent). Discovery happens at
  pick time; flagging re-targets the alert to the replenisher. If the
  replenisher happens to refill the slot before anyone notices, it
  self-heals silently — just like real life.

## 4. Educational feedback loop

`server/src/kpi.ts` builds the debrief from the engine's telemetry:

* **OTIF** — shipped ≤ deadline, complete, right destination / all orders.
* **Dock utilization** — dock busy %, average & max yard wait, trucks served.
* **Error cost** — every costed decision is an event in `costLog`
  (`engine.ts: charge()`), priced by the table in `shared/constants.ts:COSTS`;
  the report groups the ledger by root cause, most expensive habit first.
* **Team heatmap** — every tick samples a 0–1 "pressure" per stage
  (`engine.ts: sampleTelemetry`), averaged into 15 s buckets; the bucket's
  bottleneck is the highest pressure above 0.4. Rendered as the 4×28 grid in
  `client/src/screens/Dashboard.tsx`.
* **Coaching insights** — sustained bottleneck runs (≥30 s) are translated
  into trainer language with timestamps ("From 2:15 to 3:00 the bottleneck
  was REPLENISHMENT: pick faces ran below minimum…"), plus the most expensive
  error habit and an OTIF headline.

## Repository layout

```
shared/          types.ts (wire model), constants.ts (rules, costs, grid, SKUs)
server/src/      index.ts (sockets/rooms), engine.ts (simulation),
                 scenario.ts (seeded generation), kpi.ts (report), rng.ts
client/src/      useGame.ts (socket hook), App.tsx, screens/ (Lobby, 4 roles,
                 Dashboard), components/ (SwipeQC, RouteMap, Hud, Toasts,
                 CurveballBanner)
```
