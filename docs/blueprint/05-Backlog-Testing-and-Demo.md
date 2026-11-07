# RelayAid: build backlog, verification, and demo operations

Version 1.0 · 7 November 2026 · All event times America/Chicago (CST, UTC−6)

This is an execution plan, not a record of completed work. Estimates are focused person-hours; acceptance criteria are requirements to prove. Use the architecture and allocation specifications alongside this document. Build one working path first: physical input → durable local record → server delivery → human acknowledgement → validated assignment → completion → physical status update.

## 1. Delivery method and responsibilities

Use a small-batch, contract-first workflow. Freeze the request envelope and lifecycle before parallel implementation; then merge a vertical slice every 60–90 minutes. Keep unfinished optional features behind flags. One owner implements each module and a different teammate reviews its trust boundary. Commit short, named changes; attach the relevant acceptance-test result to each integration change. No long-lived UI/backend branches and no final-hour merge of the entire system.

Roles preserve the existing source plan:

| Role | Primary responsibility | Availability and backup |
|---|---|---|
| A — Krish | Separate ScrabbleBot, then RelayAid testing, documentation, recording | Primarily on the bot until its tournament ends. B learns restart instructions in one bounded handoff. Do not count A as an afternoon RelayAid implementer. |
| B | Authoritative Spacetime state, access control, allocation, atomic approvals | Owns contracts with C and D. D can rerun seeded backend smoke checks; A joins verification afterward. |
| C | Physical station, USB bridge, SQLite outbox, status UI and coordinator UI | Hardware is the early bottleneck. D can implement simple coordinator presentation against fixed fixtures while C proves physical input. |
| D | Nemotron worker, integration evidence, release coordination and submissions | Protects submission windows; pauses AI work when a core integration gate fails. Owns the unresolved-requirements ledger. |

Hold ten-minute integration reviews after gates G1, G2, and G3. Each owner shows the actual flow and one failure, names the current commit, and identifies the next dependency. Preserve meals and sleep; stagger recovery so one person can watch the demonstration environment. A second developer reviews any change to permissions, deduplication, or resource reservations.

## 2. Gates, time budget, and cut rules

Let T0 be the actual kickoff after access and hardware checks. Relative targets below are planning estimates, not an extension of the event deadline. The source plan's Saturday 5 PM and 8 PM milestones are aspirations; if already elapsed, record their actual state and rebaseline. Record remaining minutes to the Sunday noon cutoff at each gate.

| Gate | Target from T0 | Required evidence | If it misses |
|---|---:|---|---|
| G0: feasible foundation | 30–45 min | Exact board identified; backend access; model access classified; contract agreed; role identities provisioned | Choose the documented laptop+USB station. Stop optional integration work. |
| G1: physical persistence | 90 min | One button request commits locally; offline indicator is truthful; process restart recovers it | C and B pair on this. Use fixtures only for independent UI development. |
| G2: complete basic loop | 3 h | Retry gives one server request; human acknowledgement and completion return to station; two-client permissions pass | D suspends AI integration to help core UI/test work. |
| G3: constrained allocation | 5 h | Deterministic plan, unmatched reasons, atomic approval and race rejection | Keep manual coordinator workflow; remove unsupported optimizer claims. |
| G4: bounded AI proof | 6.5 h | Real Nemotron trace invokes allowed tools; model failure leaves core usable | Ship deterministic mode. Do not claim NVIDIA qualification without actual evidence. |
| G5: release candidate | At least 3 h before cutoff | Critical tests complete, setup repeatable, demo reset reliable, limitations recorded | Freeze features. Spend remaining time on failures, recording and submission. |

The task estimates below total several dozen person-hours across parallel lanes. They include required robustness work and should not be interpreted as one person's schedule. Reserve at least 25% of the available RelayAid capacity for integration and defect correction; estimate again after G1. Optional features consume only time left after that reserve. At T0, select one available person to relieve C's combined hardware/UI load; D's presentation-only assistance must not delay its gate responsibilities.

