# Manual observation and prediction route progress

Assigned manual aircraft stop advancing the automatic route clock. Using that clock for prediction left already-passed targets at the head of the learned model route even though cockpit navigation progressed geometrically.

Scenario prediction now uses the existing single-manual geometric reference selector with current observed position and motion, plus a bounded per-assignment prior reference. It never alters route execution, aircraft position or pilot commands. Reference caches reset on scenario history reset or route/owner replacement. In-flight results must also match the first remaining waypoint, not only its containing leg index.

Manual sample messages add optional `velocity_ned_mps`: three finite numbers in metres per second, north/east/down, copied from native state indices 4..6. Existing consumers may ignore this additive field. The internal manual pose bridge adds optional `telemetry` with pitch_deg, roll_deg, tilt_deg, rotor_radps, control_surface_deg and velocity_ned_mps. Only whitelisted finite scalar/vector values are copied; vectors are detached. Scenario observation accepts native velocity for external manual ownership as well as automatic pilots. No new input command or control authority is introduced.

The model still forecasts conditional return to the planned route, not future human stick inputs. This fixes stale route/observation inputs; it does not claim model accuracy or exact agreement with a browser-selected navigation target.

Validation: four old-code regressions fail and all 43 related tests pass after changes, including installed model outputs through the production JS comparison reader. Backend restart and manual socket reconnection are required; live running sessions are not hot-patched.
