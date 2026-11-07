# Verification

These notes describe commands that were run in this workspace. They are not a hardware trial, a SpacetimeDB deployment, or a live Nemotron trace.

| Check | Result |
|---|---|
| Synthetic scenario (`fixtures/synthetic-scenario.json`) | Optimized matches r1→charging-b, r2→charging-a, r3→water-a. r4 is `CAPACITY_COMPETITION`. FCFS matches 2. |
| Permuted inputs | Same assignments and reasons. |
| Missing travel | `INPUT_INCOMPLETE`. No invented distance. |
| Brute-force objective on the fixture | Agrees with the solver. |
| 100 requests and 30 pools | Solved in the unit test under the two-second bound. |
| Idempotent submit and conflicting body | One request. Changed category is a conflict. |
| Outsider submit, station acknowledge, worker approve | Denied. No new row for the outsider. |
| Two plans, one water unit | One approval succeeds. The other is `STALE_PLAN`. Reserved units stay 1. |
| Expired snapshot and edited inventory | Approval rejected. No reservation. |
| Water complete, charging complete, cancel | Water is consumed once. Charging is released once. Cancel releases once. A repeat does not move counters again. |
| Station crash-before-commit hook | `NOT_SAVED` and no outbox row. |
| Station process reopen | Same request id. |
| Serial press replay | Same request id. |
| Debounce model | Bounce does not accept. Two deliberate confirms differ. Firmware Python tests agree. |
| Lost receipt | One server request after retry. |
| Newer completion then stale acknowledgement | Cache does not regress. |
| Twenty requests with dropped replies | Accepted ids match delivered ids. |
| Six-tool rehearsal | Stores the solver plan once. Trace has no approve tool. |
| Unknown tool, extra property | Rejected. No proposal. |
| HTTP loop | Offline save, one delivery, human acknowledge, manual approve, complete, water consumed, Nemotron reported unavailable, deterministic trace includes `solveAssignment`. |

Not run, because the bench had no board, no Spacetime sponsor database, and no Nemotron credential:

- T01 physical video, T09 board reset, T10 real disk-full, T34 teammate usability, T36 a second person following the runbook
- Live Spacetime identity isolation on a sponsor instance
- A qualification trace from a real Nemotron model

The acceptance template in `docs/blueprint/09-Execution-Templates.json` is still the planning record. This file is the execution note for the automated checks above.