Timing to protect: official team registration by Saturday 11 PM; team goal of initial main submission before that time; shared preparation 9:45–10 PM; Scrabble check-in 10:15–10:45 PM, with arrival by 10:30 PM; source tournament window 10:45–11:45 PM conflicts with an 11 PM sponsor statement. Final code freeze target Sunday 10:30 AM; final submission target 11–11:15 AM; **official hard stop Sunday 8 November at noon CST, with code pushed before that deadline**. Expo setup 12:30 PM and full expo 1–4 PM are source-plan times. D must verify live announcements and current form behavior; this document does not alter calendar events. Keep the existing Space Debates overlap visible rather than silently moving it. The official registration/cutoff rules were directly verified in the browser on 7 November; other holds remain attributed to the existing plan. [S1, S2]

Cut in this order: Photon and other optional sponsors; multilingual generation; extra stations; maps and travel visualization; historical replay UI; sophisticated optimization refinements; AI explanation polish. Preserve physical input, truthful status, durable queue, idempotency, server permissions, acknowledgement, visible unmatched work, and safe manual coordination. If no physical hardware is obtainable, describe the result as a software prototype and reassess the Hardware entry.

## 3. Concrete backlog

Estimates include implementation and the owner's local check, not team-wide integration. A task is done only when its acceptance evidence is attached to the commit or release folder. Dependencies use IDs below; parallel tasks may start against agreed fixtures but cannot be marked integrated until their dependencies pass.

