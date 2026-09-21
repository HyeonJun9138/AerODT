# UAM control surface display telemetry (2026-09-17)
Status: accepted; additive display contract.

## Problem
Surface visualization used aircraft attitude proxies gated by tilt and speed. Manual and automatic presentation need the same native actuator observation, independent of camera mode.

## Contract
Optional control_surface_deg is an immutable four-value tuple internally and a four-number JSON array on the wire: left aileron, right aileron, elevator, visual yaw demand, all degrees. First three come from the common AirTaxi runtime actuator outputs. Fourth is 20 * controller yaw * allocation blend: the common model has no physical rudder actuator. These are representative shared-runtime outputs, not aircraft-specific Joby/KP2/AMV actuator measurements.

Native manual v4 and pilot ABI 7 add read-only, capacity-checked accessors. Existing 13/17-value state arrays retain their ABI. Runner v2 appends four optional state columns and leaves its old prefix unchanged. Python accepts old libraries and records without the field.

TwinEntity stores a tuple to preserve frozen/hashable prediction inputs. Manual observations are recorded and sent through the existing session. Automatic scenario states and batch runs carry the same field. No controller, mixer, physics or actuator dynamics change.

Only Joby S4, KP2A and AMV flight rig metadata opts into native_actuator_with_visual_yaw. Native roll uses (right-left)/2, pitch uses elevator, yaw uses the disclosed visual demand; existing authored hinge mixing and 20-degree limits apply. Actual angles are not suppressed by speed/tilt. Missing or invalid data uses the existing, explicitly non-measured attitude proxy. Native channels interpolate without extrapolation and clear on missing/reset samples. NASA/X57 rigs remain unchanged.

The AirTaxi mesh has ducted rotor geometry and no separate conventional wing/tail control surfaces; no fictitious ailerons are cut into its cabin. Its existing rotor/tilt rig remains.

## Validation
Native manual 750 steps and automatic 1200 steps compare old/new state arrays exactly (max difference zero). Actual telemetry is finite and nonzero. Three current turnaround GLBs attach all 16 surface nodes; roll/pitch/yaw, neutral restoration, paused stability and manual/fleet paths verified in Cesium. Existing cabins and meshes are preserved.
