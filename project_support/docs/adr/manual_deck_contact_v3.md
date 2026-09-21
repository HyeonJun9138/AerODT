# Manual deck contact ABI v3

WebSocket hello accepts optional contact_decks: up to128 {id,height_m,outline:[[longitude,latitude],...]} records,3–256 vertices each. Geometry comes from the same resolved renderer deck outline/height, is validated before native creation, and remains fixed for one session. Runtime owns motion. C ABI aerodt_manual_deck and aerodt_manual_surface supply geometry; step_v2 remains compatible. manual_v3 DLL preserves the loaded v2 library.

Native4ms steps select a deck beneath observed feet and resolve contact through FlatGroundContactModel/UamVehicleRuntime. Ground assist uses the selected surface height. An overhead deck never teleports an aircraft upward. Local DEM replaces the infinite departure plane when decks are available; without DEM underlying fallback is ellipsoid0. Legacy clients without geometry retain departure-flat-plane behavior. Scene edits require a new session.

Top-surface training contact only: no building side collision, terrain sweep, authenticated surveyed geometry or full Unreal validation. Evidence: data/development_log/evidence/2026_09_17_manual_landing.json.
