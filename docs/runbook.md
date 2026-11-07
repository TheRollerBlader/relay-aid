# Runbook

Times below are operational steps, not a claim that a physical expo was rehearsed.

## Start

1. `pnpm install`
2. Confirm `data/` is local disk, not a synced folder. It is created on first start and is gitignored.
3. `pnpm dev`
4. Open the UI. Choose Station, Coordinator, or Volunteer. Each choice is a separate server identity.
5. Optional: set `SERIAL_DEVICE` to a verified board path before starting the server.
6. Optional: set `NEMOTRON_BASE_URL` (https only), `NEMOTRON_MODEL`, and `NEMOTRON_API_KEY_FILE`. The key file stays out of the repo.

## Demo path

1. On the station, pause the uplink, confirm Water, and read “Saved on this station. Not delivered yet.”
2. Reconnect the uplink. The same request becomes “Delivered. Waiting for coordinator acknowledgement.” Retrying does not create a second server request.
3. As coordinator, acknowledge it. That is a different state from delivery.
4. Generate a deterministic plan. The seeded shelter has one step-free charger, one standard charger, and one bottle. The older flexible charging request is sent to the far outlet so the step-free request can also be served. One water request stays unmatched because of capacity.
5. Approve only if the plan is not marked stale. Approval reserves capacity. Rejecting a plan does not.
6. Mark the assignment complete. Water moves from reserved to consumed. Charging releases the slot.
7. If Nemotron is not configured, the Nemotron button says the model is unavailable. Acknowledgement and deterministic planning still work.

## Recovery

| What you see | What to do |
|---|---|
| Uplink paused | Leave the bridge running. Saved requests stay in SQLite. Reconnect and let them sync. |
| Server restarted | Start it again on the same `data/` directory. Committed station ids remain. In-flight sync is retried. |
| Stale plan | Do not approve. Generate another plan and review it. |
| Model unavailable | Use deterministic or one-item plans. |
| Need a clean shelter | `pnpm demo:seed` restores the synthetic shelter. It does not delete the station outbox. |

Reset is not a generic repair. Do not copy a SQLite file while it is being written and call that a backup. The station store has a `backupTo` method that writes a second database from committed rows.

## Tests

`pnpm test` covers the solver scenario, authority races, the station outbox, the tool boundary, and one HTTP loop. `pnpm firmware:test` covers debounce without a board. See `docs/verification.md`.
