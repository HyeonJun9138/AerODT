# 0050 — Bounded presentation work and browser performance preferences

Date: 2026-09-11

## Problem

Camera movement prevented cold aircraft models from starting, while a parsed GLB
could hide its symbol before GPU readiness. Returning to a recent view recreated
models. Stopped rotors and rigid ducts still uploaded identical node matrices.
VWorld footprint responses could start several terrain/geometry builds together,
and one failed cell paused unrelated buildings. Repeated WMTS views downloaded
identical images again. Unchanged vertiport lists rebuilt terrain and entities.

## Decision

Keep all changes in presentation and transport. Authoritative state, native
physics, mission steps, clocks, source imagery bytes, building footprints/heights
and close-range aircraft geometry remain unchanged.

* Bound aircraft model preparation independently of visibility; permit one cold
  preparation during movement and give the selected aircraft priority. Keep the
  symbol until GPU readiness. Retain recent models for 20 seconds under a count
  budget, finish textures, then detach unused models from scene traversal.
* Do not upload unchanged rotor matrices. Stop subpixel blade animation while
  retaining measured tilt and full selected-aircraft animation.
* Split footprint download and geometry queues: four fetches and one build by
  default, including pending GPU compilation. Buffer up to eight downloaded
  cells. Retry failed cells individually and reuse sampled ground heights until
  the terrain changes. Allocate the existing geometry budget nearest-first.
* Retain native tiles for 15 seconds after a brief altitude exit. Explicitly
  disabling the provider still releases its tiles. Adaptive detail thresholds
  account for the operator's chosen 30–60 FPS cap.
* Merge identical in-flight WMTS requests. Preserve their exact image bytes in a
  24 MiB / 2,048-entry memory cache (one hour; empty coverage five minutes), with
  eight active / 64 pending requests, a 4 MiB transfer bound and a ten-second
  failure cooldown. Do not store keyed imagery on disk or gzip JPEG/PNG again.
* Reuse unchanged vertiport geometry, paint and measured ground. Show an early
  location marker while the first terrain query is pending. Batch removal and
  addition separately: Cesium coalesces a same-ID remove/add within one batch and
  can leave a visualizer attached to the removed object.
* Keep the port shell at 32 km, facade at twice the selected detail distance,
  deck at that distance (1–8 km), and small furniture within 3 km. This changes
  distance visibility only; no source/contact geometry is simplified.
* Bound annotation fade updates separately from moving aircraft. Update route
  mesh attributes once per frame and allocate replacement color arrays only
  when their bytes change.
* Let the selection card query primary-model preparation through the optional
  `isPrimaryModelPreparing(id)` callback. Delay its secondary model request until
  the main scene is ready or has failed, with a 12-second bound on this additional
  wait. Preserve the existing navigation/hidden-panel deferral and cancel stale
  selection work. This avoids two model downloads competing after a selection.

## Operator settings

`aerodt.performance.v1` is localStorage in the current browser only. It contains
validated numeric preferences; it is not a shared source or physics setting.
Three presets (balanced, quality, fleet) and a custom mode control target FPS,
visible detailed aircraft, concurrent model preparation, port detail distance,
terrain screen-space error/cache, footprint request concurrency, distant fog,
temporary motion resolution floor and annotation cadence. Changes take effect
without restarting simulation. Existing provider/detail/appearance settings and
display pixel calibration remain separate. Static resolution returns after
navigation; 100% motion floor prevents temporary resolution reduction.

These are bounded work/count budgets, not hard GPU-byte guarantees. Cesium may
retain visible tiles beyond its cache target, and an atomic geometry replacement
briefly owns both old and new geometry. Selecting quality can cost more GPU time.

## Verification

### Near-photo / distant-plain mixed provider

The optional `vworld_hybrid` provider runs bounded plain footprints together with
nearby photoreal tiles. Browser-local `hybridDistance` chooses a 500–4,000 m
maximum radius (balanced 1,500 m, quality 2,500 m, fleet 1,000 m). The native
tileset's existing clipping planes bound requests; distant haze still uses the
ordinary outer range. Existing vertiport clipping polygons are retained.

Only a `tileVisible` event for actual binary geometry with a valid narrow region
can suppress fallback. The relay copies the source binary content's region into
`extras.aerodtCoverageRegion`, preserving existing extras. External JSON and
contentless roots are never treated as coverage. JSON cache versions change for
this annotation; large binary/texture caches remain usable.

A per-frame set of at most 64 region uniforms is shared by both representations.
It resets before traversal and is populated from public events before drawing.
The same ordered distance edge gives each sample one representation. Missing,
failed, offscreen, oversized or excess regions keep plain fallback; there is no
terrain resampling or geometry reconstruction on a mask change. Empty/outside
fragments exit before region tests. Source coverage metadata describes tile
regions, not guaranteed completeness of every individual surveyed building.

### Checks

Tests cover GPU/texture readiness, late completion and teardown, 20 camera-view
switches with one model load, model ownership/budgets, held rotor uploads,
independent cell failure and bounded builds, dense near-cell allocation, cache
byte limits/cancellation/expiry, repeated port list identity, same-ID Cesium
notification semantics, preference validation/persistence and live layer wiring.

The remote original test baseline and final results are stored in
`data/workspace/visualization_checks/2026_09_11_optimization`. Browser checks must
include a close port deck (not only marker/labels), selected model readiness,
camera revisit, presets and a bounded synthetic presentation trace. Local
headless frame cadence is not a measurement of the remote RTX 3080 desktop.

Existing baseline failures: the flight-presentation test references an absent
glTF module export path; one layout test expects an obsolete Simulation badge.
Unreal was not changed or launched for this web presentation change.

API references: [Model readiness](https://cesium.com/learn/cesiumjs/ref-doc/Model.html),
[PrimitiveCollection ownership](https://cesium.com/learn/cesiumjs/ref-doc/PrimitiveCollection.html),
[EntityCollection events](https://cesium.com/learn/cesiumjs/ref-doc/EntityCollection.html),
[terrain cache](https://cesium.com/learn/cesiumjs/ref-doc/Globe.html#tileCacheSize),
[fog](https://cesium.com/learn/cesiumjs/ref-doc/Fog.html).
