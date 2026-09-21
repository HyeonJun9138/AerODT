# ADR 0066: Verti-C ground authority and shared terminal guidance

Date: 2026-09-11

Status: Implemented and deployed on 2026-09-11 after the explicit stop-and-apply request. Physical flights remain stopped.

## Context

Scheduled aircraft previously followed independent taxi profiles. Releasing a
gate when a mission started did not mean the aircraft had physically cleared
it. A planned arrival stand could become unavailable, and a finite approach
wait was not proof that its exit remained clear. Tight consecutive G legs also
exposed a mismatch between preview depth and waypoint handoff, causing repeated
backtracking in actual native flight.

## Decision and ownership

`VertiportGroundControl` in `user_application/uam_mission` accepts one immutable
same-tick batch of local north/east metre observations and movement requests.
It returns route-version-bound `MovementAuthority` values, not positions. The
contracts live in `digital_twin/contracts/ground_operations.py`; immutable
route geometry and its conflict calculations live in the model library.
ScenarioSession and PhysicalFleet inject this same authority into ScenarioEngine.
Simulation does not import the application implementation. Physical remains the
execution owner; Twin consumes observations and decision diagnostics without
issuing another set of taxi or flight commands.

Ground motion remains the existing kinematic scope. An arc-distance integrator
obeys its curve speed profile, bounded acceleration/braking, and a finite safe
stop distance. It never teleports to satisfy an authority. Invalid braking
permission fails explicitly. Heading follows the same path tangent, with the
existing stationary alignment/startup/end holds. Missing or stale route authority
does not permit movement. Native airborne physics and its step ordering are not
changed by ground integration.

Claims protect swept route prefixes. Entered claims are nonpreemptive, waiting
requests have deterministic entry order and bounded arrival preference, and a
winner cannot block an intersection while waiting for an unavailable exit.
Registered potential taxi paths protect against later requests, not just aircraft
already moving. Releasing a claim never deletes an observed physical obstacle;
missing claim owners remain protected until lifecycle release or observation.
Static route-to-route cache keys round clearance upward on a 1 mm grid with a
positive half-cell guard. This adds up to 1.5 mm to the radius at ordinary metre
scales, never reduces separation, and keeps projection roundoff from recomputing
identical conflict geometry every tick. Tangent arc endpoints can move by more
than that radius increment. Exact point-obstacle and capsule helpers are not
rounded; caches contain geometry, not live observations.
Cold construction reuses exact segment bounds and omits unused reverse-arc
calculations. It does not simplify paths or approximate conflict intervals.
The current application uses a declared conservative 7 m circular radius. This
is not a model-specific footprint or a certification of physical separation.

## Occupancy, times and arrival transaction

StandTimeline distinguishes observed aircraft occupancy from flight reservations.
`taxi_requested` marks mission/boarding activation; `departed_s` and `off_block`
mark actual movement. Observed stand ownership is released only after the
aircraft envelope leaves the stand. A track can include boarding/stationary
points before `departed_s`; consumers must not interpret every track point as
airborne or as a timestamp after off-block.

The original flight plan, including `arrival_stand`, is immutable. Actual gate
assignment is reported separately as `gate_assignment` with planned/assigned
stand, revision and reason. A candidate must be free of actual occupancy and
other reservations, reachable on the authored taxi graph and usable for the
arrival exit. Reassignment keeps the FATO and airborne phases; it rebuilds only
the arrival taxi path and alighting path. A stopped taxi rejoins the authored
graph from its actual position, not the original FATO. Moving taxi aircraft do
not abruptly receive a different path.

All fallible candidate preparation and native heading calls precede the serialized
reservation/route commit. Unexpected native errors leave the prior reservation,
route and pose intact. A known unsupported heading capability, or an explicit
final-alignment rejection, uses a reported stationary ground-alignment fallback.
Gate and exit checks use the same immutable tick observations as taxi permission,
so aircraft iteration order cannot change permission. Kinematic rehearsal also
rechecks resource availability before leaving hold and before final approach;
expiration of a scheduled wait alone never clears an occupied gate.

