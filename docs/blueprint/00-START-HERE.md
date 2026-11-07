# Start here — RelayAid build blueprint

This folder contains the complete implementation plan for the selected RelayAid project. Start with **01-RelayAid-Complete-Master-Plan.md** for the entire plan in Drive's Markdown preview, or download **10-Complete-Blueprint.html** and open it for a searchable guide with navigation and the architecture diagram.

## What is included

| File | Use |
|---|---|
| 01 Complete Master Plan | All four detailed guides in one document |
| 02 Product Hardware and UX | Product scope, build methodology, station assembly, screens, configuration, cost controls and separate bot lane |
| 03 Architecture and Contracts | Module layout, tables, roles, serial/outbox contracts, idempotency, snapshots and atomic reservations |
| 04 Allocation and Nemotron | Exact optimization objective, FCFS baseline, unmatched reasons, six tools, bounded inference and approval |
| 05 Backlog Testing and Demo | 38 tasks with owners/dependencies/estimates, 36 acceptance tests, release gates, runbook and demo |
| 06 Architecture PNG and SVG | Previewable diagram and editable vector source |
| 07 SubmitRequest schema | Proposed JSON Schema for request envelopes; use the generated backend bindings for SDK types |
| 08 Synthetic Scenario | A reproducible constrained matching example with derived expected outcomes |
| 09 Execution Templates | Editable JSON task and test records; all NOT_STARTED / NOT_RUN |
| 10 Complete Blueprint HTML | Standalone navigable copy of the full master plan |
| 11 Blueprint Bundle ZIP | Downloadable copy of every delivery file |

## First build sequence

1. Assign B/C/D roles, inspect actual hardware, prove backend access and classify Nemotron access.
2. Freeze the serial, submit, receipt, lifecycle and capacity contracts.
3. Prove physical input → local commit → offline restart → reconnect → one server request → human acknowledgement.
4. Add one-item manual reservation/approval/completion; then deterministic matching and a concurrent last-slot test.
5. Add real Nemotron tools only after the deterministic path works.
6. Run the acceptance matrix, record actual evidence, freeze the tested release and submit before the official cutoff.

## Decisions already made by this blueprint

- Laptop SQLite owns local durability; the MCU supplies physical input/output.
- Spacetime owns shared authoritative state; clients and model workers cannot bypass roles.
- WATER and CHARGING, one unit per request, normal priority, acknowledged requests only for allocation.
- Water stock is consumed; charging capacity is released on completion.
- Solver limits: 100 requests, 30 resource pools, 100 free units; omitted requests are visible.
- A server-created immutable snapshot, exact allocation epoch, row versions and a ten-minute TTL protect approval.
- Human approval commits reservations atomically; AI can create proposals only.

## What still needs verification

Actual board and parts; tested SDK/server versions and sponsor access; a working sponsor-accepted Nemotron endpoint/model/quota; separate ScrabbleBot entry treatment; measured durability and test results. The prior plan's calendar holds are preserved as context, not newly scheduled events. All requirements/design/evidence distinctions are explicit in the guides.

Official rules were checked on 7 November: [HackUTD rules](https://hackutd-zeroday.devpost.com/rules). The deadline is Sunday 8 November at noon CST; code must be pushed before it. The [source project plan](https://docs.google.com/document/d/1fKUCv0I7eWlfuVcMI0PFPU4sRjq058ZQI2jTofv0vWw/edit) and later Project Overview PDF establish the selected project.

This is a proposed build package, not a completed application or emergency-ready system. Existing source files are preserved in the parent folder.
