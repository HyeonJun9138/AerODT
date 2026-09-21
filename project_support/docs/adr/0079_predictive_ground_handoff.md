# ADR 0079: Predictive ground handoff and progressive arrival clearance

- Date: 2026-09-13
- Status: Implemented in remote Simulation and local Physical sources; runtime restart deferred.
- Scope: Shared Python operational scheduling and additive observation/UI fields. Native controller, physics, and saved flight plan are unchanged.

## Problem

An arrival waited for a departure to release its gate or entire terminal route even when the observed ground movement would clear those resources before arrival. This prevented useful overlap between departure ground movement and an inbound aircraft's initial approach.

## Decision

Keep observed occupancy separate from future reservation. StandTimeline.reserve_future accepts exactly one successor only when the expected departure remains the observed occupant. The gate remains occupied and cannot be occupied by its successor before actual release.

Forecast from a moving departure with an existing terminal claim and a positive ground movement authority that extends past the conflict. Use actual route progress, the ground motion schedule, authorized speed and conservative timing margins. A future schedule alone, a stopped/failed departure, missing authority or a blocked route cannot justify entry. Prefer reachable free gates before an occupied gate forecast; preserve the immutable flight plan.

Permit the disjoint initial approach segment while the departure retains its final-area claim. Remove the protected final tail using final_guard_s plus prediction_buffer_s; also check actual distance against speed-dependent braking space so a bad ETA cannot bypass the guard. Recheck and replace the initial segment claim on each native step. Final entry still requires the existing separation, preceding arrival, terminal geometry and actual pad checks.

A free, independent FATO may accept an arrival before its gate clears when the departure is expected to clear within landing_staging_wait_s. Reject shared/nearby pads, occupied touchdown points, crossing departure taxi paths and terminal conflicts. Retain actual FATO occupancy and ground movement protection after touchdown until the aircraft really leaves. A longer-than-forecast ground wait does not force an unsafe taxi command.

## Additive contracts

Clearance/operations observation fields:
- gate_release_aircraft_id: observed departure on which the future gate reservation depends.
- gate_available_s: predicted release on the scenario time axis.
- landing_staging: clearance allows landing while waiting for the gate.
- approach_mode: initial or full approach permission.

Simulation observation and Physical operations forwarding already serialize Clearance.as_dict; no second state owner or alternate telemetry path is introduced. The PSU inspector distinguishes forecasts and initial approach from final landing authority.

PSU policy/decision chart parameters:
- predictive_ground = true.
- ground_lookahead_s = 120 seconds, range 30–300.
- progressive_approach = true.
- landing_staging_wait_s = 30 seconds, range 0–90; zero disables staging.

Existing application policy applies to a new run. Restart the Python process to load this implementation, then create a new Simulation/Physical run. Existing running engines are not patched in memory.

## Verification and limits

18 new deterministic regressions cover reservations, moving/stopped dependencies, ground authority, shared/independent pads, crossing taxi, route claim handoff and braking guard. The previous source fails three selected new requirements. Final remote focused suite: 200 passed, 1 skipped; local operational suite: 151 passed; JS decision/PSU suites: 45 passed; architecture PASS.

The same saved 100-aircraft/18-vertiport plan was replayed through NativePilot for 1,800 simulated seconds before and after. Completed flights 30→32; takeoffs 71→74; touchdowns remain 34; accumulated aircraft hold_seconds 11,700→11,249. Final holding aircraft increased 17→19. No sampled ground footprint overlaps (5-second sampling), minimum sampled ground distance 14.3758 m, and no pilot failures. This is a bounded comparison, not proof of full-day liveness or continuous all-aircraft separation. Initial approach and gate forecasting occurred; staging did not occur in this fleet run and is covered by the independent-pad fixture.

Actual Unreal was launched with the configured short native mission. Run 20260913T141514Z-a6f1e77d timed out after 240 seconds and lacked the required native plugin/sensor/mission markers. This validation remains unsuccessful; it is not counted as a pass or a visualization verification. No native source/DLL change was made for this feature.

Local and remote scenario sources already differed before this change. Equivalent new forecast/entry methods were applied independently to both, preserving existing unrelated work. Full source parity is not claimed. Evidence: data/development_log/evidence/2026_09_13_predictive_ground.json.
