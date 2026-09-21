# ADR 0077: Physical accepted-observation playback

Date: 2026-09-13. Status: implemented; main receiver restart pending.

## Evidence

The source runs native physics slower than wall time under load. Sensor velocity
is per physics second. The estimator assimilates fixes using the sensor motion
clock, but its current-time output coasts in UTC. Repeated UTC projections then
corrections therefore form a sawtooth. The display previously interpolated those
projections, and its six-entry ring could not cover irregular observation gaps.
The source already adds ordinary measurement noise (GNSS 0.8/0.8/1.8 m white
noise, 0.4 m bias; AHRS 0.25 degrees). Those settings were not changed.

## Decision and ownership

- Add optional `TwinEntity.display_observation`: accepted posterior ECEF pose,
  measured velocity, navigation/actuator presentation, observation UTC, monotonic
  sensor time where available, clock kind and continuity context. It is a
  projection of World-owned accepted filter state, not a second current World.
  No Physical truth is read by estimation or presentation.
- Context includes process, mission, continuity, filter settings/calibration
  signature and reacquisition epoch. A repeated held or rejected fix adds no
  display sample. Reacquisition after unobserved motion breaks the track once.
  Consistent short physical intervals across host scheduling pauses preserve
  the posterior. UTC still governs staleness, uncertainty and expiry. Setting
  zero forward-coast time does not reset normal 5 Hz observation continuity.
- A bounded 64-entry display history interpolates accepted positions and
  attitude/tilt with a monotonic cursor. The cursor estimates source progress
  from arrivals and adjusts a bounded target reserve. It never moves beyond the
  latest accepted position, and cannot turn a stale report into a fresh fix.
  Target reserve 0.45–2 seconds is not an end-to-end latency guarantee.
- A held sample during clock calibration translates the history's UTC mapping,
  without generating motion. Legacy samples use sender UTC as their identity.
  The prediction anchor converts display time back to receiver UTC. Old servers
  without the optional observation retain the existing display fallback.
- Estimation borrows Data-owned records within a synchronous lock scope, instead
  of recursively copying all routes and sensor payloads every World tick.
  Public readers continue receiving copies; estimation cannot mutate records.
- Sensor detail distinguishes current-time estimated state from displayed past
  observations. It reports source observation age, delivery/processing delay,
  time since receiver ingestion, and the actual map observation age. Coasting
  alone no longer implies packet loss. Existing noise and known-bias profiles,
  raw observations, sensor sequences and native flight controls are preserved.

## Validation

- Receiver Python: 128 passed, two existing dependency deprecation warnings.
- Browser-module regressions: 193 passed with five real flight-model GLBs.
- Fixed-input replay: same captured observations through separate old/new
  estimators and display modules, sampled at 60 Hz. UAM0001 backwards frames
  95→0, maximum frame displacement 9.946→0.128 m; UAM0004 105→0 and
  12.260→0.153 m. UAM0005 residual small reverse motion remains: maximum
  reverse step 1.194→0.026 m. Legitimate reverse motion is explicitly tested.
- Replay stopped-frame fractions: 49.19→4.26%, 44.53→0.33%, 46.43→3.34%.
  Additional observation-buffer UTC age at p95 is 2.75/3.13/2.96 seconds in
  this irregular historic capture (maximum 3.25/3.56/3.33 seconds). Smoother
  playback exchanges some latency for stability; it does not eliminate delay.
- Independent live receiver: 100 actual aircraft, original Physical process
  preserved. One 30-second tracked sample had 909 rendered frames, no backwards
  steps, 65 stationary frames, model ready/tracking throughout; p95 frame time
  33.2 ms. This is browser evidence, not a claim of increased rendering FPS.
- Identical 100-record read/estimate pass: 51.64→24.36 ms, byte/value-equivalent
  outputs and raw records unchanged. This isolates copying cost, not the total
  native simulation rate or end-to-end throughput.

## Limits and deployment

Source and network delay remain: three live cruise aircraft had mean accepted
input ages 1.27–1.36 s and maxima 3.93–4.15 s during a separate 35-second capture.
Long outages still hold; arbitrary stochastic noise cannot be exactly inverted
by knowing its distribution. Known deterministic bias calibration retains its
existing same-observation-time interpretation.

Native dynamics, PSU/ground recovery candidates and flight inputs were not
changed or activated. No new Unreal mission execution is claimed. Main receiver
8766 was running a separate Simulation, so reviewed code was installed without
restarting that process. Isolated receiver 8768 demonstrates the new Physical
path while preserving both running simulations. Final activation is recorded
in the development evidence, not inferred from files being installed.
