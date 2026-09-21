# ADR 0075: Explicit known-bias sensor calibration demonstration

Date: 2026-09-13. Status: accepted.

## Decision

Add an opt-in `known_bias_v1` sensor profile alongside the unchanged default
stochastic model. The versioned model package defines north +3 m, east -2 m,
ellipsoid altitude +4 m, heading +2 degrees, pitch +1 degree and roll -0.5 degree.
GNSS velocity and IMU have no added error in this mode. Sensor dropout is disabled
for the demo, while the explicit GNSS outage test and transport delay/loss remain.
No aircraft dynamics, control, surface datum or mission state is changed.

Each optional sensor-level `calibration_profile` tag identifies the exact rule;
untagged legacy observations remain stochastic. Unknown tags are rejected.
This is an additive v1 wire extension; old receivers do not calibrate the new
profile, so deploy the receiver before selecting it on Physical.

Live Twin subtracts known biases before the existing covariance/ground estimator.
Longitude correction uses recovered latitude. Each sensor retains its own sample
time, sequence and clock mapping. Raw packet/history values remain unchanged.
Changing sensor profile invalidates only the World-owned estimator posterior;
it never restarts a flight. The numerical covariance floor is not a real sensor
accuracy claim. Later fusion, current-time prediction and transport delay still
exist; exact reconstruction is demonstrated only at the observation epoch.

Local, same-origin `PUT /api/v1/sensor-profile` accepts a bounded JSON profile,
persists it through the data-owned console files and changes future samples.
Status advertises supported/current profiles. No lifecycle or flight command is
issued. Initially deploying changed Python requires a process restart; a running
native flight has no checkpoint/restore and must not be silently reset.

Digital detail adds calibration diagnostics and raw/corrected observation pairs.
`GET /api/live/uam/calibration-example` returns a bounded synthetic teaching
fixture generated through PhysicalSensors and the same receiver inverse. Its
reference values exist only for example validation and never enter live records
or World. Live diagnostics intentionally publish no truth-error number.

## Visualization and limits

A modal in Live Twinning shows plan-view paths, altitude profiles, the inverse
coefficients and removed known bias. Example/live sources and stale data are
explicit; at most one selected aircraft is polled once per second while open.
The trail retains at most 40 distinct sensor observations and splits at outages.
Closing aborts work; mode/target switches discard obsolete results.

This demonstrates known calibration, not neural inference and not exact recovery
of arbitrary random noise. General stochastic input still uses the existing
estimator. Real accuracy needs separate matched-time ground-truth validation.
