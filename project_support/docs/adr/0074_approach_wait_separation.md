# ADR 0074: Final-ETA traffic wait must have a checked separation action

Date: 2026-09-13
Status: implemented; running Physical process requires restart to adopt it

## Evidence

Physical reported 100 aircraft, 88 airborne, 83 holding and 877 completed
sorties. These counts overlap: holding is a subset of airborne. Recorded
instructions showed UAM0013/UAM0041 at VP007 (봉천) and UAM0025/UAM0052 at
VP011 (천호) waiting for each other. Three committed arrival reservations
also prevented ground departures. Stands and taxi exits therefore remained
blocked while unused FATOs could not drain the queues.

TrafficAwareness correctly assigned a leader `wait_clear` and a follower
`yield`, but ScenarioEngine treated a remaining ETA below `final_guard_s`
as a reason to keep the follower's hold goal at its current position. That
is distinct from the native pilot actually committing to vertical landing.

## Decision

- Keep current physical state in native runtime. The application generates
  bounded level separation candidates; the engine supplies observations,
  validates terrain and issues the existing hold goal contract.
- Only a stopped airborne follower with explicit native
  `landing_yaw_mutable=True` can receive a new separation goal. Unknown native
  capability, missing terrain, unsafe alternatives and committed landing
  remain stopped. No reservation is released based merely on elapsed time.
- A candidate is 1.5 times the configured horizontal traffic distance away.
  Check its whole horizontal segment against other observed aircraft, their
  velocity sweeps over the traffic lookahead, and existing separation goals.
  An existing close encounter must diverge from a stationary neighbour;
  do not introduce another crossing. Keep altitude constant, sample terrain
  along the segment and retain the configured vertical margin above terrain.
- Recheck traffic during movement. A newly obstructed transfer brakes at the
  observed pose. Require arrival at the separation goal and low speed before
  releasing that manoeuvre. Existing PSU approach, pad and taxi-exit checks
  still control route re-entry and landing.
- Failed candidate searches retry at most once every two scenario seconds.
  Do not emit a new hold event for every unsuccessful tick.

## Compatible diagnostic additions

Existing extensible event dictionaries add `approach_separation` (traffic ID,
target, reason) and `approach_separation_stopped`. Arrival decision records
include `traffic_id`, `traffic_action`, and `separation_active` so the cause
of a hold is auditable. Parked aircraft expose `departure_wait` and blocker
IDs through the existing instruction dictionary. No API route, packet
version, native ABI, pose ownership or phase enumeration changes.

Physical console distinguishes airborne/holding/ground counts, groups current
wait reasons and destinations, shows maximum per-sortie accumulated hold,
and identifies mutual traffic wait chains from observed instructions. These
are read-only diagnostics, not proof that an automatic escape is feasible.

## Validation and limits

The regression creates the measured approximately 84 m horizontal / 44 m
vertical pair and a follower ETA below 45 s. Before the change neither flight
completes in 2,000 scenario seconds. Final code completes both in 385.9 / 388.4 / 389.0 seconds with 0.1 / 0.2 / 1.0 s
control steps. Minimum sampled distance is 94.825 m; maximum 0.2-second movement
is 1.990 m. Sub-metre altitude tracking error does not cancel the level goal;
no separation manoeuvre is aborted in this fixed-obstacle fixture.
Existing terminal claims and pads are released after actual completion.
Separate tests reject committed landing, third-aircraft crossings, conflicting
transfer reservations, unknown terrain and an intervening hill.

This is simulator recovery from an already deficient traffic margin. The
linear swept-volume check is conservative guidance screening, not a proof
of all future manoeuvres, obstacle/building clearance or continuous full-fleet
separation. The 100-aircraft replay uses a frozen schedule and native physics;
its stated time window must not be presented as validation of a whole day.
Actual Unreal validation was attempted through the configured launcher but
the host rejected its unsigned PowerShell script. Execution policy was not
changed. See the task evidence for final test/replay and deployment status.
