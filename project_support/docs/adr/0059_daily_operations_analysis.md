# ADR 0059: Read-only daily operations analysis

Date: 2026-09-11
Status: Accepted

## Context

Operators need to compare a scheduled UAM day with observed departures and
landings, by vertiport, aircraft and sortie. Planned slots and predicted states
are not flight results. The short inspection event ring may roll over before
the day ends, and older `flights.csv` archives do not contain passengers.

## Decision and ownership

- Data (`data/simulation/operations_records.py`) retains historical event facts
  as the inspection ring advances, and stores the detached analysis input in
  `data/workspace/simulation/scenarios/<scenario_id>/operations.json` atomically.
  It validates record IDs and limits archive reads to 32 MiB and 100 listed runs.
- Application captures plans, event history, active hold counters and metadata
  under the existing session lock. It evaluates the copied input outside that
  lock, sharing one report cache for up to five seconds. It does not advance the
  clock, issue control commands or own aircraft poses. Session reset archives
  the previous run before resetting the engine.
- Communication exposes only GET routes. The HTTP adapter calls the injected
  report facade on a worker; it imports no concrete simulation implementation.
- Web UI provides a left summary and a right detail window with overview,
  vertiport, aircraft and sortie tabs. Visible panels poll every five seconds;
  hidden documents and closed panels stop periodic requests. Late responses
  cannot replace a newer recording or sortie selection. Map focus is explicit.

## Wire schema 1

All endpoints use `Cache-Control: no-store` and accept `recording=current` or a
validated saved scenario ID:

- `GET /api/simulation/analysis`: `available`, `meta`, `totals`, `vertiports`,
  `aircraft`, `hourly`, `delay_bins`, `definitions`; no full sortie/event array.
- `GET /api/simulation/analysis/records`: up to 100 saved run descriptors.
- `GET /api/simulation/analysis/sorties`: filters `vertiport`, `aircraft`,
  `status`, `query`, `hour`, `hold_hour`, `delay_bin`; `page`, `page_size` (1–100).
  `hour` matches planned or actual arrival hour; `hold_hour` matches overlapping
  observed hold intervals. Returns rows plus page, pages, total, and meta.
- `GET /api/simulation/analysis/sorties/{flight_id}`: one sortie and event timeline.
- `GET /api/simulation/analysis/export`: UTF-8 BOM CSV, all sorties of the selected
  run, raw seconds from scenario midnight in `_s` columns. Formula-like text
  cells are escaped. Display filters do not limit the complete CSV export.

Unknown measurements are JSON null, never an invented zero. Seconds may exceed
86,400; the UI labels the following day. A run ID identifies a single execution,
so reset/reload cannot mix reports even if a flight ID is reused.

## Metric definitions

- Departure is an observed off-block event; completion is an observed touchdown.
  In-block cannot stand in for a missing touchdown. Events after the observation
  time and duplicate flight/kind/time tuples are excluded.
- Daily completion uses the full plan. Due departure/arrival compliance uses
  only plans whose corresponding scheduled timestamp has passed. Future flights
  are not overdue. Cancellation and failure retain separate terminal categories.
- On-time arrival means signed arrival delay <= 300 seconds, including early
  arrivals, among landed flights with a planned touchdown. Aggregated delay
  statistics clamp early arrival to zero; sortie details retain the signed delta.
- Network transported passengers sum planned passengers on completed flights
  once per sortie (person-trips). They are not unique people or measured boarding.
  A vertiport's passenger movements add outgoing boarded and incoming landed
  passenger counts; summing vertiports would double-count a trip.
- Vertiport congestion is affected outgoing/incoming movement observations over
  observed outgoing/incoming movements. Outgoing is affected by >5 minute
  departure delay; incoming by positive hold or >5 minute arrival delay. It is
  not facility capacity utilization. Numerator and denominator are exposed.
- Native cumulative hold counters, including an explicit zero, take priority.
  Missing legacy counters can use hold/release intervals. Hold averages and P95
  use observed sorties with positive hold. Hourly aircraft-minutes and peak
  simultaneous waiting are interval-derived; simplified execution is labelled.
- Saved, prematurely stopped runs describe the results at their recorded time.
  Legacy CSVs keep passenger counts unknown, and missing events are not inferred
  from the old `not started` status.

## Validation and limits

Focused Python tests cover reconciliation, duplicates, future flights, missing
values, archive compatibility, ring rollover, immutable reads, reset isolation,
API bounds and full app wiring. Browser tests cover drill-downs, stale responses,
visibility, recovery and selection. Real browser QA uses a separate 1,717-flight
synthetic dataset; one existing 1,584-flight archive is also evaluated read-only.

This introduces analytical presentation and persistence; flight controls,
physics integration, model predictions and Unreal are unchanged. Native/Unreal
mission validation is not claimed. Running web processes need a restart to load
the new routes. An in-progress operational run must not be interrupted merely
to activate the analytics UI.
