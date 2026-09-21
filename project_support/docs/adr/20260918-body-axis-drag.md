# Optional body-axis drag coefficients in model packages

The AirTaxi scalar body drag yielded 44.483 m/s at full native manual throttle,
despite the operating plan's 130 kt (66.878 m/s) cruise. This is a physical
thrust/drag equilibrium, not a UI throttle limit. Raising thrust or globally
lowering drag also changes hover and vertical landing response.

The root aerodynamic configuration accepts optional `drag-coefficient-body-xyz`:
three finite, non-negative numbers, for the body's longitudinal, lateral and
vertical drag faces. Omitted values preserve the scalar coefficient on all faces.
Compiler validation rejects malformed arrays; the JSON schema describes the field.
The runtime and wire contracts are unchanged. Both native controllers use the same
compiled model package; there is no manual-only velocity multiplier or pose edit.

AirTaxi package 0.2.1 uses [0.01728, 0.04, 0.04]. The longitudinal value is an
empirical calibration of this simulation model to the operating target, not a
measured aircraft coefficient or real-world performance validation. Rotor thrust,
mass, lift, lateral/vertical drag, throttle slew, ground assistance and contacts
are retained. At full power, neutral stick settles near 66.59 m/s while climbing;
pitch input -0.4 gives 66.85 m/s with vertical velocity -0.14 m/s. Manual flight
still requires pitch/altitude management; this does not add an autopilot.

Deployment uses manual library v6 and pilot library v8 (pilot ABI stays 7) to avoid
overwriting binaries loaded by current sessions. Restart the backend and create
a new manual/day session to load them. Old fallback binaries retain old tuning.

Tests cover cruise, deceleration, transition, landing, directional preservation,
legacy scalar compilation, invalid coefficients, existing manual taxi/deck tests,
and automatic native multi-flight/approach/terminal tests. Live joystick/browser
flight and Unreal have not been validated.
