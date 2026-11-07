# RelayAid master build guide

7 November 2026 • Detailed implementation blueprint • HackUTD team edition

Build RelayAid as a physical request station connected to a durable local queue and a shared coordination backend. A resident selects water or charging, confirms with a real button, and sees whether the request is saved locally, delivered, acknowledged by a person, or completed. A coordinator reviews the queue, creates a capacity-valid proposal, explicitly approves it, and tracks unresolved work. Nemotron can explain and propose through bounded tools; it never grants itself approval authority.

The recommended implementation is a USB microcontroller, a laptop-hosted TypeScript bridge with SQLite, a SpacetimeDB module, a React coordinator interface, and a separate TypeScript proposal worker. Build the entire deterministic workflow before adding inference. This document and its companion specifications define the work to implement; they do not claim that the product has been built or tested.

## 1. What the team is building

The selected direction comes from the existing RelayAid master plan and the later Project Overview PDF in the supplied Drive folder. Keep the physical station and truthful request state central. ScrabbleBot is a separate tournament workstream and repository; it is not an input, module or screen inside RelayAid. Organizer permission for its entry treatment remains unresolved.

The initial user is a shelter resident who needs a simple way to request basic support. The operational user is a coordinator who must notice unanswered requests and allocate limited resources. The optional volunteer user receives only assigned work. The system administrator registers devices and grants roles. The demonstration uses fictional shelter labels, resource inventories and volunteers.

The product promise for the demonstration is narrow and testable: an accepted local request survives the declared tested restart, retrying it produces one server request, a human acknowledgement is distinguishable from a network receipt, and assignment cannot exceed the stated capacity. A coordinator can always see unacknowledged and unmatched requests. An outage does not make a request disappear or invent a successful delivery.

### MVP and cut lines

| Scope | Build now | Add only after the core passes |
|---|---|---|
| Station | One USB MCU, two buttons, three indicators, laptop text display | Multiple stations, independent Pi appliance, enclosure refinement |
| Requests | WATER or CHARGING, one unit, synthetic labels | Coordinator-confirmed accessibility requirements, additional categories |
| Persistence | Laptop SQLite durable outbox, replay and explicit errors | Device replacement recovery and managed backups |
| Coordination | Live queue, acknowledgement, one-item manual allocation, completion | Volunteer attachment and richer audit views |
| Allocation | Bounded deterministic matching, unmatched reasons, explicit approval | Route planning, time windows, staffing optimization |
| AI | Real Nemotron read/solve/compare/explain/propose after deterministic core | Other model adapters only for a concrete need |
| Deployment | One demo backend and static UI; local bridge; optional worker | Partner-operated service with operational coverage |

Exclude medical diagnosis, model-inferred urgency, automatic emergency dispatch, real transport booking, personal data collection, mesh networking, mains switching and claims of emergency readiness. These exclusions keep the build consistent with the supplied context rather than expanding into several unrelated products.

## 2. The architecture to implement

The station-to-cloud path has four trust boundaries. Physical input enters a local process through USB. The bridge establishes local acceptance by committing SQLite. The backend establishes shared state through authorized transactions. Human operators establish acknowledgement, assignment approval and completion through their own identities. A model response establishes none of those states.

| Component | Responsibility | Data it owns | What it must not do |
|---|---|---|---|
| MCU firmware | Read buttons, debounce, retain a pending press in RAM, show confirmed status | Current USB session and pending press only | Store cloud credentials or claim durable acceptance before the bridge replies |
| Station bridge | Serial parsing, atomic local save, sync retries, status cache, station screen | SQLite outbox and local mappings | Allocate resources or act as coordinator |
| Spacetime module | Identity roles, lifecycle, snapshots, proposals, reservations, audit, scoped subscriptions | All authoritative shared state | Trust caller-supplied roles or AI-authored claims |
| Coordinator UI | Queue, review, acknowledgement, resource maintenance, approval | Temporary UI state | Treat optimistic UI as committed state |
| Proposal worker | Deterministic matching and optional Nemotron tool loop | Bounded run state and sanitized trace | Approve, dispatch, complete or change roles |
| Volunteer UI | Read and complete attached assignments if enabled | Temporary UI state | Read other volunteers' tasks or assign itself resources |

