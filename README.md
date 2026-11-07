# RelayAid

RelayAid is a shelter request desk for two needs: water and charging. A resident confirms a request on the station. The laptop saves it before anything is delivered. A coordinator acknowledges it, reviews a capacity-valid plan, and approves it. A volunteer sees only an attached task.

This is a synthetic exercise. It does not call emergency services, book transport, or infer medical urgency.

## Run it

```bash
pnpm install
pnpm dev
```

Open the station and coordinator at the UI address printed by Vite (port 4318). The API listens on port 4317. Choose **Station**, **Coordinator**, or **Volunteer** in the header. Those buttons are the demo stand-in for separate identities. The server still rejects a station that tries to approve a plan.

```bash
pnpm test
pnpm demo:seed
pnpm firmware:test
```

`pnpm start` builds the UI and serves it with the API from one process.

## What is in the repo

| Path | Role |
|---|---|
| `packages/contracts` | Submit envelope, receipt, serial frames, tool names |
| `packages/domain` | Lifecycle and water/charging capacity rules |
| `packages/solver` | Min-cost matching, FCFS baseline, unmatched reasons |
| `packages/authority` | Reducer transactions: submit, acknowledge, snapshot, approve, complete |
| `packages/station` | SQLite outbox, serial protocol, debounced press model |
| `apps/proposal-worker` | Six bounded tools and the Nemotron client |
| `apps/server` | HTTP API, sessions, sync loop, optional USB serial |
| `apps/web` | Station, queue, resources, proposals, volunteer |
| `firmware/station` | Pico firmware state machine and GPIO entrypoint |
| `fixtures/synthetic-scenario.json` | The coverage example from the blueprint |
| `docs/blueprint` | The build blueprint this implementation follows |

## Authority and model access

The executable backend is a local authority that implements the blueprint’s reducer contracts: idempotent submit, role checks, immutable snapshots, atomic reservation, and water-versus-charging settlement. SpacetimeDB is not connected in this environment, and the Spacetime CLI was not available here. Nemotron runs only when `NEMOTRON_BASE_URL`, `NEMOTRON_MODEL`, and `NEMOTRON_API_KEY_FILE` are set. Otherwise **Try Nemotron tools** reports that the model is unavailable and deterministic planning still works.

Configuration names live in `.env.example`. Do not commit tokens. The data directory (`data/`) holds the SQLite files and is gitignored.

## Hardware

No board was attached here. On-screen Water, Charging, and Confirm call the same local save as a serial `PRESS` frame. `firmware/station/main.py` is the Pico entrypoint. Pin numbers in `docs/wiring.md` are a proposal for an original Pico and are not a tested wiring.

## Limits

Saved, delivered, acknowledged, assigned, and complete are different states. Assignment means the prototype recorded a reservation. It does not mean assistance is on the way. See `docs/verification.md` for what was actually run.
