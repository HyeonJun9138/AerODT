# 0084 — Cabin viewpoints and read-only plan guidance

2026-09-14. Accepted for web visualization.

The optional cockpit schema v1 now accepts `viewpoints` (id, label, authored eye,
occupant_node), `occupant_nodes` and `occupant_default_scale`. Coordinates follow
the existing flight GLB scene before display scale. Older profiles remain valid
and provide pilot / rear look only. The bounded metadata hydration refreshes old
in-memory catalog profiles and uses the verified flight asset hash for caching.

Dashboard and pedestal are rounded mesh surfaces. The three unconnected decorative
Cabin_key blocks are removed. Existing exterior nodes, transforms and rigs remain
unchanged. Seated figures are optional layout illustrations: initially tiny and
hidden on entry, expanded only on explicit preview action, hidden for the user's
selected seat, restored on exit. They do not represent passenger counts or modify
flight mass, occupancy, physics or recorded state.

Cockpit yaw wraps through 360 degrees. Passenger views use authored seat eyes and
the same displayed aircraft transform. CSS instruments hide in passenger views,
because they cannot correctly depth-test against intervening seat geometry.

Navigation draws only resolved supplied flight-plan points. An explicit named next
waypoint wins; otherwise a labeled nearest plan segment is a geometric reference.
Runtime pilot waypoint_index is not reused because its expanded path has different
indices. No invented direct leg bridges missing points. HOLD and stale samples
suppress the heading cue. This is display guidance, not a clearance or autopilot.

Validation is scoped to browser behavior, geometry and web regression. No new
native mission or Unreal validation is claimed.