Use one backend authority. SQLite is a station outbox, not a competing shared database. Keep service counts, request versions, reservations and approvals in Spacetime. This also makes the backend responsibility substantive for the Spacetime sponsor requirement.

The companion architecture document supplies tables, permissions, reducer contracts, idempotency rules and deployment order. The allocation document supplies the exact objective, constraints and model loop. The delivery playbook supplies the backlog and acceptance matrix. When editing these documents later, update the shared contract first and regenerate the combined master.

## 3. Build methodology

Use a contract-first vertical-slice process. Agree the request envelope, receipt, lifecycle, resource accounting and role matrix before independent implementation. Start with a single synthetic request that travels through every boundary. Add one failure mode at a time. A feature is integrated only when it works across the actual components, not merely against a local mock.

1. **Prove access and compatibility.** Identify the physical board, confirm a USB data cable, create an isolated Spacetime module, verify identity-scoped reads, and classify Nemotron access as working or unavailable. Pin the actually tested toolchain; do not depend on a guessed latest version.
2. **Prove local acceptance.** A button event creates a durable SQLite row before any saved indication. Restart the bridge with the network disconnected and recover the same ID. A write failure must visibly refuse acceptance.
3. **Prove delivery and human state.** Reconnect, retry the same request, observe one confirmed server receipt, acknowledge as coordinator, make a valid one-item manual assignment, and complete it. Confirm the correct station display follows server versions.
4. **Prove contention and constraints.** Two coordinators compete for the last unit. Exactly one reservation succeeds. Add bounded matching and an infeasible case with an explicit unmatched reason.
5. **Add real model orchestration.** Have Nemotron call the allowlisted tools and create a candidate. Reject invalid calls and show the deterministic fallback. Record the actual model ID, tool sequence and latency.
6. **Prove repeatability.** Another teammate follows the runbook; the scenario resets in an isolated namespace; failure tests and demo recording use the release commit. Preserve measured evidence and known limitations.

Keep branches short and merge one tested slice at a time. One owner edits shared contracts at a time; generated bindings change in the same commit as backend schema. Use pure unit tests for lifecycle/eligibility, real database integration tests for authorization and races, and physical trials for input/indicator/persistence claims. Do not substitute a mocked test for the boundary being claimed.

Role A is Krish, working on the separate ScrabbleBot until the tournament, then RelayAid testing and documentation. B owns backend and solver. C owns station and UI. D owns Nemotron, submission evidence and assists UI integration. C has the largest integration burden; D should take the queue/approval screen against agreed contracts as soon as the model access check is classified. The delivery playbook includes dependencies and estimates. Names for B/C/D should be assigned at kickoff; they are role labels, not inferred identities.

## 4. Physical station assembly and firmware

### Parts and acquisition

Use the first suitable available USB-capable microcontroller rather than waiting for a particular kit. A Raspberry Pi Pico with headers is a reasonable reference build if available; Arduino or ESP32 is acceptable after board-specific pin and voltage checks. A bare Raspberry Pi touch display is not a complete computer kit.

| Part | Quantity | Check before using |
|---|---:|---|
| USB-capable MCU with usable headers | 1 | Exact model, supported firmware, pinout, logic voltage |
| Large momentary buttons | 2 | Normally-open contacts; stable mount; distinguishable labels |
| Yellow, blue and green LEDs | 1 each | Polarity, forward voltage, required current |
| Current-limiting resistors | 3 | Choose from actual LED and GPIO limits; one per LED |
| Breadboard and jumpers | 1 and about 12 | Firm contacts and clear common ground |
| USB data cable | 1 plus spare if available | Data support, correct connector, strain relief |
| Laptop and charger | 1 | Local writable disk, serial permissions, stable power |
| Printed labels and simple stand | 1 set | Need names, confirm action, state legend, reference display |

The hardware guide in the source folder describes checking stock and requesting through HARP, waiting for approval, collecting from the announced location, and returning after closing to the pickup location. MLH hardware is separate. Stock, approval and accessory availability are not established by this plan. No purchase or checkout has been made.

### Wiring procedure

Record the board's exact product and datasheet URL in `docs/wiring.md`, then record signal name, GPIO name, physical pin, wire color and connected component. Never copy a pin number from a different board. For a confirmed original Pico, consult the official Pico pinout and choose five exposed general-purpose GPIOs; GP14/GP15 for buttons and GP16/GP17/GP18 for external LEDs are a proposed mapping to verify against that exact board. Firmware uses GPIO identifiers, not physical header numbers.

