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
