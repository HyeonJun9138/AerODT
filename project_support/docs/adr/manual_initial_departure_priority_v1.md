# Initial manual departure priority

When manual ownership is assigned before any flight has started, select the
route and reserve its arrival forecast immediately rather than at the first
pilot departure click. Native forecast preparation runs asynchronously as
before; while unfinished, later flights targeting that arrival pad yield.

For 120 simulated seconds from max(assignment, planned off-block, readiness),
new automatic departures at the same origin yield to the selected manual
aircraft. The operator still requests taxi permission. Assignment does not
grant taxi/takeoff or move the aircraft. Other origins may operate normally
subject to the shared resource checks. Already started flights are never
preempted. Release/cancellation removes opening priority. Without a submitted
request, expiry releases the unused forecast too; with a pending request its
normal admission order remains protected.

The source plan is immutable. Existing actual pad/terminal occupancy and
arrival backpressure remain authoritative. No wire field additions; procedure
text identifies the opening opportunity. Restart and a fresh pre-play manual
assignment are needed; active sessions are not silently reordered.