With power disconnected, connect each button between its chosen input and ground, using the board-supported internal pull-up so pressed reads low. Connect each LED output through its own resistor to the LED anode and connect the cathode to ground. Choose resistance from `R >= (V_GPIO - V_forward) / I_target`, check resistor and pin ratings, and prefer low indicator current. Do not assume an integrated illuminated button's lamp is a bare LED. Do not connect USB 5 V directly to an input or parallel two power supplies. Have a teammate inspect the circuit, then power by USB and test one input/output at a time. [Pico board documentation](https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html) and [Pico datasheet](https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf) are the reference sources; a different board needs its own documentation.

### Firmware behavior

Button 1 cycles WATER and CHARGING; Button 2 confirms the displayed choice. Selection alone does not create a request. Require a stable input for a proposed 50 ms debounce period and a release before another confirmation. Do not use a long-press requirement as the only path. Keep one unacknowledged physical press in RAM; repeat its unchanged session/sequence frame until the bridge replies. Disable additional acceptance while that frame is unresolved and show that the device is busy. Only after a saved reply may the resident begin another request.

Use a small firmware loop that samples buttons, parses bounded serial frames, retries the pending frame, processes heartbeats and updates indicators without blocking delays. Use the actual board's established toolchain. For a Pico, either the team's tested Pico SDK or MicroPython implementation is acceptable; freeze that choice after the first serial roundtrip. The protocol, not the language, defines compatibility. Firmware must not continuously write flash per button bounce.

The bridge persists a session mapping and a monotonically increasing local sequence. An MCU that stayed powered across a bridge restart reports its old session and pending sequence. An MCU reboot negotiates a new session. A timeout does not create a new logical request ID. A request pressed while the bridge is unavailable is not accepted; say so on the local display. The exact process-restart guarantee applies to already committed laptop records.

### Indicator and display contract

| Condition | Indicator | Resident-facing words |
|---|---|---|
| No selected request / ready | All status lights off; screen ready | Select a need, then confirm |
| Persisted locally, no confirmed server receipt | Yellow slow pulse | Saved on this station. Not delivered yet. |
| Server receipt confirmed | Yellow steady | Delivered. Waiting for coordinator acknowledgement. |
| Human acknowledged | Blue steady | Coordinator acknowledged your request. |
| Assigned | Blue steady plus distinct screen assignment label | Assignment approved. Completion is still pending. |
| Completed | Green steady | Marked complete by staff. |
| Local storage failure, disconnected board or unresolved conflict | Distinct error pattern plus explicit screen warning | Not saved, station unavailable, or needs staff review—as applicable |

Do not reuse the saved pulse for an error. Light patterns and colors supplement words and icons. The display identifies the request whose light is shown, using a short reference backed by the full ID. Show the total locally pending count separately. A green light for one selected request never means all requests are resolved. No continuous bright flashing or audible alarm is needed.

## 5. Screens and user journeys

### Station screen

Serve the station screen from the bridge on loopback with the serial adapter and SQLite in the same local application. The screen shows current category, confirm instruction, last accepted request reference, exact state text, connection freshness and pending count. A small operator-only panel shows retry errors and storage health. It never exposes cloud tokens. Physical and keyboard input must call the same acceptance function, but the demo must identify which input was actually used.

Bind the local service to loopback by default. Serve its UI from the same origin; reject unexpected Origin headers and cross-site state-changing requests. Protect maintenance/reset controls separately. Do not expose a local unauthenticated acceptance/admin API on the venue LAN. Serial attachment is selected from a verified device identity, not the first connected USB port.

### Coordinator queue

Use a left navigation with Queue, Resources, Proposals and Activity. The Queue default emphasizes new/unacknowledged work, with separate filters for acknowledged/unassigned, assigned, completed and cancelled. Each row shows short ID, category, station/zone, server wait, state and freshness. Include counts for each filter; zero matches in one filter must not imply the entire queue is empty.

The detail panel shows immutable request information, server event history and allowed next actions. Acknowledge requires a deliberate click and uses the latest expected version. A pending click shows progress; it does not relabel the request as acknowledged until the authoritative result arrives. A denied or stale action preserves the last confirmed state and offers Refresh. Free-form request content is unnecessary in v1.

