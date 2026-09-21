"""V-World (국토교통부 공간정보 오픈플랫폼): map tiles and building footprints
for Korea, so the display can be switched from the world-wide providers to the
national ones where they cover.

Two of V-World's services answer with a plain API key and are relayed here.
The key never leaves this process: the browser asks this server for a tile or
a cell of buildings, and this module asks V-World.

* WMTS tiles (Base, Satellite, Hybrid, midnight) at levels 6..19, Korea only.
  Outside the service area V-World answers an OWS exception instead of an
  image; that is reported as "not covered" so the caller can draw nothing.
* Data API GetFeature on the building layer LT_C_BLDGINFO: footprints as
  MultiPolygons with height (metres, when surveyed), floors above ground and a
  name. One request may cover at most 10 km² and 1000 features, so callers ask
  for fixed 0.01° cells and this module pages through them.

The separate public TDServer facility_LOD4 3D Tiles service is also relayed,
with legacy CRN textures modernized in bounded memory. It receives no key.
The legacy XDServer DEM is not used; elevation stays Cesium World Terrain.
"""
import asyncio
import gzip
import hashlib
import math
import json
import posixpath
import re
import struct
import time
import zlib
from collections import OrderedDict
from dataclasses import dataclass

import httpx

WMTS_URL = "https://api.vworld.kr/req/wmts/1.0.0"
DATA_URL = "https://api.vworld.kr/req/data"
# The public, textured 3D Tiles service is separate from the legacy XDServer.
# Never accept a caller-supplied host or forward our Data API credential here.
TILES3D_URL = "https://xdworld.vworld.kr/TDServer/services/facility_LOD4/"
TILES3D_RELAY = "/api/visualization/vworld/3d/"
MAX_TILE_BYTES = 32 * 1024 * 1024
MAX_IMAGERY_BYTES = 4 * 1024 * 1024
IMAGERY_CACHE_ENTRIES = 2048
IMAGERY_CACHE_SECONDS = 3600
IMAGERY_EMPTY_SECONDS = 300
IMAGERY_RETRY_SECONDS = 10
TILE_REPRESENTATION_VERSION = "v5-gzip1"
TILE_METADATA_VERSION = "v6-coverage-gzip1"
USER_AGENT = "AeroDT/0.1 (local dashboard; V-World relay)"
# Layer name -> file extension V-World serves it as.
TILE_LAYERS = {"Base": "png", "Satellite": "jpeg", "Hybrid": "png", "midnight": "png"}
TILE_LEVELS = (6, 19)
# The service area, generously: anything asked outside it is answered without a request.
COVERAGE = {"lomin": 124.0, "lomax": 132.2, "lamin": 32.8, "lamax": 39.2}
BUILDING_LAYER = "LT_C_BLDGINFO"
# Cells are fixed on this grid so every browser asks for the same boxes and the
# cache answers the second one. 0.01° is about 0.9 km × 1.1 km: well inside the
# 10 km² request limit and two or three pages in the densest districts.
CELL_DEGREES = 0.01
PAGE_SIZE = 1000
MAX_PAGES = 8
# Floors are the usual answer; a surveyed height is rarer and wins when present.
METRES_PER_FLOOR = 3.3
MINIMUM_HEIGHT_M = 3.0


@dataclass(frozen=True)
class TilePayload:
    """One pre-encoded HTTP representation shared by all waiting browsers."""
    content: bytes
    kind: str
    etag: str


def tile_payload(content, kind, *, already_encoded=False):
    # This runs in a worker. GZipMiddleware used to recompress every cache hit
    # at level 9 on the event loop, blocking telemetry along with tile loading.
    encoded = content if already_encoded else gzip.compress(content, compresslevel=1, mtime=0)
    return TilePayload(encoded, kind, 'W/"' + hashlib.sha256(encoded).hexdigest() + '"')


def tile_kind(path):
    if path.endswith('.json'):
        return 'application/json'
    if path.endswith(('.jpg', '.jpeg')):
        return 'image/jpeg'
    if path.endswith('.png'):
        return 'image/png'
    return 'application/octet-stream'


