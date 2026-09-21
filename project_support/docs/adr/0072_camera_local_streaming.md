# ADR 0072 — Camera-local scenery and buffered visual models

Date: 2026-09-12

The HTTP/1.1 dashboard previously admitted 32 Cesium requests per origin, while
aircraft shared the browser transport with terrain/building tiles. A 426,592-byte
GLB also took 5.67 seconds over server loopback: FileResponse scheduled a file
read for each 64 KiB chunk during an active receiver workload.

Visualization now derives a bounded building extent and haze from the camera
height and distance to a followed entity. The saved building distance is the
maximum; fog off restores that maximum. Native clipping, footprint selection
and shader haze use the same extent. Limits ease during camera transitions.
Object labels and authoritative geometry/physics are unchanged. Scene tiles
use four relay requests; direct hosts use eighteen and the global cap is 48.
Model readiness invalidates LOD promptly; approaching glyphs load by apparent
size and failed models have at most two delayed retries.

The communication adapter buffers complete GLBs up to 20 MiB, retaining at most
32 MiB of identity and gzip bytes together. Two workers and eight admitted
preparations bound read/compression work. Concurrent requests share a preparation.
An mtime-nanoseconds/size signature invalidates changed assets. StaticFiles owns
path validation; ranges and larger files use its existing response path.
Gzip has a distinct ETag, Vary: Accept-Encoding, conditional GET and HEAD support.
URLs, decoded bytes, model metadata, public snapshot schema and flight rules do
not change. Generic compression bypasses these negotiated GLB responses.

Verification and measured limits are recorded in the development log. Browser
benchmarks use isolated synthetic display tracks; they are not native flight or
remote desktop FPS evidence. Native/Unreal inputs are unchanged.

Cesium 1.143 source references: [Fog](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/Fog.js),
[RequestScheduler](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Core/RequestScheduler.js).
