# ADR 0064: Whole-schedule Physical operations and per-aircraft sensing

The Physical console previously executed one resolved flight. CSV inputs now
default to whole-schedule execution, while single-flight JSON and explicit single
mode remain supported. PhysicalExecution owns one complete execution context.
Mode changes cancel and join the previous worker before clearing outgoing packets
and allocating a new process identity. Pause preserves aircraft and facility
state; resume starts fresh per-aircraft sensor continuity at current UTC.

PhysicalFleet composes the existing ScenarioEngine, ScenarioPilots/FlightPilot,
PSU sequencing and decision policy, vertiport resources, operating profile, DEM
and route network. It does not implement a second PSU or pilot decision engine.
The imported environment and policy are snapshots, not automatic remote sync.
Existing airborne physics remain native FastPhysics/SimpleFlight. Existing
ground taxi/turnaround remain kinematic; no new Unreal integration is claimed.

SensorScenarioPilots subdivides native advances into 0.02 s calls and returns
read-only observations after the shared engine barrier. It does not interpolate
airborne coordinates. Kinematic ground snapshots can be sampled between the
existing ground steps. Each aircraft has its own PhysicalSensors instance,
bias and mission continuity. Movement reports at 10 Hz; parked aircraft report
latest sensor observations at 1 Hz without changing model sampling rates.

Schedule start maps to current wall time, original plan time, or a chosen KST
time. Seeking computes the whole fleet from schedule start. Sensor UTC always
reflects the current execution, not the historical plan epoch. The target rate
is 1x; actual rate and lag are exposed. After more than three seconds of backlog,
native state is preserved, sensor continuity is re-anchored to current UTC, and
a fleet_clock_rebased event is logged. Completed plan steps are never skipped.

Additive schema v1 packet fields: flight_id, report_hz, operations (instruction,
PSU clearance, and state_source). These are operational intent/diagnostics, not
ground-truth navigation measurements. Truth remains a separate validation route.
GET /api/v1/console/operations exposes aggregate counts, aircraft instructions,
vertiport resources and recent shared-engine events. It is a read-only snapshot.
GET /api/v1/flight-plan exposes the full schedule in fleet mode. Telemetry gains
an optional aircraft_id filter, ordered batches of at most 256, and has_more for
catch-up. The outgoing ring holds 2,048 packets; receivers retain 128 aircraft.
Gzip bounds fleet network cost; the existing 8 MB response limit is retained.
An actual remote test showed that replaying every queued packet let navigation
fall several seconds behind. Twin therefore requests delivery=latest: one newest
packet per aircraft since its cursor, ordered by sequence, without redundant
raw sub-samples. Original measurement epochs are preserved. Model sampling and
the ordered raw telemetry endpoint are unchanged. Coalesced packets are counted
separately from missing packets. This is a live-view delivery policy, not a
complete sensor archive; consumers needing every sub-sample use ordered delivery.
The navigation history retains latest sensors, not repeated raw IMU batches.
The Twin continues receiving sensor observations rather than running the
Physical PSU or replacing sensor estimates with truth. Simulation mode suspends
live ingestion as before. Connection diagnostics count matching aircraft by
publisher identity and freshness rather than inspecting only the first aircraft.

Validation includes native per-aircraft substeps, shared two-aircraft ground/PSU
execution, full-fleet retention, bounded cursor pagination and clock mapping.
The imported 100-aircraft, 1,825-flight schedule was advanced to 06:40 with the
actual shared engine: 40 airborne, no pilot failures, followed by five seconds
of 50 Hz native observations and wire validation. Deployment and live reception
evidence are recorded separately in CURRENT.md; this is not a full-day or
Unreal validation claim.