### Resource screen

Show category, accounting mode, total, reserved, consumed and currently free units. Changing availability prevents new allocation but does not silently erase active tasks. Reject a new total below reserved plus consumed. Resource availability is an explicit operator statement, not a sensor or AI prediction. Water is consumed stock; charging is reusable concurrent capacity. Explain this distinction near the editable count.

### Proposal review

Show candidate mode (deterministic or actual Nemotron model), snapshot time and expiry, chosen batch and omitted count, policy, assignment list, unmatched list, and FCFS comparison. Put affected request/resource identifiers next to each explanation. Approve binds the exact immutable plan version shown. When the epoch changes, disable approval and explain that a fresh proposal must be reviewed. Rejecting a proposal changes no capacity. A manual one-item plan uses the same validation and reservation path.

### Volunteer and error states

If volunteer scope is implemented, show only attached tasks and a clear completion action; no broad resident directory. A completion records actor and time. During backend disconnection, keep a visible stale-state banner and disable mutations that require server authority. During model failure, leave acknowledgement and deterministic planning available. During empty data, distinguish no requests, no resources, no feasible match, and disconnected/unloaded state.

### Accessibility acceptance

Use semantic buttons, explicit labels, visible keyboard focus, logical tab order, status announcements and text equivalents for icons. Aim for generous 44 CSS pixel interactive controls in this design; WCAG 2.2's minimum target criterion is a separate rule with exceptions, not proof of overall compliance. Test zoom and narrow layouts without hiding essential state. Avoid drag-only allocation. Review contrast and use words/patterns instead of color alone. Test with consenting teammates and report observations as prototype usability checks, not certification. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## 6. Configuration, deployment and cost control

Record these configuration names in an example file with placeholders only: `SPACETIME_URI`, `SPACETIME_DATABASE`, `STATION_IDENTITY_TOKEN_FILE`, `STATION_DATA_DIR`, `SERIAL_DEVICE`, `WORKER_IDENTITY_TOKEN_FILE`, `NEMOTRON_BASE_URL`, `NEMOTRON_MODEL`, `NEMOTRON_API_KEY_FILE`, `DEMO_SCENARIO_ID`. Use separate dev/demo values. Provider key material stays in the worker; station identity stays in the bridge; coordinator identities remain distinct. Browser build variables contain no inference key or owner token.

Use an existing team-approved static host for the React bundle and the sponsor-provided Spacetime environment if available. Run the worker locally on a separate team laptop for the hackathon unless an already available host is simpler. The station bridge remains physically attached to the station. This avoids making a new paid server a prerequisite. Add health/readiness checks for bridge storage, serial link, backend connection and worker model status; do not make the overall station unavailable merely because inference is down.

No fixed hosting or hardware price is assumed. Keep a ledger with provider, free/credit offer, verified quota, expiration, spending cap, billing owner and shutdown instruction. Inference planning estimate is `runs × (input tokens × input rate + output tokens × output rate)` with the actual provider's rate units. Track failed/retried calls too. Stop optional inference at an agreed budget or quota threshold; deterministic coordination continues. Do not assume sponsor credits remove every third-party charge.

Preserve SQLite on local storage with tested durability settings. WAL plus FULL synchronization is the selected starting policy; hardware and filesystem behavior still constrain power-loss guarantees. Back up through SQLite's supported mechanism, not an arbitrary copy of an actively changing main file. [SQLite WAL](https://www.sqlite.org/wal.html) and [synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous)

## 7. Separate ScrabbleBot implementation lane

Keep the existing A/Krish commitment, but do not let it block the RelayAid critical path. A should use the official starter and game rules, build a legal baseline first, then compare improvements on held-out synthetic games. This is an auction/word-building game; do not implement board placement, premium squares or ordinary Scrabble assumptions unless the official game supports them.

The independent repository needs a connection/state adapter, dictionary/count-vector word legality, bounded word enumeration, tile valuation, budget-capped bidding, reconnect logic, and a single decision owner. Keep inference and remote analytics out of the one-second bidding callback described in the existing source. Cache dictionary structures, calculate feasible words from rack counts, reserve letters while word submission is pending, and fall back to a safe baseline when time expires. Benchmark legal-move rate, cash validity, decision duration and performance against the same opponents/seeds. Measure rather than promise a winning policy.

