# 0061 · External Physical UAM sensor twinning

Date: 2026-09-11

## Decision

A separately running Physical publisher executes one exported, resolved flight
with the existing native FlightPilot / FastPhysics / SimpleFlight DLL at 1x wall
time. It does not run inside the Digital web process. Resolved geometry preserves
the source schedule, authored vertiports, DEM datum and pilot decision policy.
The first deployment runs on the operator workstation. An SSH reverse forward
connects the Digital host loopback to the workstation loopback without opening
an unauthenticated public Physical port.

The custom `aerodt.uam.sensor_packet` JSON protocol, schema_version 1, contains
source process generation, globally increasing packet sequence, UTC sample and
send times, mission generation, independent sensor sequences, frame, units,
quality and uncertainty. This is an emulated sensor protocol, not a claim of
ARINC, MAVLink or avionics certification. Airframe dynamics remain unchanged.

GNSS uses WGS84 ellipsoidal latitude/longitude/altitude and NED velocity; AHRS
reports body FRD to NED Euler angles. IMU reports FRD specific force (stationary
level down axis approximately -g) and body angular rate. The barometer output
includes a deliberately datum-calibrated ellipsoidal altitude; pressure is an
ideal atmosphere emulation, not an independent real-weather observation.
Vehicle reports and active mission route/policy are onboard metadata, not raw
sensor values. Noise/rates/dropouts belong to the versioned model package.
Transport latency/jitter/loss is applied after sensor sampling.

Communication validates incoming wire values and provides bounded HTTP reads.
Three lightweight status exchanges align source UTC to receiver UTC using the
fastest round trip. Raw sensor timestamps remain unchanged in Data. The fixed
per-process offset and half-RTT uncertainty travel with the received record;
bulk bootstrap serialization and later jitter cannot masquerade as movement.
This assumes roughly symmetric link delay and does not change either host clock.
Data owns bounded packets and received measurement histories (32 aircraft,
400 packets per aircraft). Acquisition/reconnect and live/simulation policy are
application responsibilities. Live Twin derives its authoritative World state
from GNSS, barometric altitude and AHRS. A complementary correction smooths
observations. Missing GNSS permits at most two seconds of propagation, then
freezes and marks stale; 30 seconds without GNSS expires the object. IMU is
inspectable but is not integrated into an unvalidated INS navigation solution.

Physical source IDs use `physical:...`; Simulation continues using `scenario:...`.
The Library UAM switch controls acquisition. Scenario ownership suspends Physical
acquisition and clears its old history; return to Live reacquires current data.
No Physical observations are injected into the independent simulation engine.
Restart, repeat and clock recovery create a new mission continuity, so the
renderer/prediction cannot join unrelated flights. Process restarts reset the
transport cursor and supersede retired generations.

The selected aircraft uses the existing intent predictor or delivered learned
models. Feature history is built from received measurements and declared intent;
ground-truth API values never enter the receiver or prediction pipeline. Learned
model limitations (wind assumption, derived rates and training-controller gap)
continue to be reported. Missing/stale inputs prevent a fresh prediction.

## API

Physical: GET `/api/v1/status`, `/api/v1/flight-plan`,
`/api/v1/telemetry?after=N&process=ID`; POST `/api/v1/control` with `restart` or
`gnss_outage`. A cursor mismatch bootstraps from the bounded 20-second packet
window. GET `/api/v1/truth` is separate, for validation only, never a Twin input.
All these endpoints are loopback in the default deployment.

Digital: GET `/api/live/uam`, `/api/live/uam/{entity_id}`. Existing Library settings,
live snapshot/WebSocket and selected trajectory APIs remain compatible.
GET `/api/live/uam/{entity_id}/track` derives the last approximately 40 seconds of
continuous observed track; gaps exceeding two seconds start a new segment.

## Limits

One Physical aircraft is initially launched. The receiving identity/storage
contract accommodates multiple aircraft; fleet launch orchestration and real
aircraft transports are future work. The exporter starts the air leg at the
resolved departure FATO; gate taxi/passenger simulation is outside this first
Physical publisher. Repetition starts a new independently identified flight after
30 seconds parked. No noise-free ground truth is represented as a measured sensor.