| ID | Task and concrete output | Owner | Depends on | Hours | Done criterion |
|---|---|---|---|---:|---|
| B01 | Inventory board, buttons, resistors, data cable, power and serial driver | C | — | 0.3 | Exact part list, pinout link and powered wiring check recorded. |
| B02 | Confirm Spacetime environment, runtime versions and access | B | — | 0.4 | Minimal isolated module is reachable with separate test identities. |
| B03 | Confirm Nemotron endpoint, supported model and quota | D | — | 0.3 | Real access classified available/unavailable; no key copied into evidence. |
| B04 | Agree v1 envelopes, errors, state transitions and identifier ownership | B/C/D | — | 0.4 | Shared schema and examples accepted by all three implementers. |
| B05 | Create monorepo, lockfiles, scripts and example configuration | B | B04 | 0.4 | Clean install, typecheck and fixture command work; secrets ignored. |
| B06 | Implement firmware debounce, selection and serial event acknowledgement | C | B01,B04 | 0.8 | Bounce cannot produce multiple accepted logical requests. |
| B07 | Implement SQLite schema, migrations and atomic outbox writes | C | B04,B05 | 1.0 | Commit precedes accepted indicator; failed writes show failure. |
| B08 | Implement serial parsing and durable event-to-request mapping | C | B06,B07 | 0.8 | Replayed device event maps to the existing request after service restart. |
| B09 | Implement station status display and exact LED meanings | C | B08 | 0.5 | Saved, delivered, acknowledged and complete are distinguishable without color alone. |
| B10 | Implement authoritative request/event tables and submit reducer | B | B02,B04 | 0.8 | Same ID/body is idempotent; conflicting body is rejected. |
| B11 | Enforce identity roles and station ownership server-side | B | B10 | 0.8 | Station cannot read another station or perform coordinator actions. |
| B12 | Implement retry, backoff and receipt persistence | C | B07,B10,B11 | 0.8 | Lost receipt and reconnect do not create duplicate effects. |
| B13 | Implement lifecycle reducers, one-item manual proposal/approval with atomic reservation, and version reconciliation | B | B10,B11 | 1.3 | Invalid transitions rejected; one-item assignment/settlement validated; stale updates cannot regress terminal state. |
| B14 | Build queue/detail UI, acknowledgement and unresolved filters | C; D assists | B04,B13 | 1.0 | Pending/unacknowledged/unmatched states remain independently visible. |
| B15 | Wire status subscriptions back through bridge to physical indicators | C | B09,B12,B13 | 0.6 | Explicit coordinator action changes correct station request status. |
| B16 | Run G2 physical/offline/restart end-to-end demonstration | B/C/D | B14,B15 | 0.5 | Save→retry→single request→ack→manual assignment→complete video and IDs captured. |
| B17 | Seed synthetic requests, resources, volunteers and role identities | B | B11 | 0.4 | Repeatable isolated scenario, including scarce and incompatible resources. |
| B18 | Implement deterministic eligibility graph and baseline | B | B17 | 0.7 | Hard constraints tested; FCFS baseline operates on same inputs. |
| B19 | Implement bounded allocation and unmatched reason taxonomy | B | B18 | 0.8 | Fixed snapshot gives repeatable feasible assignments and reasons. |
| B20 | Extend the existing manual proposal/approval path to immutable snapshots, bounded bulk plans and worker runs | B | B13,B19 | 1.2 | Two simultaneous approvals cannot overbook last resource; manual and optimized paths share validation. |
| B21 | Build comparison/approval UI with stale-plan handling | C; D assists | B14,B20 | 0.8 | Human sees capacity, reasons, age and exact changes before approval. |
| B22 | Implement volunteer assigned-task view and completion permission | C/B | B11,B20 | 0.6 | Assigned volunteer sees only permitted task fields and actions. |
| B23 | Build bounded read/solve/compare/propose tool handlers | D | B04,B19,B20 | 0.8 | Schemas, size limits and caller authorization enforced. |
| B24 | Implement real Nemotron loop and sanitized trace | D | B03,B23 | 1.0 | Actual model/tool sequence recorded with no approve/dispatch tool. |
| B25 | Implement timeout, malformed-output and quota fallback | D | B24 | 0.5 | Deterministic workflow remains available during every model failure. |
| B26 | Verify injection resistance and explanation grounding | D/B | B25 | 0.5 | Untrusted content cannot change tools, permissions or resource facts. |
| B27 | Deploy isolated demo backend and static UI; document endpoints | B/D | B16,B20 | 0.6 | Fresh browser connects, authorized access works, restart steps documented. |
| B28 | Test storage, transport and board-reset fault matrix | A/C after bot; C earlier | B16 | 1.0 | Tests T01–T12 have measured outcomes and retained evidence. |
| B29 | Test permissions, plan races and allocation invariants | A/B after bot; B earlier | B20,B22 | 0.8 | Critical negative tests pass or release is blocked. |
| B30 | Conduct keyboard, labels, focus and physical usability review | A/C | B21,B22 | 0.6 | Tested controls usable without color/mouse; issues logged honestly. |
| B31 | Run repeatable performance and baseline experiment | A/B | B19,B28 | 0.5 | Sample size, raw timings, fixtures and implementation version recorded. |
| B32 | Verify clean-machine setup and recovery instructions | A/D | B27 | 0.6 | A teammate follows instructions without undocumented owner steps. |
| B33 | Review secrets, dependency licenses, attribution and public content | A/D | B24,B32 | 0.5 | Public artifacts contain synthetic data and no credentials. |
| B34 | Capture 90-second demo plus honest offline fallback | A/C/D | B28–B33 | 0.8 | Playable video shows actual hardware and human approval. |
| B35 | Resolve sponsor ledger and all-team submission requirements | D | B03,B24 | 0.5 | Each selected entry maps to real evidence; cap treatment confirmed. |
| B36 | Freeze tested commit and verify actual submission | D, all sign off | B33–B35 | 0.5 | Public links open; final Submitted status and commit recorded. |
| B37 | Prepare expo kit, reset seed and handoff cards | C/A | B34,B36 | 0.4 | Spare cable, power, offline video and recovery instructions available. |
| B38 | Return borrowed hardware and record unresolved follow-up | C/D | Expo | 0.3 | Accessories checked and return acknowledged by loan desk. |

Do not allocate A to B28–B34 before the bot commitment ends; earlier critical checks remain with B/C/D. The estimates are a prioritization aid, not a claim every task fits if access fails or kickoff is late. Keep one release candidate healthy while new features run in development.

## 4. Integration contracts and definition of done

Every cross-module message includes schema version and stable correlation IDs. Firmware delivers a physical event identity; the bridge durably maps it to one logical request. Server delivery is established by committed authoritative state or an application receipt, not by a successful socket write. Device time is informational; server versions determine status order. A local save acknowledgement has no implication that a coordinator has seen the request.

The UI consumes current server state and displays connection freshness. Its optimistic state cannot grant permissions, reserve capacity, or mark acknowledgement before a successful authoritative write. On denied or stale writes, keep the previous confirmed state and show a recoverable error. The worker reads a consistent, versioned input snapshot and returns proposed allocations. Only a human-authorized reducer may validate and commit the allocation against current state.

