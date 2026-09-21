# ADR 0073: Live sensor clock recalibration and bounded reconnect scope

Date: 2026-09-12. Status: accepted.

## Evidence

The receiver retained the initial PC clock offset +1.260 s while three new
status probes measured -1.984 s (best RTT 0.030 s). In the same 300 packet
sample, the fixed mapping rejected 171 packets as future values; the measured
mapping accepted all 300. Four small detail reads over 35 seconds showed only
3–4 packet changes per airborne track and raw observation ages up to 24 seconds.

A receiver restart exposed an independent startup problem: absent a camera
report, the application propagated and serialized all 16,507 saved satellites.
The view reporter never resent a stationary camera after server state was lost.

Physical emulation also rebases future UTC sample stamps after host overload,
while physics progresses only through completed steps. Velocity is measured
per physics second. Comparing movement against the larger UTC interval
mistook scheduling pauses for unobserved flight and rejected valid fixes.

## Decision

- Probe the source PC clock every three seconds using the fastest of three
  small status requests. Periodic probes are independent of the four telemetry
  pulls; only the initial handshake waits. Keep a working calibration on probe
  failure, cancel obsolete source probes, and reject probes spanning a local
  wall-clock discontinuity. Ordinary RTT jitter that still contains the old
  offset in its interval does not retime observations.
- Translate the World-owned posterior's UTC coordinate values together when
  the accepted mapping changes. Preserve pose, covariance, parked references,
  sample identity and candidate counts. A held GNSS/AHRS sample is not another
  measurement. Raw packet history is unchanged. Public status adds optional
  clock offset/uncertainty/probe-time/correction diagnostics; internal posterior
  fields stay out of the public entity wire.
- Use the existing optional sensor `sample_monotonic_s` for the prediction
  interval used to test and assimilate successive GNSS fixes. UTC still owns
  freshness, expiry, the operator's 2 s coast limit, and public observation age.
  Missing, nonadvancing or inconsistent motion-clock intervals fall back to
  UTC. Validate the optional numeric field at the wire. This does not rewrite
  measured velocity, change physical speed, alter PSU/pilot rules or grant a
  longer unobserved projection.
- When satellite view following is enabled and no viewport has arrived, use
  the configured operating bounds. A real global view and disabling view
  following still request the full catalogue. Resend an unchanged viewport
  at most every 15 s with one request in flight; HTTP errors remain retryable.
  After background work yields, refresh the UAM target time before estimation.

## Validation and limits

Clock drift, held observation, parked lock, failed/cancelled probes, overload,
bad fixes, expiry and public wire regressions are included. A 240-fix identical
overload replay rejected 235 fixes before and 0 after this change. It is a
deterministic regression, not a claim about every real sensor trajectory.

The sender remains a CPU-limited emulation (~0.67 real-time factor in this
session). This change does not promise real-time native physics or invent
motion through a true long outage. Source rules, native binaries and Unreal
inputs are unchanged; prior native/actual Unreal evidence is retained and no
new Unreal execution is claimed. Final live measurements are recorded in
`data/development_log/evidence/2026_09_12_live_clock.json`.
