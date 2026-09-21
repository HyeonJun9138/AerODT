# ADR 0060: Multi-FATO terminal permissions and operational decision/I/O records

Date: 2026-09-11
Status: Implemented; native and web validation passed; Unreal execution pending host script-signing restriction.

## Problem

A single requested FATO prevented useful distribution across compatible pads. Pad-centre proximity alone did not identify remote pads with crossing terminal flight paths. A future reservation before an existing mixed operation could violate the required separation. Completed reservations lost their actual-use separation. Mutable clearance snapshots and a short event ring could not explain a full operating day. Provider success and local delivery were not journaled.

## Decision

- Before departure, enumerate compatible FATO roles and executable taxi/air routes (layout maximum eight pads). Preserve supplied en-route waypoint order. A changed endpoint requires an existing directed network connection. Compare forecast arrival/departure waits and active incoming demand; original imported plans remain unchanged. Freeze the chosen route when departure clearance is issued. Never rebuild an airborne native pilot to change its FATO.
- Protect takeoff/climb and descent/landing segment volumes, using configured horizontal and vertical margins. Crossing movements on different pads wait for observed segment exit; missing geometry fails closed. Same-FATO following arrivals retain existing headway/capacity and final physical occupancy checks. Departure release needs actual position outside its terminal volume, not a phase label or ETA. Runtime remains the owner of physical state.
- PadTimeline enforces mixed spacing on both sides of a booked operation. Actual takeoff/touchdown timestamps remain effective after early physical release. A failed aircraft does not silently relinquish occupied resources.
- Emit immutable PSU decisions with flight/aircraft, original/assigned FATO, chart node, policy hash, outcome, reason, blocker identities, event sequence and simulation time. Coalesce identical consecutive decisions; numerical ETA churn alone is not a decision. Declarative charts describe allocation and departure/approach protection. Policies remain snapshots of the loaded scenario.
- Use Data OperationsHistory for the recorder cursor and final CSV facts, so engine inspection-ring rotation cannot omit new events. Flush decision JSONL events. Analysis preserves distinct decisions at the same simulation tick and compares planned/assigned pads.
- Data owns an indexed SQLite WAL audit journal under the existing application RunLogger directory. A bounded 2,048-entry worker queue commits batches. Health exposes pending, written, dropped and write-failure counts. Historical runs reopen read-only with validated IDs and cursor pagination.
- Correlate provider request/received/Data-registration/unchanged/error/cancelled transitions. Persist bounded sanitized JSON payloads by SHA-256 and compressed content; preserve provenance. Operational HTTP requests record local outcomes/status and bounded JSON bodies. Rehearsal decisions record actor, before/after and version, explicitly without native vehicle-command semantics.
- WebSocket delivery is aggregated every ten seconds, including attempts, successful local sends, bytes and first/last payload digests. Local ASGI/WebSocket send completion is NOT remote consumer acknowledgement. Source events carry application/scenario context, not invented UAM flight associations.

## Read-only API additions (schema_version 1)

- Existing `/api/simulation/analysis` adds `fatos` and `decisions`; sortie and CSV results include planned/assigned FATO IDs.
- Sortie filters add `fato` (scoped to the chosen vertiport) and `decision_reason`.
- `/api/simulation/analysis/flows`: run_id, optional scenario_id, before cursor, limit 1–200.
- `/api/simulation/analysis/flow-records`: recorded application runs.
- `/api/simulation/analysis/flow-payload/{digest}`: bounded sanitized content for a valid run/digest.
- Operational HTTP responses include `X-AeroDT-Trace` correlation ID. No auth/session headers or query strings are journaled. Secret-like JSON keys are redacted. Content caps and omitted/non-JSON bodies are explicit; this is not unrestricted raw packet capture.

## UI and metrics

Left summary links to FATO changes and decisions. Right tabs add FATO operation and decision/I/O history. Charts drill into the exact assigned pad or decision reason. FATO takeoffs use native takeoff-start events; landings use touchdown. Missing historical takeoff events are not estimated. Terminal wait can overlap airborne hold, and protected time is route reservation time, not physical pad utilization. I/O records use wall clock; sortie decisions use simulation time. Long tables scroll within the panel and six tabs remain accessible on small screens.

## Validation and remaining scope

- Remote core Python regression: 87 passed. Native flight/approach/traffic regression: 60 passed. Final app/provider/HTTP/WebSocket/role/wire/FATO checks: 38 passed (overlaps earlier groups).
- New isolated native four-shared-pad scenario: four completed flights, three arrival pads used, 1,430 simulation seconds, 77 recorded decisions, minimum sampled airborne distance 1,094 m. Frozen assignments, no >200 m two-second pose jump, actual resource release and blocking history verified.
- Final declarative chart tests: 10 passed. Node chart/analysis tests: 37 passed after fixing a crossing branch in the drawing. Architecture PASS.
- Browser: 1,717 synthetic flights, 6,155 events, evaluation 53.18 ms; exact FATO/decision drill-down, sortie inspection, redacted payload read, 390/600/1280/1920px layouts, page errors zero (isolated fixture favicon 404 only).
- The native Unreal script was attempted but PowerShell rejected the unsigned run.ps1. No execution policy was changed. Actual Unreal collision/visual validation is outstanding. The native four-flight scenario does not certify every airspace geometry or eliminate en-route/holding conflicts. Static terminal volume protection can reduce throughput where paths overlap.
- The former production server was found absent (no 8766 listener or launcher process). No operating scenario was stopped by this task. The configured launcher was started with --reuse and --no-browser; no scenario is automatically played. Deployment/live verification is recorded in the evidence file.