Pin the v1 semantics across all tests: server lifecycle is NEW → ACKNOWLEDGED → ASSIGNED → COMPLETED; a coordinator may cancel any nonterminal request. Terminal requests are not reopened in v1; an explicit follow-up has a new linked ID. Local transport states PENDING, DELIVERED, CONFLICT and RETRYABLE_ERROR remain separate. Observe a confirmed receipt row before DELIVERED, using the selected SDK's confirmed-read option. MCU events use a bridge-issued sessionId plus pressSeq; SQLite stores the durable mapping. Allocation is limited to WATER and CHARGING, unit demand one, NORMAL priority, at most 100 requests, 30 resource pools and 100 total slots. Snapshot approval checks allocationEpoch, row versions and a ten-minute server TTL. Water completion transfers reserved stock to consumed stock; charging completion releases reusable capacity. Cancellation releases reservations exactly once.

Definition of done for each slice: types/schema pass; relevant normal and negative tests pass; no secret or real-person data in fixtures/logs; operator-facing failure message exists; restart behavior documented; integration demo captured; owner and reviewer identified. A green CI build alone does not establish physical durability, accessibility, or third-party integration qualification.

## 5. Acceptance matrix

Initialize every result as **NOT RUN**. Use a disposable demo namespace and synthetic seed. For every case save test ID, build commit, environment/board identity, exact steps, observed result, pass/fail, and sanitized evidence path. The expected results below are targets, never prefilled outcomes. Run destructive storage/power experiments only on the test copy, with no unrelated user data.

| Test | Execute | Expected result and evidence |
|---|---|---|
| T01 Online path | Press confirm once; acknowledge, approve a valid one-item assignment, and complete using authorized UI | One request; distinct local-save, delivered, acknowledged, assigned and completed meanings. Video plus request/event IDs. |
| T02 Offline save | Disconnect uplink; create three requests | Three durable local records; explicitly not delivered. Local rows and station video. |
| T03 Service restart | Stop bridge after save; restart while offline | Same IDs recovered; no new request identity. Before/after rows. |
| T04 Crash before commit | Inject failure before SQLite transaction commits | No accepted/saved indication; no phantom durable record. Fault log and display. |
| T05 Crash after commit | Kill service after commit before device acceptance reply | Retry resolves same event/request; one accepted request. Mapping and row count. |
| T06 Lost server receipt | Drop response after server transaction; retry | One server request and creation effect; replayed receipt/status. Server audit. |
| T07 Conflicting retry | Resend existing request ID with changed category | Conflict; original unchanged; visible review condition. Rejection code and record. |
| T08 Bounce and intent | Inject rapid switch transitions, then two deliberate presses | Bounce debounced; deliberate accepted requests have different IDs. Serial capture. |
| T09 Board reset | Reset MCU during unaccepted and accepted event cases | Defined session identity behavior; no false recovery/duplicate promise. Video and mapping. |
| T10 Storage failure | Make test database unwritable or inject disk-full result | No false saved indicator; operator error; queued records retained. Error and recovery log. |
| T11 Reordered updates | Deliver newer completion then stale acknowledgement | Status never regresses; version comparison recorded. State snapshot. |
| T12 Clock skew | Shift station clock substantially; restore it | IDs/order/approval freshness remain valid; no negative claimed latency. Version and timing logs. |
| T13 Reconnect backlog | Queue at least 20 requests; reconnect with repeated drops | Accepted ID set equals unique delivered set after recovery; no silent drops. ID-set diff. |
| T14 Unauthorized submit | Unregistered identity submits station request | Server denies; no new row or event. Reducer failure and counts. |
| T15 Cross-station read | Station A attempts Station B status subscription/query | No forbidden record fields returned. Both identity traces. |
| T16 Role escalation | Station/worker invokes acknowledge, approve, resource edit | Every privileged action denied server-side. Negative test report. |
| T17 Volunteer scope | Volunteer reads/completes unassigned request | Denied; assigned allowed case succeeds. Read and mutation evidence. |
| T18 Invalid transitions | Complete an unacknowledged/unassigned request as restricted actor | Transition rejected under defined policy; previous state retained. Audit/row check. |
| T19 Capacity exhaustion | More eligible requests than resource slots | Capacity never exceeded; residual requests remain visibly unmatched. Solver output. |
| T20 Suitability constraint | Accessible need with unsuitable available resource | Incompatible edge excluded; precise reason shown. Input and candidate-edge trace. |
| T21 Availability | Resource unavailable in current batch/window | No allocation to it; explicit reason. Scenario result. |
| T22 Stale proposal | Generate plan; modify resource/request; approve old plan; also test expired ten-minute TTL | Approval rejected; regeneration requires another human review; no partial booking. Epoch/version/time evidence. |
| T23 Concurrent approvals | Two coordinator clients approve plans using last slot | At most one succeeds; loser refreshes with error; no negative capacity. Concurrent log. |
| T24 Approval replay | Repeat approval operation after ambiguous connection result | Same resulting assignment/reservation; no double consumption. Idempotency trace. |
| T25 Release semantics | Complete/cancel water and charging assignments; repeat operations | Water completion consumes; charging completion releases; cancellation releases; each effect occurs once. Ledger diff. |
| T26 Determinism | Solve same canonical snapshot repeatedly with input order shuffled | Same canonical plan and reasons; invariant checks clean. Hash/output comparison. |
| T27 Empty/infeasible | Supply zero requests, zero resources, impossible requirements | Valid bounded result, no exception loop or invented resource. Fixture results. |
| T28 Malformed model output | Inject unknown tool, oversized args, invalid numbers and repeated tool requests | Tool blocked; maximum eight sequential calls, one repair and 60-second run bound enforced; no privileged mutation. Trace. |
| T29 Prompt injection | Put instructions to approve/ignore rules in request text | Treated as data; no unauthorized tool/action. Trace plus server state. |
| T30 Model outage | Force timeout, rate limit, invalid credentials and provider error | Queue/ack/manual allocation usable; bounded retries; no fabricated live result. Video/log. |
| T31 Explanation check | Compare model explanation to returned assignments/reasons | Unsupported facts suppressed or flagged; source IDs retained. Review checklist. |
| T32 Keyboard flow | Complete coordinator flow using keyboard only | Logical focus, visible focus, labels and recoverable errors. Manual checklist/video. |
| T33 Non-color status | View in grayscale and read station labels | Four meanings identifiable through words/patterns; no color-only dependency. Photos. |
| T34 Physical usability | Consenting teammates try selection, confirm and correction | No forced timing; accidental-input handling clear; limitations recorded. Observations. |
| T35 Secret/privacy scan | Scan repository, build output, logs, video and screenshots | No tokens, private endpoints with credentials, or real resident records. Review record. |
| T36 Clean recovery | Another teammate follows setup/reset/restart runbook | Reproduces same seeded demonstration and recognizes offline states. Timed checklist. |

