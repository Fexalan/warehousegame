# Simulateur Entrepôt — Architecture & Data Flow

A professional, step-based warehouse training simulator. Up to 5 teams,
4 interdependent roles per team, 3 difficulty modes. This document explains
the real-time architecture and where each mechanic lives in the code.

---

## 1. Architecture & data flow

### Why WebSocket (authoritative server) over Firebase

The game is a **simulation with a heartbeat**, not a shared document:

| Requirement | Firebase RTDB/Firestore | Authoritative WebSocket server |
| --- | --- | --- |
| Continuous spawning (trucks/orders) + scheduled jobs (rempotage, transit) | Needs Cloud Functions cron or a "host client" | Native: 4 Hz `setInterval` per game |
| Server-side validation (réappro math, plan legality, capacities) | Security rules can't express it | Plain functions in the engine |
| Hidden information (damage flags, wrong-slot contents) | Clients read the document — secrets leak | Private engine fields, stripped at serialization |
| The Supervisor (intercept + sanitize between roles) | Client-side = trivially bypassed | One server-side choke point |
| Identical scenario for 5 competing teams | Hard to coordinate | One seed, one PRNG, five engines |

**Verdict:** `socket.io` + in-memory authoritative engine. Firebase remains a
good fit for the meta layer (auth, persisting `TeamReport`s across cohorts).

### The one rule that makes asymmetry work

> Clients never mutate state. They send **intents**; the server validates,
> mutates one shared `TeamState`, broadcasts the new snapshot. All four
> screens render slices of the same snapshot, so upstream slowness is
> *visible* downstream with zero extra synchronization code.

### Room topology (asymmetric broadcast)

`server/src/index.ts`:

```
g:{game}                    everyone        → lobby updates, game_over
g:{game}:t:{team}           one team        → 4 Hz TeamState snapshots
g:{game}:t:{team}:r:{role}  a single role   → targeted toasts & anomalies
```

### Time & fairness

* All timestamps are game-relative ms; the client keeps a wall-clock offset
  (`useGame.ts`) so countdowns animate smoothly with no clock-skew bugs.
* All teams share the **same PRNG seed and difficulty** (`rng.ts`,
  `scenario.ts`): identical deliveries (including planted discrepancies),
  identical orders, identical staging incidents.

---

## 2. The four role workflows (3 steps each)

| Role | Steps | Files |
| --- | --- | --- |
| Réception | Planification quai → Contrôle livraison (bon de commande vs bon de livraison, table) → Mise en stock ABC | `ReceiverScreen.tsx`, engine `assignDock/controlLine/putaway` |
| Stock | Réapprovisionnement (min/max, calculer la quantité) → Rempotage (palette → emplacement picking) → Approche (palettes complètes à quai) | `ReplenisherScreen.tsx`, engine `replenishOrder/rempotage/approcheSend` |
| Picking | Plan de prélèvement (cliquer l'ordre de passage sur le plan, distance réelle BFS) → Picking (produits ← → commandes) → Contrôle (demandé vs préparé) | `PickerScreen.tsx`, `PlanMap.tsx`, engine `planRoute/pickAssign/pickControl` |
| Expédition | Planification camions (destination, capacité, priorité) → Contrôle palettes → Chargement ordonné (lourd d'abord, fragile en dernier) | `DispatcherScreen.tsx`, engine `assignTruck/palletCheck/loadItem/closeLoading/dispatchTruck` |

The plan de prélèvement distance is the true shortest corridor path between
stops (`shared/grid.ts: bfsDistance/tourDistance`), compared against the
optimal permutation (`optimalTour`) — a suboptimal plan costs real transit
time (Réaliste) or a logged penalty (supervisor modes).

---

## 3. Difficulty modes & the Supervisor

`shared/constants.ts: MODES` — `{ globalTimer, supervisor, durationMs }`.

| Mode | Timer | Errors |
| --- | --- | --- |
| Facile | Per-role timers; only run while that role has a backlog (`engine.updateRoleTimers` + `backlogs()`); session ends when the workload is done | Supervisor intercepts |
| Normal | Global strict 7:00 | Supervisor intercepts |
| Réaliste | Global strict 7:00, unforgiving flow | Cascading consequences |

### The Supervisor choke point (`engine.ts: fault()`)

Every rule violation in every intent handler flows through ONE function:

```ts
fault(key, role, step, original, corrected, onCorrect, onCascade)
```

* always: `charge(key, role, supervised)` — the penalty is logged against the
  offending player (this feeds the per-role Error Cost on the dashboard);
* supervisor modes: push a `SupervisorEvent {role, step, error, original,
  corrected, penalty}` and run `onCorrect()` — downstream receives sanitized
  data;
* Réaliste: run `onCascade()` — the raw mistake mutates the world and, where
  discovery is deferred, plants private state (e.g. `slotPhysical`) that
  later surfaces as an `Anomaly` on the victim's screen.

### Cascades implemented (Réaliste)

* Receiver accepts damaged/wrong/qty-mismatched line → those exact goods
  enter the reserve (`damagedReserve`); damage rides each rempotage pallet
  into picking and into order lines; the picking contrôle and the expedition
  contrôle are the two nets left to catch it — miss both and it ships
  (`shippedDamaged`).
* Receiver stores in the wrong ABC zone → next rempotage of that product
  takes 2× (pallet search) with a `misplaced_pallet` notice.
* Replenisher sends a pallet to the wrong picking slot → `slotPhysical` map;
  the Picker discovers it at pick time → `slot_mismatch` anomaly with a
  resolution action for the Replenisher (`resolveAnomaly` swaps it back).
* Replenisher ignores a below-min slot (>30 s with a pallet available) →
  the Picker hits a stock-out → `stockout` anomaly with three picker
  decisions: réappro d'urgence / expédier partiel / reporter la commande.
* Picker validates a bad line at contrôle → defect travels to expedition.
* Dispatcher approves a defective pallet / loads fragile under heavy /
  mismatches destination → costs land at truck departure.

---

## 4. Educational feedback loop (`server/src/kpi.ts`)

* **OTIF** — complete, undamaged, right destination (+ on time in global
  modes) / all orders.
* **Dock utilization** — busy %, average & max yard wait, trucks served.
* **Error cost** — the `costLog` ledger grouped by root cause AND by role;
  every event carries `supervised: boolean`.
* **Supervisor register** — the full intervention table (what was done /
  what was corrected) is its own dashboard section: it is the Easy/Normal
  debrief artifact.
* **Team heatmap** — per-tick 0–1 pressure per stage averaged into 15 s
  buckets; bottleneck = highest pressure ≥ 0.4; rendered as the grid in
  `Dashboard.tsx`.
* **Coaching insights** — sustained bottleneck runs, biggest supervisor
  consumer, most expensive habit, worst-billed role, OTIF headline.

## Repository layout

```
shared/          types.ts (wire model), constants.ts (modes, costs, catalogue,
                 grid), grid.ts (BFS distances, optimal tour)
server/src/      index.ts (sockets/rooms), engine.ts (simulation + Supervisor +
                 cascades), scenario.ts (seeded workload), kpi.ts, rng.ts
server/test/     sim.ts — 4 headless full-session scenarios (honest realistic,
                 sloppy receiver under supervisor, wrong-slot cascade, easy
                 mode timers/early end)
client/src/      useGame.ts, useSessionTimer.ts (global vs per-role timers),
                 screens/ (Lobby, 4 role screens, Dashboard), components/
                 (StepTabs, PlanMap, AnomalyPanel, Hud, Toasts)
```
