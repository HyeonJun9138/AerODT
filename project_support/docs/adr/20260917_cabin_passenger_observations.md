# Cabin and ground passenger observations

Passenger responses retain schema_version 1 and add optional `cabins` entries
with aircraft_id/on_board. Walk schedules add door_side and per-point
path_height_offsets_m. Existing consumers can ignore these additive fields.
Simulation and Physical use the shared ScenarioObservation reader. Counts use
schedule doorway events, not a linear fraction of the complete walking time.

Asset-authored illustrative hatch dimensions drive routes; these are not
certified aircraft dimensions. Walking people and seated cabin occupants are
representative avatars; personal appearance/identity is not transmitted.
The display only reads schedules, engine time and passenger counts. It never
commands an aircraft or changes clearance, energy or flight state. A bounded
nearby walker pool includes ground crew. Seated occupants reuse existing GLB
nodes and the aircraft's LOD lifecycle.
