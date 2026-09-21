# Manual en-route autopilot
Date: 2026-09-18

AirTaxi package 0.2.2 changes longitudinal drag to 0.01205; lateral/vertical drag, mass and actuator authority stay unchanged. Native manual v8 and pilot v9 use the shared package. Full manual neutral cruise measures 79.53 m/s, not a forced velocity.

Mission ManualAutopilot derives forward intent from climb/cruise plan segments. The same native runtime remains the physical state owner. Enabling does not reset or advance aircraft state. Bounded heading, altitude and speed control uses existing actuator rate limits. Actual collective drives energy estimation and the cockpit throttle.

Additive C ABI: aerodt_manual_guidance(handle,enabled,heading_deg,down_m,speed_mps); aerodt_manual_collective(handle). Existing signatures remain. Python advertises autopilot_v1 only with the guidance symbol.

Additive manual WebSocket request: type=autopilot, enabled=boolean, request_id. Reply: type=autopilot_ack, accepted, message, sample, matching request_id. Samples carry autopilot {enabled,mode,autothrottle,target_speed_mps,waypoint,message} and actual throttle. Pending requests never optimistically change AP state. Pause/input-gap logic remains authoritative; disengagement is allowed while paused.

NAV MFD AP follows route, altitude and planned speed (28-80 m/s). Entry requires airborne fixed-wing flight, speed >=28 m/s and route within 2 km. Stick deflection >0.18, mode change, slow flight or OFF releases AP. Terminal approach hands control back with notification. Automatic taxi, takeoff and landing are outside this en-route AP; PSU procedures remain applicable.

Validation: 36 Python regressions (AP continuity, turn, speed, altitude, midroute join, handover; manual and automatic native regressions), 31 Node tests (including MFD and correlated RPC), native configuration PASS, native DLL build passed. No full live joystick/browser flight or Unreal validation.
Source/DLL deployed; running backend untouched. Backend restart, browser reload and new manual session required.
