# ADR 0071: Bounded parked sensor pose constraint

Date: 2026-09-12. Status: accepted.

## Problem

At 1 Hz, delayed parked observations could repeatedly fail the 2 s freshness
requirement before a stationary pose was acquired. Acquiring only after dwell
let GNSS and AHRS noise move the aircraft first. A single rejected GNSS fix or
AHRS excursion also discarded an already acquired stop.

## Decision

The existing World-owned SensorPosterior captures the first consistent stop
pose provisionally. An onboard parked/charging report, or an explicit ground
wait, must agree with ground contact, low measured speed, low gyro rate and
bounded ages of GNSS, vehicle, IMU and AHRS. Position and attitude remain fixed
during confirmation. Advancing observation time confirms the stop after 1.5 s;
repeated reads of the same packet cannot confirm or extend sensor freshness.

Freshness and constraint retention are distinct: delayed observations can keep
an initially captured stop reference until the existing 30 s entity expiry;
cold acquisition requires the shorter 6 s observation window. Original timestamps,
uncertainties and stale/frozen diagnostics remain. More than 30 s of unobserved
movement starts a new pose. A delayed cold AHRS can
provide the last measured orientation with its actual age. No planned gate
coordinate or simulator truth is used; raw sensor packets are unchanged.

The analytical v1 model gains `attitude_gate_sigma=4` and
`motion_confirm_samples=3`. Private posterior counters remember the last
contradictory sensor timestamp and count distinct contradictions. One rejected
position/velocity fix or uncorroborated AHRS excursion does not release the
pose. Sustained displacement/rotation releases it. A taxi/takeoff phase,
loss of contact, credible moving speed or gyro rotation releases immediately.
AHRS disagreement uses reported variance as well as the existing angular floor.
These are additive model parameters; the public sensor/estimation wire schema
and settings API are unchanged.

## Evidence and limits

Six received parked tracks (30 seconds, 180 rows) replayed from identical input:
baseline position variation 0.91–2.75 m and heading variation 0.11–0.70 degrees;
updated output variation 0 for this capture. Stale counts are identical. This
demonstrates removal of jitter, not absolute position accuracy or perfect
recognition under arbitrary faulty sensors. A stationary estimate retains the
measurement's bias. Actual movement and expired data must remain observable.

Regression tests cover cold delayed acquisition, isolated/repeated outliers,
sustained contradictions, immediate taxi/gyro release, expiry and the actual
PhysicalSensors noise generator. Simulation/PSU/native flight dynamics and
the Physical sender's operational rules are unchanged.
