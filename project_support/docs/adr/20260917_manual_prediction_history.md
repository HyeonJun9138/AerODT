# Manual-session prediction through the existing run prediction endpoint

Status: accepted for web simulation integration.

The existing /api/simulation/runs/{run_id}/prediction GET/POST contract now also resolves active manual run IDs. Request/response fields and recorded-flight behavior are unchanged. Ended manual sessions are removed and resolve as unknown. The client no longer suppresses manual forecasts.

Data owns a bounded, lock-protected copy of actual native observations (45 seconds, at most 4096 rows per active session). Communication appends accepted observations and removes them at socket cleanup. Prediction reads a snapshot in a worker thread; inference never blocks the physics step or owns a runtime. It never reads future recorded positions.

A manual operator has no authoritative autonomous target index. Learned route-conditioned forecasts therefore use a geometric reference segment from the prepared plan, explicitly marked as an assumption in existing input_quality and path summary notes. This reference is not a pilot command or asserted active mission intent. Observed altitude is never replaced with planned/display altitude. Missing route/model/history remains unavailable/warming_up, not a fabricated path. The normal ground-phase visibility policy is retained.

UI inference time comes from received native telemetry, not interpolated presentation frames. Epoch invalidation still applies to stop, rewind, stage and settings changes.
