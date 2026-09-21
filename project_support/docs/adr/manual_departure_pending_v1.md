# Persistent manual departure request (2026-09-18)

The existing scenario manual `departure` request now remains pending after a
HOLD response. Repeating it does not reset its first request time or arrival
admission order. The simulation services pending requests once per simulated
second, before new scheduled departures, using the existing resource checks.
Only a current manual position can receive an automatic taxi clearance. No
control input, pose, takeoff clearance or landing clearance is manufactured.

An earlier unstarted arrival forecast protects its earliest currently possible
touchdown, not a stale historical timestamp. Actual active traffic overrides
forecasts and occupied resources continue to block release. This prevents new
departures from consuming an older waiting aircraft's gap; it does not promise
a fixed release deadline through an indefinitely occupied resource.

Existing `hold` cancels a pending ground departure and releases its uncommitted
forecast/PSU reservation. With no pending ground request it retains its existing
airborne meaning. Pending work stops with manual ownership. No wire fields were
added: procedure stage/text/reason/next and existing communications convey the
result. Periodic PSU decisions log only changed responses, never synthetic pilot
requests. The GUI keeps request failures until explicit refresh and labels the
countdown as a review time, not permission to move.

Backend process restart is required. Do not hot-reload or restart an active
user flight to apply this change. Native congestion regression is useful
evidence, not full manual-flight or Unreal validation.
