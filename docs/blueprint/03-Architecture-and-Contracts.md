# RelayAid — technical architecture and executable contracts

Implementation specification · proposed decisions · 7 November 2026

This specification turns the selected RelayAid concept into an implementable system. It describes work to build and test; no component, availability claim, account, credential, or successful test is implied. The source is the [RelayAid master context](https://docs.google.com/document/d/1fKUCv0I7eWlfuVcMI0PFPU4sRjq058ZQI2jTofv0vWw/edit). ScrabbleBot remains a separate codebase and workstream.

## 1. Architecture decisions and boundaries

**MVP policy:** one shelter, one physical station, two request categories (`WATER`, `CHARGING`), one unit per request, fictional people and resources, one active assignment per request, and explicit coordinator acknowledgement before allocation. No medical priority is inferred. All MVP requests have normal priority. Allocation maximizes served requests, then favors earlier server receipt through the declared waiting-rank objective, then minimizes declared travel estimates. Waiting time begins at server receipt; offline age is displayed separately because a station clock is not trusted.

SpacetimeDB is the sole authoritative shared backend. It stores identity permissions, station registration, requests, lifecycle events, resources, snapshots, proposals, approvals, reservations and audit records. The laptop stores only its station's durable local outbox, local display cache, and sync bookkeeping. A stateless Node worker runs the deterministic solver and bounded Nemotron workflow. It cannot approve a plan, acknowledge people, reserve resources or complete requests. React clients subscribe to authorized views and invoke reducers.

The station is a USB microcontroller with two buttons and physical indicators. Its firmware does not contain a cloud token. The laptop bridge owns persistence. An unplugged or reset MCU cannot accept new requests; accepted requests already committed on the laptop remain recoverable within the tested storage assumptions. Internet loss permits local request capture, not remote coordination or a mesh network.

```text
Buttons / LEDs <--- USB serial ---> Laptop bridge
                                    | SQLite outbox + status cache
                                    | station identity; encrypted transport
                                    v
                        SpacetimeDB module (authority)
                      private tables + reducers + views
                         ^             ^             ^
                         |             |             |
                   Coordinator     Volunteer      Proposal worker
                      React          React        deterministic solver
                                                   + Nemotron API
```

Keep direct external I/O out of reducers. The official function model distinguishes transactional reducers from externally communicating procedures; an external worker makes the approval boundary and model credentials straightforward. SpacetimeDB procedures are therefore unnecessary for this MVP. [Function types](https://spacetimedb.com/docs/functions/)

## 2. Monorepo and dependency direction

Use a TypeScript pnpm workspace with a single lockfile. Pin the installed Node, package manager, Spacetime CLI, server and `spacetimedb` package versions after the first successful compatibility spike. Current official documentation identifies its selected version as 2.0.0; that is a documentation baseline, not proof that a particular sponsor instance supports every feature. Record the actual tested set in `docs/toolchain.md`.

```text
apps/coordinator/       React + Vite; coordinator and volunteer routes
apps/station-bridge/    Node; serial adapter, SQLite, local UI, sync
apps/proposal-worker/   Node; solver adapter, bounded AI tools, trace
spacetimedb/src/        schema, authorization, reducers, scoped views
packages/contracts/    protocol schemas, enum definitions, validators
packages/domain/       pure lifecycle, capacity and eligibility functions
packages/solver/       deterministic matching; baseline; reason codes
packages/db-bindings/  generated Spacetime client bindings; no hand edits
firmware/station/      selected board implementation; serial protocol
fixtures/              synthetic seeds, adversarial cases, scenario metadata
tests/integration/     real local Spacetime + identity isolation + races
docs/                  setup, wiring, architecture, measured test evidence
```

`contracts` contains JSON-compatible external shapes and bounds; generated bindings remain the authority for SDK representations such as `Identity`, `Timestamp` and `bigint`. `domain` contains no network, filesystem, Date.now, random or UI dependencies. The module imports only runtime-compatible pure code; it must not import Node SQLite, serial or model SDK packages. Both solver and reducers use the same eligibility definitions, but reducers independently validate every proposed assignment against current authoritative rows.

Application entry points expose proposed scripts `dev:ui`, `dev:station`, `dev:worker`, `db:generate`, `test:unit`, `test:integration`, `test:e2e` and `demo:seed`. These are scripts to create, not existing commands. Keep firmware outside the TypeScript compiler. Start with the board actually available; do not delay the software contract for a preferred board.

## 3. State model and ownership

Separate transport state from operational state. The station's local outbox has `PENDING`, `DELIVERED`, `CONFLICT` or `RETRYABLE_ERROR`. Its cached server request has `NEW`, `ACKNOWLEDGED`, `ASSIGNED`, `COMPLETED` or `CANCELLED`. An acknowledged request may still be unmatched. A local retry error never erases a previously known server status.

| Transition | Authorized actor | Preconditions | Atomic effects |
|---|---|---|---|
| Submit → NEW | Registered station | Active station; allowed category; valid immutable payload | Request + receipt + first event |
| NEW → ACKNOWLEDGED | Coordinator | Expected request version | Human actor/time + event + epoch increment |
| ACKNOWLEDGED → ASSIGNED | Coordinator through approve-plan | Fresh plan and eligible capacity | Assignment + reservation + request/event + approval |
| ASSIGNED → COMPLETED | Coordinator or assigned volunteer | Expected request and assignment versions | Close assignment; settle capacity; event |
| Any nonterminal → CANCELLED | Coordinator | Expected version; explicit reason | Release active reservation if any; event |

V1 terminal requests cannot reopen. A coordinator may deliberately create a new linked request for additional service; it receives a new ID and does not reverse historical water consumption. No station button acknowledges, cancels or completes a request. Correct mistaken completion through an audited administrative correction process after the MVP, rather than silently changing counters.

Every server change increments the affected row's version. Compare versions within a request; do not rank enum values or device timestamps. The UI may show a later cancellation after assignment. Display the latest confirmed server state plus freshness, not an optimistic final status. “Assigned” means recorded prototype coordination, not a booked ride or a guarantee that assistance is coming.

## 4. Authoritative schema

All following tables are private. Use explicit primary keys, unique keys where stated, and indexed foreign-key fields. Referential integrity beyond supported unique constraints is checked in reducers. Store `shelterId` on operational rows for authorization and indexed views even though MVP has only one shelter. Use strings for UUID identifiers at JSON boundaries; use integer counters and timestamps through generated bindings.

| Entity | Fields and invariants |
|---|---|
| `Principal` | Identity primary key; role ADMIN / COORDINATOR / VOLUNTEER / STATION / WORKER; shelterId; enabled; version. No client-controlled role on ordinary calls. |
| `Station` | stationId PK; principalIdentity unique; installationId unique; shelterId; label; allowed categories; enabled; version. Reinstalling or rotating identity requires admin action. |
| `Request` | requestId PK; stationId index; shelterId index; localSequence; immutable category, units=1 and optional suitability flags; receivedAt; deviceCreatedAt diagnostic only; state; version; activeAssignmentId optional; acknowledgedBy/At optional. Unique source key `stationId:localSequence`. |
| `RequestEvent` | eventId PK; requestId index; version; kind; actorIdentity; serverTime; reasonCode; commandId. One event per request version. Keep ordinary persistent rows, not transient notification-only events. |
| `Resource` | resourceId PK; shelterId index; category; accountingMode CONSUMABLE / REUSABLE; totalCapacity; reservedUnits; consumedUnits; available; suitability flags; version. Counters nonnegative; reserved+consumed≤total; consumed=0 for reusable. |
| `Volunteer` | principalIdentity unique; shelterId index; displayLabel; available; activeAssignmentId optional; version. No person-identifying information in fixtures. |
| `AllocationControl` | shelterId PK; allocationEpoch; policyVersion. Increment epoch on any allocation-relevant request/resource/policy change. Never keep epoch only in module memory. |
| `AllocationSnapshot` | snapshotId PK; shelterId; epoch; policyVersion; createdAt; expiresAt; canonical bounded request/resource payload; row versions. Immutable and server-created. |
| `ProposedPlan` | planId PK; snapshotId; proposerIdentity; normalized allocations and unmatched reasons; solverVersion; objective values; explanation; model/trace reference optional; state PROPOSED / APPROVED / REJECTED; version. Immutable plan body. |
| `Assignment` | assignmentId PK; requestId index; resourceId index; planId; units=1; state ACTIVE / COMPLETED / CANCELLED; optional volunteerIdentity index; version. A request can reference at most one active assignment. |
| `Reservation` | reservationId PK; assignmentId unique; resourceId index; units; state HELD / CONSUMED / RELEASED; version. Never reserve merely because a proposal exists. |
| `CommandReceipt` | receiptKey PK=`callerIdentity:commandId`; callerIdentity index; command type; canonical input; outcome; entityId/version; errorCode; serverTime. Same ID/different input is a conflict. |
| `Approval` / `AuditEvent` | Immutable approved plan, human actor, serverTime, commandId, snapshot epoch, result; audit action/target/reason. No credentials or request prose in logs. |

**Resource interpretation:** WATER capacity is consumable stock; CHARGING capacity is concurrent staffed slots. Approval increases `reservedUnits`. Completing water moves units from reserved to consumed. Completing charging decreases reserved without consumption. Cancelling an active assignment releases its held reservation exactly once. Expiring an unapproved proposal releases nothing. Approved assignments do not auto-expire: automatically reusing a charging slot while someone may still occupy it is unsafe. The coordinator closes or cancels it explicitly.

Resource pools represent independently staffed capacity. The bipartite solver does not schedule a person across overlapping pools. Volunteer attachment is a separate optional coordinator action after assignment approval, enforcing one active assignment per volunteer; it does not create extra resource capacity. This is an explicit scope boundary, not hidden route scheduling.

## 5. Authentication, views and reducer authorization

During initialization, store the publishing owner's identity as the bootstrap administrator. Official lifecycle documentation provides the owner identity at initialization. Only that administrator may create, disable or rotate role/station mappings. Never implement “first connected client becomes admin.” [Lifecycle reducers](https://spacetimedb.com/docs/functions/reducers/lifecycle/)

For the synthetic demo, manually register distinct generated identities and protect their bearer tokens. An identity without a `Principal` row has no product permissions. Generated development identities have limited recovery/token lifecycle; a future deployment should use an OIDC provider and reviewed session handling. Do not invent passwords in module tables. [Identity guidance](https://spacetimedb.com/docs/intro/faq/)

Each reducer first obtains actor identity from `ctx.sender`, loads the principal, checks enabled status, shelter scope and capability, then loads its target. Never trust `actorId`, `role`, `shelterId` or station ownership supplied by clients. A worker cannot call coordinator reducers even if it has a valid connection. Revocation applies to future operations and view access; it cannot retract data already seen by a previously authorized client.

Expose identity-aware views: `myStationRequests`, `myReceipts`, `coordinatorRequests`, `coordinatorResources`, `coordinatorPlans`, `myVolunteerAssignments` and `workerSnapshots`. Return only needed columns. A station sees its own statuses; a volunteer sees only attached tasks; an outsider receives no operational rows. Each view verifies current `Principal` and uses indexes such as stationId, shelterId, callerIdentity or volunteerIdentity.

Spacetime views support server-side identity filtering, indexed access and subscriptions. Avoid full scans in view functions; the documented imperative API uses indexed lookups rather than `.iter()`. Prefer no-argument identity-scoped views here, avoiding parameterized-view client-query limitations. Public view declarations do not require making their underlying tables public. [Views](https://spacetimedb.com/docs/functions/views/), [Table permissions](https://spacetimedb.com/docs/tables/access-permissions/)

Do not rely on a client `WHERE stationId=...` clause for security. The official RLS feature is experimental and recommends views; this design uses views instead. [RLS status](https://spacetimedb.com/docs/how-to/rls/)

Reducers to implement: `submitRequest`, `acknowledgeRequest`, `cancelRequest`, `createAllocationSnapshot`, `createProposedPlan`, `approvePlan`, `rejectPlan`, `attachVolunteer`, `completeAssignment`, `updateResource`, and admin registration/revocation. Apply authorization to every exported entry point, including seeds and diagnostic reducers. Keep demo reset limited to a separate development database or guarded admin-only operation.

For the demonstrated suitability case, add `setRequestRequirements` for a coordinator to confirm an explicit capability need. Require the current request version, a nonterminal unassigned request, a bounded requirement enum and a recorded reason; increment request version and allocationEpoch. The station submit schema stays small. A fresh installation that resets its durable sequence receives a new registered stationId; never reuse an old stationId with a reset sequence. Preserve the old station and request history, and register its replacement separately.

## 6. Local persistence and USB acceptance protocol

SQLite is an application-owned file on the laptop's local filesystem, not a browser cache, cloud-synced folder or network mount. Use WAL mode, `synchronous=FULL`, foreign keys and bounded busy timeout. FULL in WAL mode adds synchronization for transaction durability; the actual guarantee still depends on filesystem/storage behavior. Test process restart and actual declared power cases separately. [SQLite synchronization](https://www.sqlite.org/pragma.html#pragma_synchronous), [WAL](https://www.sqlite.org/wal.html)

Minimum local tables: `installation`, `mcu_session`, `press_inbox`, `outbox`, and `request_cache`. `press_inbox` has unique `(sessionId, pressSeq)` and maps to one requestId. `outbox` has unique requestId and localSequence, immutable serialized payload, transport state, attempt count, retryAt and lastError. `request_cache` has requestId, serverVersion, serverState and observedAt. Persist token material separately in an OS-protected store or permission-restricted runtime secret file; never put it in the project directory or export bundle.

Use bounded newline-delimited JSON serial messages. Proposed limits: 256 bytes/frame, one pending press per MCU, 50ms debounce, and button release before a new deliberate request. The bridge assigns a random sessionId after saving it; MCU keeps that session and monotonically increasing pressSeq in volatile memory. On serial reconnect the MCU reports its existing session and repeats its unacknowledged frame. If the MCU actually rebooted, negotiate a new session. The bridge restarting must recognize a retained session from SQLite, not blindly assign a new one and duplicate the last press.

```json
{"v":1,"type":"PRESS","sessionId":"session-uuid","pressSeq":17,"need":"WATER"}
{"v":1,"type":"SAVED","pressSeq":17,"requestId":"request-uuid"}
{"v":1,"type":"STATUS","requestId":"request-uuid","version":"3","state":"ASSIGNED"}
```

These are application protocol examples, not vendor APIs. On a new PRESS: validate → begin SQLite transaction → insert press mapping, increment installation sequence, generate requestId once, insert outbox → commit → send SAVED → display “Saved here — not delivered.” On duplicate PRESS, return the existing requestId. A write error produces `NOT_SAVED`; no success indicator. If the process crashes after commit but before SAVED, retransmission finds the existing mapping. If the MCU loses power before receiving SAVED, acceptance may be unknown to the resident; do not promise capture of an uncommitted button event.

The latest selected request drives hardware status, with its short reference shown on the laptop station display. Show pending counts separately; a single green LED must not imply every queued request is complete. Attach text/icons and light patterns to distinguish saved, delivered, acknowledged and complete. The MCU displays only bridge-confirmed states and declares itself disconnected on heartbeat timeout.

## 7. Idempotent submit contract and receipts

Proposed wire shape (UUID strings and decimal counter strings avoid JSON bigint ambiguity):

```typescript
type SubmitRequestV1 = {
  schemaVersion: 1;
  commandId: string;       // persisted; reused for every retry
  requestId: string;       // persisted once per logical request
  localSequence: string;
  needType: 'WATER' | 'CHARGING';
  units: 1;
  deviceCreatedAt: string; // diagnostic, not ordering authority
};
type ReceiptV1 = {
  commandId: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  requestId?: string;
  requestVersion?: string;
  errorCode?: string;
};
```

Do not accept stationId as an authority claim: derive it from the caller mapping. Reject unknown schema versions, unknown fields, malformed IDs, excessive string lengths and unsupported categories. Compare the immutable normalized payload field-by-field or use a deterministic canonical representation; a hash supplied by the client is not proof of equality. Same requestId from another station must not reveal that request.

```text
submitRequest(ctx, input):                    # one reducer transaction
  station = requireEnabledStation(ctx.sender)
  normalized = validateAndNormalize(input)
  prior = receiptFor(ctx.sender, input.commandId)
  if prior exists:
    require prior.canonicalInput == normalized
    return                                   # receipt already observable
  existing = requestById(input.requestId)
  if existing exists:
    require existing.stationId == station.id
    require immutableFields(existing) == normalizedRequestFields
    insertAcceptedReceipt(existing)
    return
  require no conflicting station+localSequence mapping
  insert Request(state=NEW, version=1, receivedAt=ctx.timestamp)
  insert RequestEvent(kind=CREATED, version=1)
  insertAcceptedReceipt(newRequest)
```

Every UI command also carries a persisted commandId. For example, approval retry uses the same ID even if its original result was lost. Authorized business rejection may commit a REJECTED receipt without modifying domain rows; unexpected exceptions roll back everything. Authorization failures expose a generic error and no private target details. Reusing a commandId with altered content is an explicit conflict, not an overwrite.

The bridge removes nothing merely because a socket write or RPC invocation succeeded. Enable confirmed reads and mark DELIVERED only after observing its accepted receipt through the authorized subscription, then persist that observation locally. The documented SDK can distinguish durability-confirmed results from in-memory commits; the database replication setting determines the persistence scope. [TypeScript SDK](https://spacetimedb.com/docs/clients/typescript/)

## 8. Snapshot, proposal, approval and atomic reservations

The worker requests an immutable snapshot through `createAllocationSnapshot`. Within one reducer, authorize WORKER/COORDINATOR, copy at most 100 eligible requests and 30 resource pools with at most 100 free units in the selected scope, read allocationEpoch and policyVersion, and set a ten-minute server-time expiry. Return a receipt referencing snapshotId. The worker reads the snapshot view. A bounded single snapshot avoids combining separate client caches into a supposedly coherent solver input. An oversized resource scope is rejected with BATCH_LIMIT and requires a deliberate coordinator scope reduction; it is never silently truncated.

When more than 100 eligible requests exist, select the oldest 100 by `(receivedAt, requestId)` and store the omitted count. The UI must state that the proposal covers a bounded batch, not the entire queue. A resource update, acknowledgement, cancellation, assignment completion or approval increments allocationEpoch; a mere repeated submit receipt does not. New NEW requests need not invalidate a proposal until acknowledged, because they are ineligible. Policy/resource availability changes do invalidate it.

Add `ProposalRun(runId, shelterId, requestedBy, snapshotId, mode, status, workerIdentity, leaseExpiresAt, resultPlanId, errorCode)` as private authoritative run metadata. A coordinator starts a run through an authorized reducer that binds the snapshot and selected mode. The worker subscribes to permitted pending runs and claims one atomically with a bounded lease. It receives no coordinator token. Retrying a run uses its stable runId; idempotent proposal creation prevents duplicate candidates after an ambiguous response. A lease timeout marks the run interrupted and permits explicit retry without granting approval. For the single-worker MVP, do not expose a separate unauthenticated HTTP trigger. Snapshot creation and run creation may share one reducer transaction; all run IDs are bound to the same shelter.

The manual path creates a one-item proposal against a fresh snapshot and calls the same approval reducer. Implement this minimal reservation path before claiming the basic acknowledgement-to-completion loop works. Bulk optimized proposals extend the path; they do not introduce a second, less-validated assignment endpoint.

`createProposedPlan` validates bounds, referenced snapshot, supported solver version, unique request assignments, integer units, known reason codes, and plan ID idempotency. The body is immutable. It may validate snapshot feasibility early, but it does not reserve capacity. AI narrative is optional, bounded text and cannot change assignment fields. Human approval receives only planId, expected planVersion, commandId and explicit acknowledgement of the reviewed plan.

```text
approvePlan(ctx, input):                      # one reducer transaction
  actor = requireCoordinator(ctx.sender)
  if matchingReceiptExists(actor, input): return
  plan = requirePlanInShelter(input.planId, actor.shelterId)
  require plan.version == input.expectedPlanVersion
  require plan.state == PROPOSED
  snapshot = loadSnapshot(plan.snapshotId)
  require ctx.timestamp <= snapshot.expiresAt
  control = loadAllocationControl(actor.shelterId)
  require control.epoch == snapshot.epoch
  require control.policyVersion == snapshot.policyVersion
  validateEveryAllocationAgainstCurrentRows(plan)
    # ACKNOWLEDGED; unassigned; expected versions; correct category;
    # suitability known; resource available; one unit; unique request
  aggregate all proposed units by resourceId
  require each sum <= totalCapacity - consumedUnits - reservedUnits
  for each allocation in stable ID order:
    insert Assignment(ACTIVE) and Reservation(HELD)
    increment resource.reservedUnits and resource.version
    set request ASSIGNED; set activeAssignmentId; increment version
    insert RequestEvent
  set plan APPROVED; increment plan.version
  increment control.epoch
  insert Approval, AuditEvent and accepted CommandReceipt
```

Freshness checks, per-resource aggregation and writes belong to this same reducer. Two approval calls contend through authoritative resource/control rows; neither trusts a UI's displayed free count. A failure must leave no partial reservations. Spacetime reducers provide atomic transactions; do not catch an internal validation error after mutations and then let the reducer return successfully. Nested function/reducer calls do not create independent rollback boundaries. [Transactional scope](https://spacetimedb.com/docs/databases/transactions-atomicity/), [Architecture](https://spacetimedb.com/docs/intro/key-architecture/)

Successful `completeAssignment` similarly closes assignment/reservation, updates request, settles resource counters, frees any attached volunteer, increments epoch and emits receipt/events in one reducer. A duplicate completion returns its prior receipt without decrementing capacity twice. Reducing totalCapacity below reserved+consumed is rejected; disabling a resource prevents new assignments without silently erasing active ones.

## 9. Reconnect, error handling and observability

The client cache is a replica, not offline authority. After connection loss, display stale/offline state and disable approval. On reconnect, wait for subscription `onApplied`, reconcile receipts and highest versions into SQLite, then retry remaining outbox IDs. SDK calls that lose connection may have an unknown outcome; idempotency resolves that uncertainty. Automatic reconnect is opt-in, and initial connection failure needs an application retry path. Confirm these behaviors against the pinned SDK. [Connection lifecycle](https://spacetimedb.com/docs/clients/typescript/)

Proposed application retry: one request in flight per station, exponential backoff starting at one second, cap 30 seconds, randomized jitter, unlimited retention until success/operator resolution. A retryable network failure never creates a new requestId. Recover IN_FLIGHT bookkeeping as pending on startup. Repeated authentication rejection pauses cloud sync and raises a local operator action; local capture may continue while storage remains healthy and must clearly state delivery is blocked.

| Error class | Required behavior |
|---|---|
| NETWORK_UNAVAILABLE / UNKNOWN_RESULT | Preserve payload and IDs; reconcile/retry |
| AUTH_REQUIRED / STATION_DISABLED | Pause sync; explicit operator recovery; never silently impersonate a new identity |
| INVALID_SCHEMA / UNSUPPORTED_CATEGORY | Quarantine local row; show actionable error |
| IDEMPOTENCY_CONFLICT | Stop that row; retain both diagnostic representations privately; manual review |
| STALE_PLAN / EXPIRED_PLAN | Reject approval; refresh snapshot and create a new proposal |
| CAPACITY_EXCEEDED / INVALID_TRANSITION | No state mutation; refresh current authoritative state |
| LOCAL_STORAGE_FAILED / STORAGE_FULL | Reject new acceptance; retain existing rows; display NOT SAVED |

Record structured metrics: requestId, commandId, operation, local monotonic duration, retry count, server version, planId, epoch and sanitized error code. Do not log bearer tokens, raw model credentials or arbitrary request prose. Measure local save, delivery and human acknowledgement separately. Status cache retention, outbox cleanup and audit export are explicit admin tasks after the demo; never truncate undelivered entries to hide failure.

## 10. Deployment sequence and implementation gates

1. Create the module and minimal identity-scoped request/receipt views. Run a real local integration spike: registered station succeeds, outsider cannot read, confirmed receipt observed, reconnect recovers. If the chosen server lacks required view or durability behavior, resolve the version/configuration before building the UI around it.
2. Implement domain validators and private schema, generate client bindings using the official CLI, then compile every client. Generated binding changes must be committed with matching schema changes. [CLI reference](https://spacetimedb.com/docs/cli-reference/)
3. Implement SQLite acceptance and serial replay before cloud sync. Prove process restart with accepted IDs preserved. Attach firmware once the host contract works.
4. Implement submit/acknowledge/cancel and station status subscriptions. Pass independent-identity access checks and duplicate/conflicting-payload cases.
5. Implement server snapshots, deterministic proposals, atomic approval, resource settlement and two-client race tests. Add the worker's model orchestration only after deterministic operation works end to end.
6. Deploy one named demo database, static UI and one worker. The bridge stays on its station laptop. Only nonsecret endpoint/database names enter browser build variables. The worker gets only WORKER identity plus its inference key; the UI never receives the inference key or owner token.
7. Seed synthetic data under admin identity; record deployed commit, schema/SDK versions, seed ID and service URLs. Run the complete acceptance matrix against the deployed environment. Freeze a known-good demo state and preserve the recorded demonstration as fallback.

Use separate development and demonstration databases. Avoid destructive publish/clear operations against the demonstration database. Preserve SQLite together with its WAL via a proper SQLite backup/checkpoint process; copying just the main file during writes is not a dependable backup. A rollback must match schema and generated bindings, not merely redeploy an old UI. For the hackathon, prefer additive schema changes and restore a synthetic scenario into a separate instance when a migration cannot safely be reversed.

Implementation is complete only when the actual physical request survives the declared local restart, reaches exactly one authoritative request despite retries, receives a human acknowledgement, passes a fresh capacity-valid approval, and reflects completion back at the station. Security, concurrency and outage evidence must come from executed tests; this architecture is the testable design for producing that evidence.
