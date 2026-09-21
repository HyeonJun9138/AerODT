# 0083 — Simulation-only terminal relaxation and sampled proximity records

Date: 2026-09-14. User approved the experimental profile, not a real-flight standard.

## Decision

Add independent `psu.terminal_horizontal_m` / `terminal_vertical_m` parameters to
the existing decision-chart schema (additive v1 fields). Defaults remain 120/45 m.
The opt-in deployment profile at
`user_application/configs/simulation/relaxed_terminal.json` sets these to 30/20 m,
entry spacing to 60 s and approach headway to 15 s. All other saved fields remain
unchanged. Observed pilot traffic thresholds, pad occupancy, mixed-operation pad
spacing, ground control and vehicle guidance are NOT relaxed. Geometry and physics
integration order are unchanged. Terminal claim release uses the same independent
envelope as acquisition; neither uses the pilot's traffic envelope anymore.

The profile is merged into saved decision settings, never into an active engine.
Restart the application to load the new code, then load a new scenario to capture
the settings. Pause/resume and resetting an already loaded engine do not adopt
new policy values. An old running server does not recognize the new fields and
can drop them if its decision editor is saved before restart; reapply the profile
in that case. Original defaults remain available for controlled comparison.

## Recording contract

`data.simulation.proximity_records.ProximityRecords` receives detached simulation
state samples from the existing scenario recorder (nominal interval 1 simulation
second; actual gaps are recorded). There is no new runtime state owner or timer.
RunLogger allocates `data/workspace/logs/runs/<run-id>`; `proximity.json` is
checkpointed at most once per 30 wall seconds and flushed on finish/export/close.
No log is opened until the scenario first records. Recorder manifest adds optional
`proximity: {run_id, path, continuous_minimum_guaranteed: false}` with a
workspace-relative path. Existing scenario files/exports remain unchanged.

The v1 proximity document keeps each aircraft-pair's minimum horizontal, vertical
and approximate 3D distances separately. Each minimum includes its own timestamp,
all three simultaneous distances, flight IDs, phases and positions. Horizontal
distance is spherical haversine (radius 6371008.8 m); 3D is hypot(horizontal,
altitude difference), NOT a precise ECEF chord. Pairs require at least one airborne
aircraft. Ground-only pairs are excluded. This is NOT a proximity warning threshold:
far-away pairs may also have records. Flight wait totals retain reported
`hold_seconds`, supplemented by touchdown event `hold_s`; no wait is inferred from
low speed. Duplicate/backward timestamps are ignored and invalid positions counted.

## Limits and verification

These are observed sample minima, not continuous-time closest approach, physical
measurements, collision proof, or aviation separation standards. Replay acceleration
can widen sampling gaps; the report exposes maximum gap. A sudden crash can lose
up to one checkpoint interval of aggregated minima. Effective policy is captured
with each log so conservative and relaxed runs can be compared without mixing.

Tests cover separate policy thresholds, a 36 m parallel route becoming admissible
while intersecting geometry stays blocked, loaded-session immutability, independent
minimum timestamps, invalid inputs, ground-pair exclusion, hold totals and recorder
lifecycle. Native guidance and operational acceptance are separate validations;
unit tests must not be reported as a demonstrated reduction in full-day waiting.
