# Aircraft and boarding-person display scale (2026-09-17)

The acquired files and runtime physical state remain unchanged. `visualModelScale`
converts the flight rig's measured extent to its declared display extent in the
single/manual FlightLayer and EntityScene (scheduled/Physical). Cameras consume
the loaded primitive's `scale`; missing primitives use the corresponding flight
variant's conversion. Distance never enlarges the model's physical metre scale.

The 2/4/6/8 passenger classes are representative simulation classes, using
different borrowed visual assets, not manufacturer-certified configurations.
Their new display spans are 10.8/12/13.2/15.8 m. These must not be advertised as
manufacturer dimensions, used to infer payload, or silently fed into physics.
For example, [Joby's manufacturer page](https://www.jobyaviation.com/technology)
describes a pilot plus four passengers; the simulator's two-seat visual class
is consequently not the actual Joby seating specification. Exact cabin and
certified facility-clearance validation requires corresponding engineering data.

Kenney human assets retain `model.glb` byte-for-byte. Their `asset.json` `model`
entry now selects a reproducible `boarding_model.glb`; optional `original_model`
retains the acquired path/hash/byte size. The existing visual catalog API remains
schema version 1 and resolves the usual `model.path`. No new endpoint or wire
field is required. Authorship, license, walking animation and the 2.7-file-unit
height convention remain; only illustrative proportions change. Rendering at
1.75 m gives approximately a 0.60 m overall body width and 0.25 m head height.

Verification: 150 browser-unit tests, 6 geometry/catalog Python tests, and a
real Cesium before/after scene using FlightLayer and PassengerBoardingLayer.
Full multi-aircraft operating-session and actual Unreal checks were not run.
Evidence: `data/development_log/evidence/2026_09_17_aircraft_render_scale.json`.
Review scene: `/static/_aircraft_scale_review.html` (no simulation commands).