Critical release blockers: lost accepted requests in declared durability scope; duplicate server effects; false human acknowledgement; authorization bypass; overbooked capacity; AI-originated approval; exposed secret. Reproduce, fix, and rerun affected tests before presenting the corresponding claim. Noncritical visual issues may remain with an explicit limitation if the primary flow is usable.

## 6. Measurement and evidence method

Use one immutable scenario fixture per experiment and record seed, solver version, policy parameters, resource capacities and request count. Compare optimized and FCFS outputs on the same snapshot. Report matched count, unmet reasons, declared objective, solve duration and constraint violations; do not translate synthetic outcomes into lives saved or general fairness.

Measure local-save latency with one process's monotonic clock. Measure server processing and acknowledgement delay using authoritative server timestamps. Measure end-to-end observed status roundtrip in one observer process; never subtract unsynchronized laptop and server wall clocks. Distinguish queueing time during intentional outage from online sync latency. Publish raw samples, actual n, median and p95 when meaningful; label p99 uninformative for a small trial set. Count accepted local IDs, recovered IDs, unique server IDs, duplicate creation effects, and unresolved conflicts separately.

Evidence directory convention: `evidence/<run-id>/{manifest.json, results.json, timings.csv, screenshots/, trace.json}`. The manifest records commit, environment, board, test operator and fixture hash. Redact credentials and personal identifiers at collection time. A previous successful run may be shown as recorded evidence, never as a live run. Keep failed observations alongside the final result so the claimed scope remains clear.

## 7. Deployment and recovery runbook

Use separate development and demo databases, identities and model credentials. Keep the authoritative demo module and schema version pinned with generated client bindings. Serve the static coordinator UI over HTTPS on a selected host; do not put provider secrets into its bundle. Run the station bridge on the station laptop/Pi as an independently restartable local process with a stable data directory. The Nemotron worker is optional to request intake and holds no coordinator approval role.

