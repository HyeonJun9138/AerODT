# Manual cockpit ground handling, wire capability v1

Accepted: 2026-09-17. Applies to the web manual simulation sandbox.

The connection-owned native runtime remains the sole aircraft pose/contact owner. ManualGround in the mission layer owns a ground procedure, using native sample time, rendered/validated contact decks, the saved arrival gate and facility geometry. Visualization projects immutable snapshots; it never starts its own procedure timer or changes aircraft pose. Manual sessions do not join the shared PSU, so a plan is explicitly labelled as a plan. Shared simulations display the matching aircraft clearance when present.

## Additive wire extension

`ready.capabilities` includes `ground_handling_v1`. Clients without it continue existing flight controls. A capable client may send `{type: "ground", action: "disembark" | "release", request_id: string}` (1–80 characters). Replies are `{type: "ground_ack", request_id, accepted, message, sample?}`. Request IDs are idempotent within a bounded 64-entry per-session window; this command does not consume flight-control sequence numbers. Paused/stalled input rejects ground requests. Ground replies do not release flight transport in-flight slots.

`sample.ground_handling` is additive. Idle reports `phase`, `available`, `reason`, `locked`. An accepted operation also reports `start_s`, `elapsed_s`, `vertiport`, `gate`, `position`, `heading_deg`, `door_side`, `door`, `door_open`, `walk`, `crew_path`, `crew_walk_s`, `crew_start_s`, `charge_at_s`, `socket`, `charger_id`, optional `release_s`, `passengers_remaining`, and a presentation label. Positions use existing longitude/latitude/metres and sample time seconds. A walk may include `path_altitudes_m`, one height per route point. Old boarding routes omit it and retain the existing deck-height projection.

Disembark is accepted only grounded, within 0.15 m/s, neutral axes, throttle zero, rotor speed <=2 rad/s, near the saved arrival gate centre and within 1.5 m of a validated deck top. The procedure advances opening → alighting → connecting → charging (or complete without a charger). Release disconnects then closes the door, after which controls unlock. Both mission and client clamp propulsion/taxi inputs during the procedure. Native time stops on pause; visual progress stops with it. Seat count remains zero after unloading/release. Charge power/capacity use existing plan metadata and a disclosed representative estimate if absent.

## Visual model extension

`asset.cockpit.ground_door` describes left/right node names, model-scaled forward/right/height offsets, and opening angle. `flight_visual.path` selects a new `turnaround_model.glb`. The reproducible builder splits illustrative side hatch surfaces out of the existing cabin rig; original `flight_model.glb` and acquired models are preserved. Closed bounding extents, surface area, animations and node names are checked for all five rigs. Hatches, stairs, passenger walks, worker and cable are illustrative operations visuals, not certified aircraft geometry, a crowd physics model or a hardware charging protocol.

## Validation and limits

Web/native verification is recorded in `data/development_log/evidence/2026_09_17_cockpit_ground_controls.json`. Full UAM validation/Unreal completion is not claimed: this checkout lacks `project_support/tests/validation` and Unreal was not run. No changes to shared PSU scheduling, native force integration or contact resolution.
