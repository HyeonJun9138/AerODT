# Initial manual departure priority

When manual ownership is assigned, select the route and reserve its arrival
forecast immediately rather than at the first pilot departure click. This also
applies after the day has started. Aircraft which are already taxiing or
airborne are never pre-empted; the priority is considered only when another
parked aircraft tries to start. Native forecast preparation runs asynchronously
as before; while unfinished, later flights targeting that arrival pad yield.

For 120 simulated seconds from max(assignment, planned off-block, readiness),
new automatic departures at the same origin yield to the selected manual
aircraft. The operator still requests taxi permission. If that request is
submitted during the 120-second opportunity, its queue claim survives expiry
until it is granted or explicitly cancelled. Assignment does not grant
taxi/takeoff, bypass physical blockers or move the aircraft. Other origins may
operate normally subject to shared resource checks. Already started flights are
never preempted. Releasing manual ownership removes opening priority. Without
a submitted request, expiry releases the unused forecast too.

Cancelling a submitted request removes that queue claim and its arrival
forecast, but it does not mean that the pilot has waived whatever remains of
the original 120-second offer. A new request inside the still-open offer can
claim priority again. Releasing manual ownership removes the offer itself.

When a reserved ground-release time matures, a stale forecast belonging to an
aircraft which is still parked cannot move that reservation to the back again.
Observed taxiing and airborne traffic remains authoritative and may still delay
release. A simulation tick that lands just after the promised time does not
rewrite the recorded reservation time.

Ground movement which started later at another origin is not automatically an
earlier arrival. If that aircraft has a metered entry booking behind the mature
manual booking and is not airborne, it keeps the later booking and cannot
reverse the queue merely by taxiing. Once airborne, its observed ETA is traffic
and remains authoritative.

The source plan is immutable. Existing actual pad/terminal occupancy and
arrival backpressure remain authoritative. No wire field additions; procedure
text identifies the opening opportunity. Restart and a fresh manual assignment
are needed; active sessions are not silently reordered.