Startup procedure:

1. Verify the release commit, lockfile, module/schema version and configuration names. Confirm the demo database, not a real dataset, is targeted.
2. Power the inspected low-voltage circuit. Check exact serial device, permissions and expected board identity; avoid auto-selecting an unrelated USB device.
3. Start the bridge against its existing SQLite path. Run migration/integrity checks without deleting pending records. Confirm recovered count and error state before enabling input.
4. Connect station identity, coordinator identity and volunteer identity separately. Verify read scopes with a small synthetic request.
5. Start optional worker, verify provider/model identity with one bounded tool run, then stop further warm-up calls. Record actual availability.
6. Load the versioned seed only in the disposable demo namespace. Confirm existing pending station requests have been delivered or explicitly preserved before reset.
7. Perform T01 and a short T02/T06 smoke check. Confirm the status legend, current connection and recording fallback.

Failure response:

| Symptom | Operator action | Recovery proof |
|---|---|---|
| No uplink | Leave bridge running; show locally saved and pending count; use staffed/paper demonstration fallback | Reconnect and reconcile accepted IDs; no claim remote staff received offline events. |
| Bridge stopped | Stop input/mark unavailable; restart same data path; inspect recovery and serial session | Previously committed IDs still present; no reseeding or replacement IDs. |
| Board disconnected | Mark physical station unavailable; preserve database; reconnect verified board and rehydrate status | Correct request status restored; reset semantics exercised. |
| Database corrupt/unwritable | Stop accepting requests; preserve files/WAL for investigation; use explicit manual fallback | Restore only a verified test backup; disclose gaps and scope. Never silently initialize empty storage. |
| Backend unavailable | Keep durable outbox; show disconnected UI and last confirmed status | Sync resumes with deduplication and current versions. |
| Stale plan | Reject approval, refresh snapshot and regenerate; human reviews again | New approval binds current versions. |
| Model unavailable | Disable AI proposal control; use deterministic/manual workflow | Core acknowledgement/assignment still works; recorded trace labeled historical. |

Do not reset authoritative state as a generic repair. Reset is an explicit demo operation with namespace confirmation and a record of the prior run. Back up SQLite through its supported backup mechanism; copying the main file alone while WAL is active may omit data. Keep code rollback separate from data rollback. Before a schema change, verify migration compatibility and retain a tested prior release; do not roll an incompatible binary onto newer data.

## 8. Ninety-second demo and expo operation

Prepare a fictional shelter with at least one scarce resource and one requirement that cannot currently be met. Keep identifiers and screen positions stable across rehearsals. Use actual human clicks and physical controls.

| Time | Demonstration | Exact claim supported |
|---|---|---|
| 0–15 s | Explain resident station and coordinator queue | RelayAid collects basic assistance requests in a synthetic shelter scenario. |
| 15–30 s | Disconnect uplink, press physical request, show pending local row | Saved on this laptop; not yet delivered. Show service restart only if rehearsed within time. |
| 30–45 s | Reconnect, show one request despite retry, click acknowledgement | Delivered and human-acknowledged are different states. Physical indicator follows committed status. |
| 45–65 s | Show actual Nemotron tools and deterministic plan with unmatched request | AI proposes using bounded tools; constraints and unmet reasons come from data/solver. |
| 65–80 s | Human approves, assigned actor completes, indicator updates | Fresh state is revalidated and capacity reserved atomically. No external emergency dispatch occurs. |
| 80–90 s | Show measured result table and limitations | Report only actual tested restart scope, samples and failures. |

If the live model is slow, use deterministic allocation and briefly show a clearly labeled previously recorded real trace. If the network fails, demonstrate local persistence and show the recorded online segment. Never edit a recording to imply an event occurred live. Keep main video within the source's two-minute guidance pending confirmation; rehearse a separate three-minute expo pitch plus two-minute questions. A/B explain invariants, C handles hardware, D shows integration evidence and entry requirements.