def _tile_record_key(path, texture):
    # Updating display metadata must not discard already converted mesh photos.
    version = TILE_METADATA_VERSION if path.endswith('.json') else TILE_REPRESENTATION_VERSION
    return f"{version}:{path}:{texture}"


def _transparent_png():
    """A 1x1 fully transparent PNG, built rather than pasted so it is never corrupt."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00")) + chunk(b"IEND", b""))


TRANSPARENT_PNG = _transparent_png()


def cell_bounds(column, row):
    """The degree box of cell (column, row): lomin, lamin, lomax, lamax."""
    return (round(column * CELL_DEGREES, 6), round(row * CELL_DEGREES, 6),
            round((column + 1) * CELL_DEGREES, 6), round((row + 1) * CELL_DEGREES, 6))


def cell_of(longitude, latitude):
    return (math.floor(float(longitude) / CELL_DEGREES), math.floor(float(latitude) / CELL_DEGREES))


def covered(longitude, latitude):
    return COVERAGE["lomin"] <= longitude <= COVERAGE["lomax"] and COVERAGE["lamin"] <= latitude <= COVERAGE["lamax"]


def cell_covered(column, row):
    lomin, lamin, lomax, lamax = cell_bounds(column, row)
    return covered(lomin, lamin) and covered(lomax, lamax)


def building_height(properties):
    """Metres from the surveyed height, else the floor count, else a low box."""
    try:
        height = float(properties.get("height") or 0)
    except (TypeError, ValueError):
        height = 0.0
    if height > 0:
        return round(height, 1)
    try:
        floors = int(float(properties.get("grnd_flr") or 0))
    except (TypeError, ValueError):
        floors = 0
    return round(max(MINIMUM_HEIGHT_M, floors * METRES_PER_FLOOR), 1)


def simplify_building(feature):
    """One building for the display: the outer ring of each polygon, its holes,
    the height to extrude to and a name. Anything malformed answers None."""
    if not isinstance(feature, dict):
        return None
    geometry = feature.get("geometry") or {}
    properties = feature.get("properties") or {}
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Polygon":
        polygons = [coordinates]
    elif geometry.get("type") == "MultiPolygon":
        polygons = coordinates
    else:
        return None
    rings = []
    try:
        for polygon in polygons or []:
            outer = [[round(float(x), 6), round(float(y), 6)] for x, y in polygon[0]]
            if len(outer) < 4:
                continue
            holes = [[[round(float(x), 6), round(float(y), 6)] for x, y in hole] for hole in polygon[1:] if len(hole) >= 4]
            rings.append({"outer": outer, "holes": holes})
    except (TypeError, ValueError):
        return None
    if not rings:
        return None
    try:
        floors = int(float(properties.get("grnd_flr") or 0))
    except (TypeError, ValueError):
        floors = 0
    name = properties.get("bld_nm")
    return {"id": str(feature.get("id") or ""), "name": name.strip() if isinstance(name, str) else "",
            "height_m": building_height(properties), "floors": floors, "rings": rings}


class VWorldClient:
    """Relays tiles and building cells for one API key; caches building cells in memory."""

    def __init__(self, key, domain, *, transport=None, timeout_seconds=20.0, clock=time.monotonic,
                 cell_cache_size=160, cell_ttl_seconds=6 * 3600, tiles_cache_bytes=96 * 1024 * 1024,
                 public_tiles_only=False, tile_records=None, imagery_cache_bytes=24 * 1024 * 1024):
        if not public_tiles_only and (not isinstance(key, str) or not key.strip()):
            raise ValueError("V-World credential not configured")
        self._key = None if public_tiles_only else key.strip()
        self._domain = domain
        self._transport = transport
        self._timeout = timeout_seconds
        self._clock = clock
        self._client = None
        self._cells = OrderedDict()
        self._cell_cache_size = cell_cache_size
        self._cell_ttl = cell_ttl_seconds
        self._pending = {}
        self._tiles = OrderedDict()
        self.tiles_cache_bytes = 0
        self._tiles_budget = tiles_cache_bytes
        self._tiles_pending = {}
        self._tile_slots = asyncio.Semaphore(8)
        self._texture_slots = asyncio.Semaphore(2)
        self._cell_slots = asyncio.Semaphore(3)
        self._tiles_retry = OrderedDict()
        self._tile_records = tile_records
        # Keyed imagery is kept only in this client's bounded memory. Browsers
        # that revisit an evicted GPU tile, or share the same view, should not
        # download it from the provider again. This is independent of 3D slots.
        self._imagery = OrderedDict()
        self.imagery_cache_bytes = 0
        self._imagery_budget = max(0, int(imagery_cache_bytes))
        self._imagery_pending = {}
        self._imagery_slots = asyncio.Semaphore(8)
        self._imagery_retry = OrderedDict()

    def _http(self):
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout, transport=self._transport,
                                             headers={"User-Agent": USER_AGENT}, follow_redirects=False)
        return self._client

    async def aclose(self):
        pending = (list(self._pending.values()) + list(self._tiles_pending.values())
                   + list(self._imagery_pending.values()))
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._pending.clear()
        self._tiles_pending.clear()
        self._tiles.clear()
        self.tiles_cache_bytes = 0
        self._imagery_pending.clear()
        self._imagery.clear()
        self._imagery_retry.clear()
        self.imagery_cache_bytes = 0
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---------------------------------------------------------------- tiles
    async def tile(self, layer, level, row, column):
        """(bytes, content type) of a tile, or None where V-World has none.
        Raises ValueError for a request the service cannot take at all."""
        if not self._key:
            raise ValueError("V-World credential not configured")
        extension = TILE_LAYERS.get(layer)
        if extension is None:
            raise ValueError("unknown layer")
        if not (TILE_LEVELS[0] <= level <= TILE_LEVELS[1]) or row < 0 or column < 0 or max(row, column) >= 2 ** level:
            raise ValueError("tile out of range")
        key = (layer, level, row, column)
        now = self._clock()
        cached = self._imagery.get(key)
        if cached is not None:
            if cached[0] > now:
                self._imagery.move_to_end(key)
                return cached[1]
            self._forget_imagery(key)
        if self._imagery_retry.get(key, 0) > now:
            raise RuntimeError("tile provider unavailable")
        if key not in self._imagery_pending:
            if len(self._imagery_pending) >= 64:
                raise RuntimeError("tile provider busy")
            task = asyncio.create_task(self._fetch_imagery(key, extension))
            self._imagery_pending[key] = task
            def done(task):
                self._imagery_pending.pop(key, None)
                if not task.cancelled():
                    task.exception()
            task.add_done_callback(done)
        # One caller navigating away must not cancel other viewers' tile.
        return await asyncio.shield(self._imagery_pending[key])

    def _forget_imagery(self, key):
        cached = self._imagery.pop(key)
        if cached[1] is not None:
            self.imagery_cache_bytes -= len(cached[1][0])

    def _remember_imagery(self, key, value):
        size = len(value[0]) if value is not None else 0
        if size > self._imagery_budget:
            return
        if key in self._imagery:
            self._forget_imagery(key)
        while self._imagery and (self.imagery_cache_bytes + size > self._imagery_budget
                                or len(self._imagery) >= IMAGERY_CACHE_ENTRIES):
            self._forget_imagery(next(iter(self._imagery)))
        ttl = IMAGERY_CACHE_SECONDS if value is not None else IMAGERY_EMPTY_SECONDS
        self._imagery[key] = (self._clock() + ttl, value)
        self.imagery_cache_bytes += size

    async def _fetch_imagery(self, key, extension):
        layer, level, row, column = key
        try:
            async with self._imagery_slots:
                url = f"{WMTS_URL}/{self._key}/{layer}/{level}/{row}/{column}.{extension}"
                async with self._http().stream("GET", url) as response:
                    kind = response.headers.get("content-type", "").split(";")[0]
                    if response.status_code != 200 or not (kind.startswith("image/") or "xml" in kind):
                        raise RuntimeError("tile provider unavailable")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_IMAGERY_BYTES:
                            raise RuntimeError("tile exceeds transfer budget")
                # Preserve the provider's no-coverage result; no XML or URL is
                # relayed or persisted. Bound empty entries as well as bytes.
                value = (bytes(content), kind) if kind.startswith("image/") else None
                self._remember_imagery(key, value)
                self._imagery_retry.pop(key, None)
                return value
        except Exception:
            self._imagery_retry[key] = self._clock() + IMAGERY_RETRY_SECONDS
            self._imagery_retry.move_to_end(key)
            while len(self._imagery_retry) > 256:
                self._imagery_retry.popitem(last=False)
            raise RuntimeError("tile provider unavailable") from None

    # ------------------------------------------------------------ buildings
    async def buildings(self, column, row):
        """The buildings of one cell, from memory when it was asked recently."""
        if not self._key:
            raise ValueError("V-World credential not configured")
        key = (int(column), int(row))
        now = self._clock()
        cached = self._cells.get(key)
        if cached is not None and cached["expires"] > now:
            self._cells.move_to_end(key)
            return cached["value"]
        if key not in self._pending:
            if len(self._pending) >= 64:
                raise RuntimeError("Building provider busy")
            task = asyncio.create_task(self._fetch_cell(key))
            self._pending[key] = task
            def done(task):
                self._pending.pop(key, None)
                if not task.cancelled():
                    task.exception()
            task.add_done_callback(done)
        return await asyncio.shield(self._pending[key])

    async def _fetch_cell(self, key):
        async with self._cell_slots:
            return await self._fetch_cell_pages(key)

    async def _fetch_cell_pages(self, key):
        column, row = key
        lomin, lamin, lomax, lamax = cell_bounds(column, row)
        if not cell_covered(column, row):
            value = {"cell": [column, row], "bbox": [lomin, lamin, lomax, lamax], "buildings": [], "total": 0, "truncated": False}
            self._remember(key, value)
            return value
        buildings, total, truncated = [], 0, False
        for page in range(1, MAX_PAGES + 1):
            document = await self._page(f"BOX({lomin},{lamin},{lomax},{lamax})", page)
            status = document.get("status")
            if status == "NOT_FOUND":
                break
            if status != "OK":
                raise RuntimeError("building provider unavailable")
            record = document.get("record") or {}
            total = int(record.get("total") or 0)
            features = (((document.get("result") or {}).get("featureCollection") or {}).get("features")) or []
            for feature in features:
                building = simplify_building(feature)
                if building is not None:
                    buildings.append(building)
            if len(features) < PAGE_SIZE or page * PAGE_SIZE >= total:
                break
        else:
            truncated = True
        value = {"cell": [column, row], "bbox": [lomin, lamin, lomax, lamax], "buildings": buildings,
                 "total": total, "truncated": truncated}
        self._remember(key, value)
        return value

    async def _page(self, box, page):
        response = await self._http().get(DATA_URL, params={
            "service": "data", "version": "2.0", "request": "GetFeature", "data": BUILDING_LAYER,
            "key": self._key, "domain": self._domain, "format": "json", "crs": "EPSG:4326",
            "geomFilter": box, "size": PAGE_SIZE, "page": page})
        if response.status_code != 200:
            raise RuntimeError("building provider unavailable")
        try:
            return response.json().get("response") or {}
        except ValueError:
            raise RuntimeError("building provider unavailable") from None

    def _remember(self, key, value):
        self._cells[key] = {"value": value, "expires": self._clock() + self._cell_ttl}
        self._cells.move_to_end(key)
        while len(self._cells) > self._cell_cache_size:
            self._cells.popitem(last=False)

    # ----------------------------------------------------- textured buildings
    @staticmethod
    def _tile_path(path):
        if (not isinstance(path, str) or len(path) > 500
                or not re.fullmatch(r"[A-Za-z0-9_$/.-]+\.(?:json|b3dm|glb|bin|jpg|jpeg|png|ktx2)", path)
                or path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/"))):
            raise ValueError("Unknown 3D tile")
        return path

    async def tiles3d(self, path, *, texture="full"):
        """Identity bytes for non-HTTP callers; cached bytes stay compressed."""
        payload = await self.tiles3d_payload(path, texture=texture)
        content = await asyncio.to_thread(gzip.decompress, payload.content)
        return content, payload.kind

    async def tiles3d_payload(self, path, *, texture="full"):
        path = self._tile_path(path)
        if texture not in ("full", "overview") or (texture == "overview" and not path.endswith(".b3dm")):
            raise ValueError("Unknown texture detail")
        key = (path, texture)
        cached = self._tiles.get(key)
        if cached and cached[0] > self._clock():
            self._tiles.move_to_end(key)
            return cached[1]
        if self._tiles_retry.get(key, 0) > self._clock():
            raise RuntimeError("3D tile provider unavailable")
        if key not in self._tiles_pending:
            if len(self._tiles_pending) >= 64:
                raise RuntimeError("3D tile provider busy")
            task = asyncio.create_task(self._fetch_tile3d(path, texture))
            self._tiles_pending[key] = task
            # A disconnected browser cannot leave a completed task held forever.
            def done(task):
                self._tiles_pending.pop(key, None)
                if not task.cancelled():
                    task.exception()
            task.add_done_callback(done)
        return await asyncio.shield(self._tiles_pending[key])

    def _relay_document(self, document, path):
        def rewrite(value):
            if isinstance(value, dict):
                for key, child in list(value.items()):
                    if key in ("uri", "url") and isinstance(child, str):
                        # Files in this service are relative to their tileset.
                        # Foreign hosts, traversal and query-string credentials fail closed.
                        self._tile_path(child)
                        target = posixpath.join(posixpath.dirname(path), child)
                        version = "5" if target.endswith(".json") else "4"
                        value[key] = TILES3D_RELAY + self._tile_path(target) + "?v=" + version
                    else:
                        rewrite(child)
            elif isinstance(value, list):
                for child in value:
                    rewrite(child)
        if not isinstance(document, dict) or "root" not in document or "asset" not in document:
            raise RuntimeError("Invalid 3D tile metadata")
        self._annotate_coverage(document["root"])
        rewrite(document)
        self._expand_empty_lod(document["root"])
        # Positions, real mesh LOD errors/refinement and materials stay intact.
        return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()

    @staticmethod
    def _annotate_coverage(tile):
        """Expose a real mesh's own region through Cesium's public tile extras.

        Empty spatial indexes and external JSON may cover whole districts while
        containing no displayed mesh. Only binary content can suppress simple
        fallback buildings, and the viewer still requires visible loaded geometry
        and a narrow region before using this hint. Source geometry is unchanged.
        """
        if not isinstance(tile, dict):
            return
        content = tile.get("content")
        if isinstance(content, dict) and any(
                isinstance(content.get(name), str) and content[name].endswith(".b3dm")
                for name in ("uri", "url")):
            region = None
            for volume in (content.get("boundingVolume"), tile.get("boundingVolume")):
                candidate = volume.get("region") if isinstance(volume, dict) else None
                if not isinstance(candidate, list) or len(candidate) != 6:
                    continue
                if not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                           and math.isfinite(value) for value in candidate):
                    continue
                west, south, east, north, minimum, maximum = candidate
                if (-math.pi <= west < east <= math.pi
                        and -math.pi / 2 <= south < north <= math.pi / 2
                        and minimum <= maximum):
                    region = candidate
                    break
            if region is not None:
                extras = tile.setdefault("extras", {})
                if isinstance(extras, dict):
                    extras.setdefault("aerodtCoverageRegion", list(region))
        for child in tile.get("children") or []:
            VWorldClient._annotate_coverage(child)

    @staticmethod
    def _expand_empty_lod(tile, inherited_refine="REPLACE"):
        """An empty spatial index is not a coarse building representation.

        facility_LOD4 has ADD/REPLACE nodes with no content and small errors
        (e.g. 80 m). Cesium can stop at those nodes on zoom-out and select NO
        geometry, even while reporting tilesLoaded. Promote only contentless
        nodes' traversal error; real model errors still choose coarse/fine LOD.
        The finite floor and normal Cesium memory/frustum budgets remain active.
        This modifies display metadata only, not coordinates or building meshes.
        """
        if not isinstance(tile, dict):
            return
        children = tile.get("children") or []
        refine = tile.get("refine", inherited_refine)
        if children and not tile.get("content") and not tile.get("contents"):
            tile["geometricError"] = max(float(tile.get("geometricError") or 0), 4096.0)
        elif children and refine == "REPLACE":
            # A real coarse substitute has finer children. Keep its geometry,
            # but don't spend facade-resolution VRAM on an entire distant city.
            # Leaf and ADD content keep full photos; these never get replaced.
            content = tile.get("content") or {}
            for name in ("uri", "url"):
                uri = content.get(name)
                if isinstance(uri, str) and uri.endswith(".b3dm?v=4"):
                    content[name] = uri + "&texture=overview"
        for child in children:
            VWorldClient._expand_empty_lod(child, refine)

    async def _fetch_tile3d(self, path, texture="full"):
        # Hold the slot through conversion as well: finished downloads waiting
        # for the CPU must not pile up dozens of 32 MB binary buffers.
        async with self._tile_slots:
            if self._tile_records:
                saved = await asyncio.to_thread(self._tile_records.get, _tile_record_key(path, texture))
                if saved:
                    encoded, remaining = saved
                    payload = await asyncio.to_thread(tile_payload, encoded, tile_kind(path), already_encoded=True)
                    self._remember_tile((path, texture), payload, remaining)
                    return payload
            return await self._fetch_tile3d_body(path, texture)

    def _remember_tile(self, key, payload, ttl=3600):
        size = len(payload.content)
        if size > self._tiles_budget:
            return
        old = self._tiles.pop(key, None)
        if old:
            self.tiles_cache_bytes -= len(old[1].content)
        while self._tiles and self.tiles_cache_bytes + size > self._tiles_budget:
            self.tiles_cache_bytes -= len(self._tiles.popitem(last=False)[1][1].content)
        self._tiles[key] = (self._clock() + ttl, payload)
        self.tiles_cache_bytes += size

    async def _fetch_tile3d_body(self, path, texture="full"):
        key = (path, texture)
        try:
            async with self._http().stream("GET", TILES3D_URL + path) as response:
                if response.status_code != 200:
                    raise RuntimeError("3D tile provider unavailable")
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_TILE_BYTES:
                        raise RuntimeError("3D tile exceeds transfer budget")
            content = bytes(content)
            kind = "application/octet-stream"
            if path.endswith(".json"):
                content = self._relay_document(json.loads(content.decode("utf-8-sig")), path)
                kind = "application/json"
            elif path.endswith(".b3dm"):
                from communication.external.vworld_texture import modernize_b3dm
                async with self._texture_slots:
                    content = await asyncio.to_thread(modernize_b3dm, content, overview=texture == "overview")
            elif path.endswith(".glb") and not content.startswith(b"glTF"):
                raise RuntimeError("Invalid 3D tile")
            elif path.endswith((".jpg", ".jpeg")):
                kind = "image/jpeg"
            elif path.endswith(".png"):
                kind = "image/png"
            payload = await asyncio.to_thread(tile_payload, content, kind)
            self._remember_tile(key, payload)
            if self._tile_records:
                await asyncio.to_thread(self._tile_records.put, _tile_record_key(path, texture), payload.content)
            self._tiles_retry.pop(key, None)
            return payload
        except Exception:
            self._tiles_retry[key] = self._clock() + 60
            while len(self._tiles_retry) > 256:
                self._tiles_retry.popitem(last=False)
            raise RuntimeError("3D tile provider unavailable") from None
