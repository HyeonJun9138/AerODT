# 0048: Directional right lanes and anticipatory fly-by guidance

Date: 2026-09-11

## Context

Restoring the supplied waypoint order removed the invented direct flights, but
the shared native pilot still pursued a distant vertex until late in a turn.
Its independent yaw and velocity-vector slew could also erase commanded speed
while yaw was already changing. The user wants right-hand cruise traffic and
smooth turns through intersections without unnecessary reverse tilt. The user
clarified that 150 m is a preferred lateral passage allowance, not a fixed
turn-start distance and not a hard constraint that should force a turn-back.

## Decision

- Keep physical state exclusively in `UamVehicleRuntime`. `RoutePilot` changes
  only its goals and ordered progress. Do not replace observations with a
  drawn curve, teleport an aircraft, or change the FastPhysics execution order.
- Retain the scheduled route's directional right-offset geometry. Its default
  is now 75 m, capped at one quarter of corridor width (75 m for a 300 m
  corridor). Merge over 300 m only at cruise entry/exit; interior junctions
  keep their bounded miter offset. Source coordinates and heights are unchanged.
- Project onto the active ordered segment and look ahead along consecutive
  winged segments. Preview uses observed speed, with extra bounded lead for
  sharper bends. Lateral-velocity damping helps recapture the outgoing lane.
  There is no globally nearest-WP search that can jump to a crossing branch.
- Use a 150 m default passage preference in both native entry-point adapters
  and the pilot decision chart. A bounded corner bisector allows a wider
  fly-by when needed. Short legs cap capture, and departure alignment must
  finish before consuming the first winged point. Precision hover, terminal
  approach capture, landing alignment and settled touchdown are not relaxed.
- Preview braking far enough ahead to account for the commanded speed ramp.
  Retain the corner speed until established on the outgoing leg. Turn speed
  has a margin above the configured wing recovery speed; the planned speed
  remains an upper bound. Do not enter reverse transition just because a
  waypoint is a corner. Existing stall recovery and approach reversal remain.
- Slew scalar horizontal speed separately from commanded heading during
  winged flight. Opposite velocity vectors must not cancel commanded airspeed
  in the middle of a turn. This is mission guidance, not a replacement mixer.

## Contracts and scope

The existing C ABI 2, six-column waypoint input and tuning array do not change.
The default route capture semantics change; explicit operator settings remain
supported. The policy chart describes 150 m as a preference, not a safety fence.
Both single runner and fleet bridge use the same native guidance. Scheduled
right-lane geometry remains in the existing fleet route preparation path;
this change does not rewrite the single-plan editor's source path or datums.
No traffic separation, right-of-way or intersection reservation is inferred
from visually distinct lanes.

## Validation and limitations

Tests exercise both turn directions, S bends, a self-crossing ordered route,
departure alignment, relaxed passage, unchanged touchdown, single/fleet output
parity and deterministic incremental delivery. The QA tool records actual
native observations and a near-hairpin stress case rather than smoothing the
error away. A sharp turn may temporarily leave the preferred right lane.
Neither the 150 m preference nor a corridor boundary is a certified constraint.
These are headless reference-AirTaxi results, not manufacturer-specific model
validation, collision assurance or an Unreal execution sign-off. Run results
and deployment evidence are recorded in the development log separately.
