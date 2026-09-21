# Terrain and viewport rendering optimization

Goal: match OSM buildings to World Terrain and reduce jank without changing Live Twin state.
Implementation location: original project only. Existing native code and 86 acquired assets remain unchanged.

- [x] Capture fixed-input browser and CPU baselines; distinguish frame rate from JS work and network spikes.
- [x] Add fixed terrain endpoint, server-only credential and retry-safe TerrainLayer (terrain_stream agent).
- [x] Use globe terrain picking, height-aware camera clearance and terrain readiness for buildings.
- [x] Replace full per-frame position scans with visible active sets, point/model multi-rate updates, projected-size LOD, projected-model/selected priority and bounded model loads/cache.
- [x] Reduce transient snapshot allocations and avoid repeated unchanged DOM work. Preserve wire/source provenance and continuity semantics.
- [x] Apply viewport/density budget without deleting authoritative entities; skip hidden tab work and avoid unbounded asynchronous loading.
- [x] Run native-independent regression tests, compare same-input global/region/city benchmarks, verify actual terrain and buildings in browser.
- [x] Record exact results, limitations and source boundaries in development log and ADR.

Tests first for each behavior. No automatic commits, global dependency upgrades, credential output or CelesTrak retries. Terrain errors must not be represented as grounded buildings. Runtime remains sole owner of truth; all culling/interpolation is display-only.

Results: fixed 25,376-entity browser benchmark, actual SF/Seoul terrain, aircraft model/tracking and independent layer checks recorded in data/development_log/evidence/2026_09_08_terrain_rendering.json. Concurrent HUD/place-label changes were preserved. Native UAM was not rerun.
