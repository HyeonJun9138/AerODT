# 0065 — Live UAM sensor alignment and covariance state estimation

Date: 2026-09-11

## Decision and ownership

Physical UAM navigation now uses the analytical package
`uam_sensor_alignment/v1`. No learned model, simulator truth, PSU clearance,
route snapping or Physical control command is used to correct received position.
The Physical simulator and its aircraft, port and pilot behavior are unchanged.

Data retains received packets unmodified. A separate per-sensor projection keeps
the newest measurement by source sequence and sample time, even when another
sensor arrives late or is missing. A retained observation keeps its old timestamp.
Process/mission changes reset continuity. Unsupported frames and invalid values
remain subject to the existing wire validation.

The World entity is the only owner of current estimated state. Its immutable
`SensorPosterior` holds the last accepted observation posterior for the next
update. The estimator is a pure function of record, World time, previous entity
and validated settings. Data feature history stores past stabilized World outputs.
Internal posterior memory is omitted from public JSON.

## Algorithm and limits

GNSS and calibrated barometric altitude are aligned to the GNSS epoch using the
reported vertical velocity. Samples outside the configured skew or consistency
gate are not combined. Position/velocity use three independent N/E/D 2×2 Kalman
updates in a fixed local frame, with phase-dependent process covariance,
reported measurement covariance and additional clock-offset uncertainty.
Prediction and correction follow the standard covariance formulation described by
[Welch and Bishop](https://www.cs.unc.edu/~welch/media/pdf/kalman_intro.pdf).
This diagonal-axis approximation is intended for the local UAM scene.

Normalized position and velocity innovations are gated. A rejected fix does not
advance observation time or reduce covariance; repeated World ticks do not apply
the same observation again. New independent normal observations recover normally.
After a long rejected sequence, three mutually consistent plausible fixes can
reacquire position and mark a display discontinuity. AHRS angles use shortest-arc
smoothing and a rate gate; attitude older than two seconds becomes unavailable.

Short gaps use constant-velocity propagation, with uncertainty increasing with
age. Position stops at the earlier of the configurable time horizon (default
2 seconds, range 0–5) and uncertainty budget (default 20 m). Later uncertainty
continues to grow even while display position is frozen. Entries expire after
30 seconds. Reacquisition breaks the displayed trail rather than inventing the
missing path. Accepted smoothed World samples feed existing optional predictions;
outlier/frozen states cannot start a forecast. Existing forecast enablement is
not changed.

Horizontal uncertainty is sqrt(Pnorth + Peast); vertical is sqrt(Pdown).
These model statistics are not calibrated confidence bounds or guarantees of
absolute accuracy. Persistent common GNSS bias cannot be removed without an
independent reference. IMU remains visible telemetry: this change does not add a
strapdown INS, sensor calibration or long-outage inertial navigation. No automatic
rewind or delayed-measurement smoothing pass reconstructs the unobserved past.

## Additive API and UI

- World wire entity: public `estimation` diagnostics (mode, uncertainty,
  correction/innovation, accepted/raw observation age, prediction duration,
  outlier counts, barometer/attitude/clock timing); internal
  `estimation_state` is excluded.
- `GET /api/live/uam/alignment`: model, current World-derived counts, settings.
- `PUT /api/live/uam/alignment`: same-origin bounded JSON preferences, persisted
  by Data to workspace `settings/uam_alignment.json`. Changing settings resets
  the posterior at the next valid observation. Raw records remain unchanged.
- Existing status/detail endpoints add diagnostics, `raw_sensors`,
  per-sensor alignment flags and corrected World coordinates.
- Live Twinning Physical card adds global state counts and collapsible settings;
  selected aircraft displays original GNSS, current corrected Twin, uncertainty,
  rejected measurements and a distinct gap/frozen/reacquired status.

Validation evidence and remaining limitations are recorded in
`data/development_log/evidence/2026_09_11_uam_alignment.json` and CURRENT.
This received-data module validation is not full native/Unreal mission validation.
