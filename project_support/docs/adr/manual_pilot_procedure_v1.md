# Manual pilot procedure projection v1

The previous manual PSU wire conflated `external.departed` (route reservation
and flight adoption) with observed flight and takeoff permission. Cockpit users
could not distinguish taxi permission, slot time and actual takeoff authority.

Retain existing departure/arrival/hold requests and fields. Extend advisory with
`procedure.version=1`, the scenario clock, source schedule/slot times, next pilot
request/report, and a bounded recent communication projection. Null times remain
unknown. Seconds use the flight day's KST clock, not elapsed manual runtime time.
The browser only presents this server-owned projection; stale input cannot
display an actionable permission. `departed` remains its legacy adoption meaning.

Add request kinds `takeoff`, `landing`, `report_airborne`, `report_landed`,
`report_gate`, and `resume_day` on the existing manual request endpoint.
Takeoff rechecks pad position, stopped motion, slot and terminal blockers.
Landing rechecks slot, pad, terminal and gate availability. Reports require
received physical observations and are idempotent. Resume explicitly advances
the entire scenario clock, not just the manually controlled aircraft.

Requests/reports and PSU responses use the existing scenario event recorder with
direction, actor, flight and timestamps. Manual observations reuse resource
release and completion accounting; reports do not move the native aircraft.
This rehearsal workflow does not prevent a pilot from ignoring an instruction.
An arrival slot is not final landing permission. A waiting request without a
holding assignment does not invent a hold position. Full mission/Unreal
validation is separate from Web/native handoff validation.

## Remaining-route ETA projection

`procedure.timeline.remaining_route_eta_s` is the pilot procedure's current
remaining-route estimate. It is the exact observation used with
`arrival_request_lead_s` to decide `arrival_request_due`; the cockpit must not
replace it with an instantaneous ground-speed estimate while this projection
is available. The value includes the configured route-phase speeds, descent
and final vertical landing. The advisory also projects
`arrival_request_lead_s` and `arrival_request_due` so the displayed countdown
and the enabled request control can be audited together.

These fields are additive. Older clients may ignore them and newer clients
fall back to their display-only ground-speed estimate when an older server does
not provide them. The Simulation observes route position and calculates the
estimate; the Pilot procedure continues to own the request trigger. PSU does
not enable the pilot's request control.

## Gate-arrival observation

A manual gate report requires an assigned arrival gate, an accepted landing
report, observed ground contact, horizontal inclusion within 3 m of the gate
centre, and speed no greater than 0.15 m/s. It does not compare the Runtime's
ellipsoid-referenced rendered contact altitude with the generated layout's
local deck height. Those heights use different vertical datums and cannot
establish whether a grounded aircraft is parked at the gate.

The advisory enables `report_gate` only when those same conditions pass. While
they do not, it reports the specific missing condition and, where applicable,
the horizontal distance or observed speed. The POST request repeats the checks;
the browser cannot manufacture a completed arrival by enabling a button.
