# UAM cockpit implementation plan

Spec: `2026_09_14_uam_cockpit_design.md`, user approved 2026-09-14.
Execution: subagent-driven-development. No new approval between tasks.

Ruling: Keep the current codex/visual-asset-library workspace and preserve all existing changes. It holds the approved working assets and pending features; a clean worktree would omit them. No commits, service restart, remote deployment or unrelated cleanup in this task. Task scratch and ledger live under project_support/cockpit_work, not a new root folder.

## Contracts

- Asset metadata `cockpit`: schema_version=1, eye=[x,y,z], forward=[1,0,0], up=[0,1,0], passenger_seats, screens[{id,center:[x,y,z],width,height}], interior/model source description. All positions in the flight GLB's authored +X forward/+Y up frame before display scale. Camera converts [x,y,z] to [x,-z,y], applies scaleOf(assetId), then item model matrix. Validate against actual renderer.
- Static cabin seats and glazing belong to model library. Visual-only, no physics changes. Existing KP2 glazing retained as reference. Default capacity follows existing model schedule; selected plan capacity may override display seat count when available.
- Camera class `CockpitCamera(C,viewer)` with enter({entityId,profile}), update({matrix,scale,now,epoch,continuity}), look(dx,dy), zoom(delta,deltaMode), resetLook(), exit(), destroy(), active. Parent connects displayed item matrix, selected entity and input routing.
- Instrument class `CockpitPanel({document,onExit,onReset})` with open(), update(state,now), close(), destroy(). Own DOM/SVG instruments and read-only controls. Expose root for parent positioning against screen anchors. Does not fetch or own state.

## Tasks

- [ ] Assets: tests first for glazing-only changes, unchanged exterior geometry/rigs, seat counts and finite per-model eye/screen coordinates; reproducible GLB tool and metadata; actual render views saved under project_support/cockpit_work. Own visual assets/tools/tests only.
- [ ] Camera: standalone camera/input math and tests first for fixed eye, FOV clamps, pose transforms, reset/restore, discontinuity. No globe/app edits by worker.
- [ ] Instruments: standalone live PFD/NAV/SYSTEM readouts and tests first, missing/stale fields explicit, bounded updates, display-only interaction. No app/globe edits by worker.
- [ ] Parent integration: asset catalog exposes metadata, selected-view buttons, plane anchoring, camera routing in globe tick, sound selection preserved, no pilot commands. Add integration regressions before implementation.
- [ ] Review: independent task and combined code review, fix defects, run focused suites and actual render evidence. No visual-success claim without actual render.
- [ ] Record CURRENT/HISTORY, ADR for metadata addition, remaining limits and deployment state. Keep user worktree and artifacts.
