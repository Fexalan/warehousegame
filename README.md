# 🏭 The Ripple Effect

A real-time, multiplayer warehouse training simulator. 7-minute sessions,
up to 5 teams of 4, each player running one continuous role — **Receiver,
Replenisher, Picker, Dispatcher** — on one shared supply chain. A bottleneck
anywhere ripples everywhere; the post-game dashboard shows exactly where.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install
npm run dev
```

* Client: http://localhost:5173
* Server: ws://localhost:3001

Open 4 browser tabs (or 4 devices on the LAN — the dev server binds to all
interfaces), join the same session code and team, pick the 4 different roles,
then hit **START**. More teams = same session code, different team number;
every team faces the identical seeded scenario, so the leaderboard is fair.

## The roles

| Role | Loop | Skill trained |
| --- | --- | --- |
| Receiver | Dock trucks, swipe pallets (← reject / accept →), assign ABC zones | Inbound triage & quality control |
| Replenisher | Store or cross-dock inbound, keep pick faces above min | Inventory flow, min/max discipline |
| Picker | Pick an order, draw the fastest route, beat deadlines | Routing & prioritization |
| Dispatcher | Load staged orders onto capacity-limited trucks, ship on time | Load planning & deadline management |

## Curveballs

Random mid-session injects: **VIP rush order** (45 s deadline), **forklift
accident** (aisle blocked, live routes cancelled), **ghost pallet** (the WMS
lies about stock — discover, flag, recover).

## Debrief KPIs

OTIF, dock utilization, an itemized error-cost ledger, a per-15-seconds
bottleneck heatmap of the whole team, and plain-language coaching insights.

## Production build

```bash
npm run build    # builds server (tsc) and client (vite)
npm start        # serves the game socket on :3001
```

Serve `client/dist` from any static host and set `VITE_SERVER_URL` at build
time if the socket server lives elsewhere.
