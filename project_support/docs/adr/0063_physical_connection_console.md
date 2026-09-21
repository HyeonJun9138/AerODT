# ADR 0063: Physical connection settings and authenticated Twin source selection

The Physical console exposes a separate Connection PC tab. A deployment template
has empty host, account and key fields; workstation preferences are stored by
Data in `data/workspace/physical_uam/console/connection.json`. Key material is
neither copied nor returned. Only its local path is shown. The desktop launcher
starts the publisher; its owned SSH child is now managed by the application.

Transport remains HTTP/JSON over TCP, carried in an authenticated SSH reverse
forward. By default the Twin pulls `127.0.0.1:18770`, which forwards to Physical
`127.0.0.1:8770`. Sensor bundles are published at 10 Hz and polled approximately
every 0.1 seconds. Twin web port 8766 is distinct. A second SSH local forward,
bound to an ephemeral loopback port, reads the Twin API and applies its source.
Both forwards use one SSH session. Host key verification and public key
authentication remain required; there is no password or shell command field.

Communication owns SSH argument validation, process lifecycle and HTTP requests.
Application owns operator preferences, retries and diagnostic composition; Data
owns persistence. This change does not add aircraft state or alter flight laws.

New publisher routes: GET `/api/v1/console/connection`, POST that path followed
by `/connect`, `/check`, `/disconnect`, or launcher-only `/suspend`. They require
loopback clients and mutations retain the existing same-origin check. Connect
validates before disrupting an existing link and applies the source only on
explicit operator action. Failure preserves preferences and attempts to restore
the old owned tunnel. Disconnect also disables auto reconnect; suspend closes
the child without changing the next-start preference.

New Twin route: PUT `/api/live/uam/source`, accessible only from loopback clients
(including the authenticated SSH local forward), with same-origin protection.
It accepts only an HTTP loopback URL and an unprivileged port, and persists in
`data/workspace/settings/physical_uam.json`. This overrides the initial deployment
`physical_uam_url`. An in-flight result from a previous source generation is
discarded before clock adjustment or sensor ingestion. GET `/api/live/uam` adds
the active `source_url` for diagnosis; existing consumers remain compatible.

A connected SSH process is not proof of reception. The GUI checks the remote
Twin API, the observed publisher process ID and the latest measurement age.
Paused flight, disabled UAM reception, Simulation mode, another publisher or old
observations are not labeled as this publisher's current reception. Automatic
reconnect restores transport only and never overwrites another operator's Twin
source selection.

Validation: input rejection, loopback enforcement, key argument boundaries,
old-source response rejection, source persistence, fresh publisher identity,
failed-apply recovery, and launcher suspend vs persistent disconnect. Actual
Windows GUI and SSH test changed the remote sensor port and restored it, with
the same native mission continuing; public source changes were rejected.
Unreal and new flight-physics validation are outside this connection change.
