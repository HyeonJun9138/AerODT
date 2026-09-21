# ADR 0080: Physical execution, publication and recording isolation

- Date: 2026-09-13
- Status: Source installed; production restart pending.

## Decision

Keep a single ordered fleet operational authority and the existing per-aircraft native instances. Run the complete calculation/sensor step through the cancellation-safe worker; publish completed pending packets independently and checkpoint historical operations through one background writer. Await owned work at shutdown. Expose an optional `--physics-workers` integer from 1 through 8 without multiplying world ownership or PSU scheduling authorities.

Overload rebasing preserves pending packets and their original measurement/sent timestamps. Only future generation mapping is rebased. Latest-only HTTP delivery remains a coalesced view; ordered bounded history remains separate. Index the existing immutable raw packet log by aircraft, evict indexes with their owning records, and copy public results outside its lock. Index only new operational events and per-observation recent flight events.

Reuse exact geometric conflict intervals using packed per-segment unions within the existing bounded cache. Conservative bounding rejection must never reject an exact conflict. Stream historical JSON by top-level records while preserving atomic replacement, size limits and immutable public ownership.

## Additive external fields

Physical packets may include `published_time`, a finite UTC epoch timestamp captured when the completed packet is made available. It does not replace measurement time or `sent_time`. The receiver validates it and uses it to separate source age from estimated post-publication transport age; older packets fall back to their previous sent-time interpretation. Different host clocks still limit transport estimates.

Physical status adds `performance`: bounded recent step count, target step duration, step mean/p95, calculation and sensor mean durations, physics worker and native instance counts, pending packet count, and checkpoint-running flag. These describe host execution and are not flight safety or network delivery guarantees.

## Evidence and limits

Same-input 100-aircraft HTTP trials improved physical/wall progress from 0.513 to 0.988 with overload rebases 47 to 1 in about 45 seconds. Same-input normalized native/sensor/operational digests match across tested worker modes. A 24.6 MB checkpoint improved from 2.143 to 0.260 seconds with identical restored JSON. Remote regression tests: 250 passed. Architecture check: PASS.

The measured workload does not prove full-day liveness, zero jitter, or successful Unreal mission validation. Production source installation does not activate existing Python processes. Restart discards the current in-memory fleet state and must be coordinated with the operator. See `data/development_log/evidence/2026_09_13_physical_performance.json` and the workspace `project_support/physical_performance_work/REPORT.md`.
