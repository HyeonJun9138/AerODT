# Manual VTOL throttle precision (v11)

Date: 2026-09-21

Superseded by `manual_vertical_hold_v12.md` after the user requested 10% automatic
altitude hold and a 7–13% vertical-speed control band. Retained as change history.

## Decision

Keep the existing approximately 12.36% hover input rather than moving hover to
50% or adding vertical-speed/altitude hold. Apply a monotonic C1 cubic input
curve in the manual bridge before the existing 15 percentage-point/second slew
limit. Its slope at hover is 0.1; the curve rejoins identity at 10% and 36% with
unit slope. Below 10% and above 36% the input is unchanged.

The hover anchor is calculated from the compiled aircraft mass, gravity and
RotorActuator maximum vertical thrust. No aircraft parameters are copied into
deployment configuration. These curve limits are manual lever-response policy,
not new physical model parameters. An unsupported hover anchor falls back to
identity. Actual rotor tilt smoothly blends the curve back to identity between
0 and 30 degrees. Guided/AP throttle bypasses this mapping.

No runtime state, integrator order, actuator physics, ground collision, taxi
behavior, or C ABI schema changes. The applied-collective accessor continues to
report the actuator command, not the raw lever value. The raw lever display is
unchanged. Build v11 separately so an active process can retain v10 safely.

## Operation and limits

Start around 12.5–13% for gentle liftoff. Reduce toward 12–12.3% for fine descent
and anticipate existing vertical momentum. This is thrust control, not a target
vertical speed: attitude, altitude, load and momentum can change the response.
Zero remains motor cutoff, not an automatic soft-landing command. Fixed-wing
control and the high-throttle range retain their previous response.

Restart the backend and begin a new manual session to reliably load v11; a page
refresh cannot replace a DLL already held by a running session. Active sessions
are deliberately not interrupted by this change.

## Evidence

Native before/after measurements and tests are under
`project_support/manual_vertical_precision_20260921`. New regression tests fail
on v10 for gentle liftoff and descent and pass with v11. Actual Unreal flight,
physical joystick feel and repository-required mission validation remain
separate acceptance steps; headless success is not a claim of visual completion.