Before tournament use, verify current tournament ID, entry route, official lexicon, bid/tie/rounding rules, blank-tile treatment, code-update permission and exact start with the sponsor. The existing source has a 10:45–11:45 PM window and an 11 PM sponsor heading. Preserve the earlier check-in intention and ask organizers to resolve it. The public one-project and three-sponsor rules do not themselves establish a separate-bot exemption. No registration or bot submission is performed by this planning package. The source links [official game documentation](https://scrabblebot.spacetimedb.com/docs) and [tournament page](https://scrabblebot.spacetimedb.com/tournament); verify them before implementing game-specific details.

## 8. Competition evidence and scope discipline

| Candidate | Working evidence required | Build implication |
|---|---|---|
| State Farm | Catastrophe-support scenario, visible unanswered and unmatched needs, human coordination | Keep the product narrative focused on requests that might otherwise be missed; do not invent impact statistics |
| NVIDIA | Actual Nemotron model, multiple steps and real tools, useful application behavior | Preserve model identity and a sanitized execution trace; an unavailable integration is not a qualifying substitute |
| Spacetime Main | Public repository and majority of the team's own backend on Spacetime | Demonstrate authoritative permissions, lifecycle, resource state, approvals and subscriptions there |
| Hardware | Real input and physical status output integrated with the request lifecycle | A website displayed on a laptop alone does not demonstrate this design's hardware contribution |

These fit the directly reviewed sponsor brief. Eligibility depends on completed work and organizer interpretation. The official rules limit teams to three sponsor tracks plus one of Hardware, Design or Virality; all submitted projects enter General and additional tracks labeled MLH are allowed. A separate ScrabbleBot repository is not evidence of exemption from the one-project rule or sponsor count. D must resolve its route before selecting entries. Photon and additional integrations remain optional alternatives, not automatic extra entries. [Sponsor brief](https://drive.google.com/file/d/1uoncNtIgNMVVINNphlHQdmaKftaRnehQ/view), [official rules](https://hackutd-zeroday.devpost.com/rules)

## 9. First actions for the team

At kickoff, B/C/D freeze the shared contract, C identifies and tests the physical board, B proves backend identity isolation, and D verifies real Nemotron access plus the entry rules. Then B and C complete physical save → offline restart → reconnect → one request → human acknowledgement. D builds the queue UI against the contract while inference access is unresolved. Once that loop is stable, implement the same reservation path for manual and optimized plans and run the last-slot race test.

Use the delivery playbook as the work queue. Leave every acceptance result NOT RUN until executed. Preserve food, recovery, existing commitments and at least a quarter of remaining development capacity for integration and fixes. The official Sunday noon cutoff is fixed; feature scope is what changes when time is lost. The first releasable result should be a small honest system whose entire request journey works.

## 10. Source register and decision authority

The [existing RelayAid plan](https://docs.google.com/document/d/1fKUCv0I7eWlfuVcMI0PFPU4sRjq058ZQI2jTofv0vWw/edit) establishes the chosen product, role split, prior timetable and boundaries. The later one-page Project Overview PDF in the [supplied parent folder](https://drive.google.com/drive/u/1/folders/1bYEBe9jYOgyEAAIUuvSXY4rOLuKYxNU_) confirms the laptop-hosted durable queue and two-button flow. These are project-context sources, not evidence of successful implementation.

The [sponsor brief](https://drive.google.com/file/d/1uoncNtIgNMVVINNphlHQdmaKftaRnehQ/view) and [hardware guide](https://drive.google.com/file/d/17Wn4tydu6r_1sLqj6wh7_dfWGjczhtth/view) were directly reviewed. The [official rules](https://hackutd-zeroday.devpost.com/rules) were directly checked on 7 November 2026 for registration, final deadline, entry limits and attendance requirements. Current organizer announcements control event changes. Technical primary references are linked alongside the relevant engineering decisions and in the companion specifications.

The two earlier drawio diagrams and historical Master Plan/backup remain in the parent folder as context; this package does not modify or claim a fresh technical audit of those files. The detailed specifications here are new proposed implementation choices. Where board availability, provider access or organizer treatment is unresolved, the document provides a default and an explicit verification task instead of inventing an answer.
