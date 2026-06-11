# 🏭 Simulateur Entrepôt

A real-time, multiplayer warehouse training simulator. Up to 5 teams of 4,
each player running one of the four interdependent roles on one shared
supply chain — **Réception, Stock, Picking, Expédition** — each role a
3-step professional workflow (tables, bills of delivery, min/max maths,
pick-path planning, load sequencing). Three difficulty modes change the
clock model and whether mistakes cascade.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install
npm run dev
```

* Client: http://localhost:5173
* Server: ws://localhost:3001

Open 4 browser tabs (or 4 devices on the LAN), join the same session code
and team, pick the 4 different roles, choose a difficulty, hit START. More
teams = same session code, different team number; every team faces the same
seeded scenario.

## Roles & steps

| Rôle | Étapes |
| --- | --- |
| Réception | Planification quai · Contrôle livraison (commande vs livraison) · Mise en stock ABC |
| Stock | Réapprovisionnement (min/max) · Rempotage · Approche |
| Picking | Plan de prélèvement · Picking · Contrôle |
| Expédition | Planification camions · Contrôle palettes · Chargement ordonné |

## Difficulty modes

* **Facile** — per-role timers that only run while you have a backlog; the
  invisible Supervisor corrects upstream errors before they reach you (and
  logs the penalty for the debrief).
* **Normal** — one strict shared 7-minute clock; Supervisor still active.
* **Réaliste** — 7 minutes, continuous flow, no safety net: damaged pallets,
  wrong-slot put-aways and ignored min/max alerts cascade to your teammates
  as anomalies they must handle.

## Debrief

OTIF, dock utilization, itemized error-cost ledger by root cause and by
role, the Supervisor intervention register, a per-15-seconds bottleneck
heatmap of the whole team, and coaching insights.

## Tests & production

```bash
npx tsx server/test/sim.ts   # 4 headless full-session scenarios
npm run build                # tsc (server) + vite build (client)
npm start                    # socket server on :3001
```

Serve `client/dist` from any static host; set `VITE_SERVER_URL` at build
time if the socket server lives elsewhere.
