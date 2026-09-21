# Manual vertical-speed and altitude hold (v12)

Date: 2026-09-21

## User-approved contract

Supersedes v11 throttle grading. The user explicitly requested 10% automatic
altitude hold with fine ascent/descent distributed over 7–13% lever travel.
Airborne manual VTOL uses 9.8–10.2% as a neutral noise band. Returning there first
brakes vertical motion with an acceleration-limited speed command and captures
altitude once nearly stopped; it does not teleport back to the entry altitude.
7% requests 0.6 m/s descent; 13% requests 0.8 m/s ascent. The interval outside
neutral is linearly graded. These are target speeds, not kinematic constraints.

The application maps lever input to desired vertical speed. The SimpleFlight
ManualVerticalController owns only command/filter/integral/hold-target memory,
reads runtime observations and outputs collective. Aircraft state remains owned
by runtime; the integrator, actuators, collision law and tick order are unchanged.
Vertical PI gains, position gain, acceleration and speed limits live as optional
MANUAL_Z_* parameters in the AirTaxi model package. Absent parameters disable
the feature. Typed parameter loading rejects negative/nonfinite values and
incomplete enabled configurations. Model JSONC schema is unchanged; these are
additive parameter-map keys. The C++ parameter type changes require recompiling
all dependent objects; the external C ABI is unchanged.

## Boundaries and safety behavior

- Neutral/below on the ground, including the first runtime tick, stays idle;
  automatic takeoff requires input above the neutral band.
- Grounded contact resets assistance to prevent landing integral windup or bounce.
  Ground-assist snapping is disabled while vertical assistance is active, so a
  controlled landing uses actual surface contact, including raised decks.
- 4–7% and 13–20% smoothly blend assisted thrust with direct collective. At/below
  4% and at/above 20%, direct collective is retained. Zero remains motor cutoff,
  not automatic landing. The existing collective slew limiter remains active.
- Actual rotor tilt 0–30 degrees smoothly fades assistance out; guided/AP input
  bypasses and resets it. Manual attitude inputs remain available during hold.
- Hold is not guaranteed outside available thrust/attitude authority. Braking
  from a large vertical speed requires altitude and time.

## Deployment and evidence

Build a separate aerodt_uam_manual_v12 library; Python prefers v12 while retaining
older-library fallback. An active old process/session is not forcibly replaced.
Restart the backend and start a new manual flight for reliable activation.
The planning-screen explanation is updated to match the new behavior.

Tests and native measurements: project_support/manual_vertical_hold_20260921.
Coverage includes graded speed, neutral capture after ascent/descent/high power,
lever jitter, attitude changes, ground idle, landing and relaunch, elevated deck,
zero cutoff, tick batching, and existing cruise/AP/taxi regressions. Actual
Unreal, joystick feel, live server activation and full UAM mission acceptance
remain unverified; native tests do not substitute for those acceptance steps.
