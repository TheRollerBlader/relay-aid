# Toolchain

Recorded from the environment that ran the tests.

| Tool | Version |
|---|---|
| Node.js | 22.23.4 |
| pnpm | 9.15.0 |
| TypeScript | 5.9.x (workspace lockfile) |
| Vitest | 3.2.x |
| Python | 3.12.3, used only for the firmware state-machine tests |

SQLite uses Node’s built-in `node:sqlite` with WAL and `synchronous=FULL` for the station outbox and the authority database.

Spacetime CLI: not installed. No sponsor database was reachable from this environment, so the reducer contracts run in `packages/authority` instead of a live SpacetimeDB module. Generated bindings were not produced.

Nemotron: no API key file was present. The worker client is implemented and stays idle until the three environment names in `.env.example` are set. The deterministic six-tool rehearsal does not pretend to be a live model.
