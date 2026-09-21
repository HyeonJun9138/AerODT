# 0062 · Physical desktop console and independent playback clocks

Date: 2026-09-11

The local Physical publisher gains an operator console opened by a small Windows
EXE. The EXE starts/reuses the existing publisher and SSH tunnel, then opens a
Chrome/Edge app window. The native flight engine remains in the adjacent runtime;
this is a workstation launcher, not a self-contained redistributable simulator.

Data owns imported CSV/resolved JSON plans, environment definitions and saved
settings under `data/workspace/physical_uam/console`. The copied project DEM and
geoid stay under `data/workspace/terrain/user_dem`. No edits are written to Digital's
project environment. Model Library validators and ScenarioEngine resolve selected
CSV flights against these definitions. Physical execution still uses FlightPilot
and the existing DLL. Only one selected air leg is launched at a time.

## Clocks and controls

- `now`: the selected air leg starts at current wall time.
- `plan`: the same departure begins at the flight's planned lift-off date/time.
- `at`: a KST date/time within 24 hours of planned lift-off. Before lift-off, the
  aircraft waits at the departure FATO. After lift-off, the native pilot advances
  to the chosen elapsed point before live publication begins. No seek samples are
  published as if they were newly observed. Completed legs remain landed.
- Pause freezes native progress and suppresses publication. Resume preserves the
  pilot but resets sensor continuity and anchors fresh observation UTC. Stop
  releases the native handle while leaving the console/API available.
- Repetition begins at departure after 30 seconds parked; it does not keep seeking
  into a previously completed flight. Device suspend resumes with a fresh UTC
  continuity, without inventing a stream of observations during the gap.

Sensor `sample_time`/`sent_time` always mean current UTC. Optional v1 envelope fields
`plan_time` and `flight_elapsed_s` carry the plan clock and native flight elapsed
time. Digital validates these fields and uses `flight_elapsed_s` for learned
prediction features; old producers retain their former elapsed-time fallback.
Mission identity changes on start/resume and raw sensor timestamps remain intact.

## HTTP

GET `/api/v1/console` and `/api/v1/console/catalog/{id}` read saved input options.
POST `/api/v1/console/import?kind=plan|environment` imports a bounded file.
POST `/api/v1/console/preview` resolves a complete draft without changing execution.
POST `/api/v1/console/start` validates, saves and queues that draft for execution.
Existing `/api/v1/control` additionally accepts `pause`, `resume`, and `stop`.
Controls require a same-origin request; request bodies are bounded at 32 MB.

The geographic route diagram and altitude profile are local SVG views, with no
map-provider dependency. DEM selection changes planning heights; the diagram is
not a 3D terrain/collision renderer. Resolved flight JSON keeps its included route
and heights; environment edits apply to CSV plans. This distinction is shown in
the preview. Sensor uncertainty defaults remain in the model package; the console
exposes a run seed rather than duplicating sensor tuning definitions.

## Validation scope

Verify clock mapping, seek/pause/resume continuity, raw packet compatibility,
input rejection without losing valid files, actual DEM/flat/deck height effects,
desktop EXE startup/reuse, browser controls and Digital sensor reception.
Native flight laws and Unreal have not been changed by this console.
