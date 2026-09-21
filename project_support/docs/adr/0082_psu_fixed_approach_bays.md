# 0082: PSU-owned fixed approach holding bays

Status: Simulation implementation; Physical merge rejected pending further work.

## Problem
Observed Simulation holding commands stopped aircraft on a common approach leg. Different aircraft could own nominally different slots at overlapping coordinates. A wait-clear branch bypassed slot allocation. Queue ETA changed final-entry classification and repeatedly released/reassigned waits.

## Decision
PSU owns stable per-flight reservations around the authored approach entry. Six lateral bays per height level use a480m lateral offset,300m along-axis spacing, and120m height steps (six levels). Network corridors, other reserved bay positions, and their return legs exclude conflicting candidates. The native pilot route receives its bay before creation; original FPL and observed pose are not overwritten. Runtime remains the source of aircraft motion.

The shared terminal authority excludes the holding leg. Claims are released only after observed departure from terminal geometry. Queue return is checked against traffic and terrain; final-entry classification is independent of queue ETA. Committed vertical landing is not redirected. Predicted entry spacing is reserved while aircraft are still on the ground; actual occupancy remains authoritative for landing and ground movements.

## Public compatibility
Arrival clearance JSON gains optional holding_assignment (owner,port,slot,target,rejoin,state,assigned_s and movement diagnostics). Existing fields remain. PSU policy gains entry_spacing_s (default150s,60–600s); existing policy documents acquire its default during validation. Decision chart and generated browser fixture follow the same Python source. Old radial-hold parameter notes explicitly identify the time-based fallback; native fixed bays use the new layout.

## Validation and limitations
106 related remote tests pass. Captured1626-flight/100-aircraft schedule replayed for3600s: minimum3D centre distance21.04m versus0.076m baseline; no samples below the14m diagnostic threshold. Remaining horizontal/vertical separation infringements121 versus57336 baseline. Completed flights53 versus63: this is not a throughput improvement claim. Four-aircraft forced-closure replay completes all4 at1924s; it is slower than the1728s baseline. Initial ETA forecast warmup is about37s for100 aircraft.

Physical integration candidates remain staged: they failed the fleet acceptance checks, including a9.55m cruise encounter and later Windows access violations. Local production sources and DLL are preserved. No actual Unreal run or interactive browser evidence was obtained, so repository-wide validation is incomplete. See development evidence and workspace psu_slots_work for raw records and rejected variants.

Follow-up: Physical v27 completed the full hour with both default/debug allocators (56 flights,11.61m minimum,106 infringements,one cruise sample below14m,zero holding samples below14m). v28 preserves tactical braking until native bay arrival; its new regression fails v27 and passes v28 (116 flow tests). The separate cruise encounter persists, so Physical and native transition experiments are not installed. ASAN was stopped during initialization without a report; prior access violations remain unresolved.
