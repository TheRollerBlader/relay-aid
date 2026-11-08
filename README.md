# RelayAid

A shelter desk for water and charging requests. The receipt only moves when the server confirms it.

```bash
npm install
cd spacetimedb && npm install && npm run publish:local
cd .. && npm run dev
```

Open http://localhost:5173. This browser can claim one role. Use another browser profile for a second role.

Spacetime stays off until `VITE_SPACETIME_URI` is set at deploy time. Investigate calls NVIDIA from the dev server using `NEMOTRON_BASE_URL`, `NEMOTRON_API_KEY`, and `NEMOTRON_MODEL` in `.env`. That key is not part of the browser bundle.

- Resident: `/r/request`
- Coordinator: `/c/queue`
- Volunteer: `/v/tasks`
