# 0052 — UAM mission intent prediction and display timing

Date: 2026-09-11
Status: accepted

## Context

UAM predictions previously used observed constant velocity or an aircraft turn
model without the native pilot's route cursor. Native attitude yaw was also used
as the velocity bearing. This loses sideslip and turning motion. The renderer
buffered a 10 Hz scenario by at least 500 ms and rebuilt both forecast primitives
on every rendered frame. Moving only the first forecast vertex to the aircraft
created a sharp rejoin when observation and prediction differed.

## Decision

- Add frozen `PredictionWaypoint` and `UamPredictionIntent` contracts. The
  application captures a state and its intent together under the session lock.
  The native adapter supplies a copied ordered route, its active target index,
  phase and launch-time guidance policy. It exposes the already measured NED
  velocity, including a measured zero, without modifying runtime dynamics.
- Offer `uam_mission_kinematic_v1` only for UAM prediction. Keep the existing
  kinematic baselines and unavailable learned models as separate choices.
  New installations default to this model. Existing preferences are not silently
  migrated; this authorized deployment selects it through the settings API.
- Integrate a bounded kinematic projection from actual velocity. Use observed
  cruise trim, ordered fly-through targets, native departure yaw-alignment dwell,
  approach braking/reversal parameters, target altitude and descent/landing rate
  limits. Preserve the current holding fix; do not predict a future clearance.
  There are at most 300 output points, 240 seconds of requested horizon and eight
  extra seconds for the moving display window. Integration steps are at most
  0.2 seconds; cumulative remaining wing distance is precomputed in linear time.
- Missing or mismatched intent is explicitly labelled as a short, at most
  10-second velocity fallback. These predictions never enter TwinWorld, command
  the pilot, certify separation, or enable the unintegrated learned networks.
- Keep trajectory schema 1 and add optional `epoch`, `continuity_id`,
  `flight_phase` and summary intent fields. Existing clients can ignore these
  additive fields. No complete mission route is broadcast in each snapshot.
- Offload the selected prediction callback to the HTTP worker pool, keeping
  session-lock waits away from the ASGI event loop.
- Adapt scenario display delay from its actual cadence and jitter (120 ms floor,
  40 ms margin; typically 140 ms at regular 10 Hz). Sparse external streams retain
  their prior buffer policy. Native UAM velocity enables slope-limited Hermite
  interpolation strictly between received endpoints, never extrapolation.
- Reuse forecast primitives/materials; blend forecast replacements over 300 ms
  at the same display time. Spread positional residual correction over the near
  forecast while retaining its initial tangent. Apply deck registration to the
  displayed anchor. Refresh UAM at 500 ms, down to a 200 ms floor at higher clock
  rates, with at most one current request in flight. Reject old epoch/phase/
  continuity responses, preserve only valid old coverage on transient failures,
  and retain the final endpoint when reducing point count.

## Validation and limits

The browser lifecycle was measured in both preUpdate and preRender. Both gave
zero measured model-to-display position difference in this Cesium build, so the
existing preRender registration was retained. The lifecycle definitions are in
[Cesium Scene documentation](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html).
The improvement claim concerns display delay, reconstruction and forecast
continuity, not an unmeasured engine frame-order defect.

Eight saved routes were independently flown through the existing native runtime.
All completed; forecasts were compared with future measured states using the
same corrected velocity for the constant-velocity baseline. Cruise endpoint
error averaged 27.55→9.39 m at 10 seconds, 211.21→38.15 m at 30 seconds, and
660.70→81.59 m at 60 seconds. Descent 60-second error averaged 81.13→7.32 m.
These are evaluation cases, not guaranteed accuracy: 10-second descent and
landing errors were slightly worse than the baseline, and some climb errors
remain large. No uncertainty probabilities or real-world flight validation are
claimed. Full numerical evidence, sample counts and input hashes are recorded
under `data/workspace/visualization_checks/2026_09_11_uam_prediction`.

An SSH-child launch was observed to disappear when the connection ended. The
deployment helper now starts a hidden process through WMI outside that SSH job
and explicitly uses the web virtual environment. Only an idle dashboard was
restarted, using its cooperative shutdown event. Routes, plans and source
settings were backed up; only the selected UAM prediction model was changed.

A subsequent launch from base Anaconda reproduced a `ModuleNotFoundError` in
satellite synchronization while HTTP health still reported ready. The launcher
now checks for `sgp4` before any server lifecycle action and delegates the exact
CLI options to the prepared web environment if needed. A missing or incomplete
fallback environment fails clearly without recursion or package-path mixing.
Launcher/restart tests passed (23 cases); a real base-Anaconda invocation reused
the healthy web-environment server successfully after delegation.
