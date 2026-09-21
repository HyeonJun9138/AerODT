# Cockpit hardware rendering and POV calibration

Date: 2026-09-17. Accepted for the web visualization/input boundary.

CockpitThrottle and CockpitStick are cabin-attached Cesium primitives. Placement derives from authored NAV screen axes/dimensions and displayed model matrix/scale. They visualize existing manual commands; physics state remains runtime-owned. Dragging uses existing application control callbacks. Geometry is allocated on profile entry and removed on exit, with matrices updated before drawing alongside the cockpit camera, not one frame later in postRender.

The browser-local joystick profile version 1 gains optional view.kind=hat and view.hat={axis,neutral,values:[up,down,left,right]}; legacy buttons/axes mappings remain valid. Four observed direction presses replace guessing adjacent button/axis indices. Missing axis yields neutral. New held view_up/down/left/right actions are allowed. Calibrated direction buttons relinquish conflicting flight actions. No server wire schema or aircraft model package changes.

CockpitView now exposes look/resetLook forwarding to the existing cabin camera. Paused polling is limited to camera and resume actions and emits no flight command. The actual connected joystick still requires operator calibration; automated tests use deterministic Gamepad-shaped input.
