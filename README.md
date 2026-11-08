# RelayAid

A shelter desk for water and charging requests. The receipt only moves when the server confirms it.

Screenshots below are the local demo with Spacetime off. Charts and the allocation diagram are the deterministic matcher’s worked examples, not counts from a live shelter.

## The desk

<img src="docs/readme/home.png" alt="RelayAid home: North Hall selected, with Resident, Coordinator, and Volunteer desks" width="880">

This browser keeps one role. A second role needs another browser profile.

<img src="docs/readme/request.png" alt="Resident request screen with quantity 2 and Water or Charging" width="440">
<img src="docs/readme/review.png" alt="Review step: You're asking for 2 water, before send" width="440">

<img src="docs/readme/queue.png" alt="Coordinator queue with status and type filters, waiting to connect" width="440">
<img src="docs/readme/board.png" alt="Assignment board with North Hall and South Hall points and six task columns" width="440">

<img src="docs/readme/plans.png" alt="Coordinator plans: compare first-come and suitability, with policy choices" width="880">

Until `VITE_SPACETIME_URI` is set, the coordinator list stays on “Connecting to the shelter system…” and plans are not generated yet.

## How a request moves

<img src="docs/readme/states.png" alt="3D steps from Saved here through Received, Seen, Assigned, and Delivered to Confirmed" width="880">

A save on the device is not delivery. Seen, assigned, delivered, and confirmed appear only after the shelter system records them. An unacknowledged request stays unmatched and does not take capacity.

## One record for three desks

<img src="docs/readme/architecture.png" alt="3D diagram of Resident, Coordinator, and Volunteer desks connected through an outbox to SpacetimeDB, with a solver and a separate Investigate block" width="880">

Resident, coordinator, and volunteer desks read the same module. The outbox holds a request until it can be sent. The solver writes a plan from requests and resources. Investigate calls NVIDIA from the dev server. That key is not part of the browser bundle. The gray link is that server-side path.

## Matcher results

Same two charging requests. Request 1 can use either slot. Request 2 needs the accessible slot. One accessible slot and one general slot are free.

<img src="docs/readme/allocation.png" alt="3D comparison: first-come puts request 1 on the accessible charger and leaves request 2 unmatched; suitability puts request 2 on the accessible charger and request 1 on the general charger" width="880">

<img src="docs/readme/results.png" alt="Bar charts for accessible charging, water stock of 2, a what-if charger, and longest-wait with a stock of 5" width="880">

| Example | Result |
| --- | --- |
| First-come, two charging requests | 1 matched. Request 2 unmatched: capacity exhausted. Method: heuristic. |
| Suitability, same requests | 2 matched. Accessible slot goes to request 2. Method: exact. |
| First-come, water stock 2, three requests for 1 | Requests 1 and 2 served. Request 3 unmatched: capacity exhausted. |
| Both requests need an accessible slot | 1 matched. After a what-if adds one accessible charger, 2 matched. The original resource list stays 3 items long. |
| Longest wait, stock 5 | The waiting household of 5 is served. Three new requests for 1 are unmatched: capacity exhausted. Waiting adds 1 weight for every 30 minutes. That is a declared rule, not a claim of fairness. |

| Acknowledged requests | Suitability method |
| --- | --- |
| 2 or 12, default step budget | exact |
| 13, 20, or 50, stock enough for all | heuristic, all assigned |
| 2, step budget 1 | fallback, both still assigned |

First-come is always labeled heuristic. Shortage estimates stay unknown below 5 observations. Five observations valued 1, 2, 2, 3, and 4 estimate a range of 1 to 4. That range is not an arrival time.

## Run it

```bash
npm install
cd spacetimedb && npm install && npm run publish:local
cd .. && npm run dev
```

Open http://localhost:5173. Spacetime stays off until `VITE_SPACETIME_URI` is set at deploy time. Investigate uses `NEMOTRON_BASE_URL`, `NEMOTRON_API_KEY`, and `NEMOTRON_MODEL` in `.env`.

- Resident: `/r/request`
- Coordinator: `/c/queue`
- Volunteer: `/v/tasks`

## Checks

On this tree, `npm test` in `spacetimedb` passed 27 tests: 20 node tests and 7 module and access tests.