Submission checklist: all four teammates associated; one coherent RelayAid description; repository and video accessible; actual work and AI assistance attributed; public repository contains no credentials; setup and limits documented; sponsor claims match working features; actual Submit completed before cutoff. Official rules allow at most four members, one project per hacker, three sponsor tracks, one of Hardware/Design/Virality, and unlimited tracks labeled [MLH]. Choose Hardware only if demonstrated. Beginner requires more than 66% first-time hackers; three of four qualifies only if truthful. Presence at judging and closing is required for prizes under the posted rules. Keep the separate bot's repository and evidence distinct, but do not treat that separation as an exemption from the one-project rule or sponsor cap: D must obtain explicit organizer routing. [S1, S2]

## 9. Risks, open decisions, and post-hack gates

| Decision/risk | Owner and deadline | Default until resolved |
|---|---|---|
| Hardware and actual electrical specifications | C at G0 | Laptop-hosted USB station; no untested GPIO pin assignment or independent-power claim. |
| Spacetime access and authorization feature fit | B at G0/G1 | Prove the exact identity/view path before UI work; keep app claims conditional if unavailable. |
| Nemotron model, endpoint, quota and sponsor acceptance | D before G4 | Deterministic core; no substitute-model NVIDIA claim. |
| Scrabble timing, sponsor-slot accounting and one-project restriction | D before initial submission; A before check-in | Arrive by earlier window; follow verified three-sponsor limit; obtain organizer clarification before treating separate bot as permitted additional entry. |
| Resource unit and release semantics | B before B18 | Explicit one-batch units; distinguish reusable slots from consumed stock; never automatically replenish stock on completion. |
| Local durability scope | C before G1 | Promise only demonstrated host-storage/process-restart behavior, not MCU flash or arbitrary power-loss survival. |
| Demo data and real contact channels | D throughout | Synthetic records; no real recipient messaging or public survivor information. |
| Schedule compression or owner fatigue | All at every gate | Cut optional scope; protect food/sleep and critical verification. |

After the hackathon, proceed through evidence gates rather than calling this prototype deployment-ready. First obtain an emergency-management/community partner and validate the actual workflow with staff, including paper fallback and who monitors requests. Then run accessibility research with consenting representative users and qualified reviewers, test multilingual comprehension, and revise physical ergonomics. Establish retention, consent, incident handling and role administration before collecting real records.

Next harden identity provisioning/revocation, tenant separation, backups/restoration, monitoring, update rollback and hardware enclosure/power behavior. Test realistic outages, prolonged pending queues, device replacement, clock errors and conflicting operators. Agree service objectives and who responds when the station is unavailable; validate them in a controlled exercise with synthetic data. A supervised non-emergency pilot needs partner approval, explicit limits, human coverage and rollback criteria. Broader use requires independent security/reliability assessment and evidence appropriate to the deployment context. No planning document or hackathon test establishes life-safety readiness.

## 10. Source and status register

- **S1 — Existing project direction and constraints:** [RelayAid — Complete HackUTD Master Plan + Separate ScrabbleBot](https://docs.google.com/document/d/1fKUCv0I7eWlfuVcMI0PFPU4sRjq058ZQI2jTofv0vWw/edit), sections 3–15. Grounds roles, scope, milestone intentions, source-derived schedule, sponsor uncertainty and truthful-status requirements.
- **S2 — Official rules, directly checked 7 November 2026:** [HackUTD Zero Day official rules](https://hackutd-zeroday.devpost.com/rules). The browser review verified Saturday 11 PM team registration, Sunday noon CST final cutoff, code pushed before cutoff, maximum four members, one project per hacker, three sponsor tracks, one Hardware/Design/Virality selection, unlimited [MLH] tracks, greater-than-66% beginner eligibility, and judging/closing attendance for prizes. Current announcements can still supersede logistics; separate Scrabble routing remains unresolved.
- **S3 — Source references to resolve event timing:** S1 links [event schedule](https://drive.google.com/file/d/1IHfpOYb5pjzA-6GYmDvRkVv9oKlTMHzR/view), [Fun Events](https://drive.google.com/file/d/1Hzf5ecBUT_dBJ8K-gUyWY0QEYbH5ertC/view), and [sponsor brief](https://drive.google.com/file/d/1uoncNtIgNMVVINNphlHQdmaKftaRnehQ/view). They are escalation targets for D; this document does not assert a separate fresh inspection of those files.

All task estimates, gates, test IDs, operational procedures and pilot criteria are proposed methodology. No implementation, testing, provisioning, purchase, submission or deployment is claimed by this document.