## Shared native terminal contract

The native pilot ABI is 5. Existing functions, tuning prefix and the 17-double
state array remain unchanged. New capability-checked functions are:

- `aerodt_pilot_set_landing_yaw(handle, degrees)`: returns 1 for accepted goal,
  0 after the final landing waypoint is entered, and -1 on error. It does not
  advance/reset physics or change current pose.
- `aerodt_pilot_guidance_status(handle, waypoint_out, mutable_yaw_out)`: reports
  the last actual guidance branch and the current route index without stepping.

Python exposes `terminal_guidance_capable`, `set_landing_yaw()` and
`guidance_status()`. ABI 1–4 remain readable and return explicit unavailable
guidance rather than an invented reason. ScenarioEngine checks capability before
trying to update heading. Execution failures are not mistaken for unsupported ABI.

G guidance uses ordered current/next-leg projection. Preview depth and handoff
share a passage distance so a short sharp corner cannot form an equilibrium
outside the handoff region. Speed budgeting uses remaining routed distance,
target heights and actual vertical response; the configured 4/10 m/s approach
speed is a ceiling, not a forced constant. F/level-G altitude targets are not
lowered to hide an infeasible descent. Existing C departure alignment, fixed-wing
transition, F right-lane guidance and final vertical landing are retained.

## Additive public decision data

Scenario responses and Physical `operations` add actual ground instruction,
`ground_waiting`, `gate_assignment` and native `guidance`. Instructions contain
the action (`ground_wait` or `ground_taxi`), reason, blocker IDs, route ID,
stop/distance, actual wait duration and update time. Resource views distinguish
`stands` from `stand_reservations`, including an empty reservation map. Shared
Twin snapshots add `ground_waiting` and `ground_action` for label presentation.
The Physical wire adapter validates bounded strings, arrays, booleans and finite
numbers. These are operational intent/diagnostics, not navigation sensor truth.

Existing aircraft and pilot/Verti-C/PSU panels consume the common projection.
Ground waiting is not labelled airborne holding. Planned and assigned gates,
actual blocker and native decision reasons are visible; missing/old information
is not fabricated from speed. Existing name/status visibility controls and
polling lifecycle are retained. Events are emitted on meaningful decision changes,
not every render or unchanged native tick.

## Verification and limits

TDD and scoped reviews cover ground crossings, late entry and egress, braking,
gate transactions including native failure injection, order-independent tick
observations, occupied-gate rehearsal, actual native sharp G trajectories and
public UI/wire projection. Evidence and exact command results are in
`data/development_log/evidence/2026_09_11_ground_operations.json` and
`project_support/ground_control_work`.

The actual Unreal mission check validates the native baseline's takeoff,
transition, flight, landing, contact and sensors, not an entire 100-aircraft
vertiport scene. Saved-schedule load tests use copied inputs and flat terrain
with authored deck heights; sample bounds and test duration are reported rather
than claiming a full-day result. No new aviation standard, full tire/contact
model, pedestrian avoidance or automatic diversion is implied. Operating
processes/DLLs are not hot-swapped; applying the private ABI 5 build requires a
coordinated restart with user approval and plan/history preservation.

## Approved deployment follow-up

On 2026-09-11 the user explicitly requested stopping Physical flights and applying
the latest ground/PSU rules. The sender and its owned SSH tunnel were stopped;
the shared source and previously validated ABI5 DLL/runner were installed in
both the local Physical distribution and remote default native path. The remote
web process was gracefully restarted only after confirming its scenario was idle.
No operating flight was restarted. Saved plans, clock choices and connection
settings were preserved. The earlier non-deployment evidence is historical;
`data/development_log/evidence/2026_09_11_physical_rules_deployment.json` records
the deployment, scoped regression results, isolated fleet run and remaining limits.
