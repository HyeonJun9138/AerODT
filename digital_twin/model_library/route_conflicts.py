"""Where a route meets the buildings under it.

A link is flown as a corridor (the cruise, with its width) or as a line (the
climb-out and the descent, given a small width for the vehicle), along the
same eased height profile the display draws. Every building whose footprint
reaches into that strip is measured: its top is the ground under it plus its
height, the path's height there comes from the profile, and the difference is
the clearance. A negative clearance is a collision; a small positive one is
worth a warning. Ground heights arrive with the request, sampled along the
link by the display, because the terrain lives there.

Pure geometry: no storage, transport or rendering. Buildings are the shapes
the V-World relay hands out (outer rings in degrees, height in metres).
"""
import math

# Warn when a building comes closer than this under the path.
TIGHT_CLEARANCE_M = 30.0
# A climb or descent is drawn as a line; the vehicle still needs this much either side.
LINE_HALF_WIDTH_M = 25.0
METRES_PER_DEGREE = 111320.0
# How many buildings one report lists; the worst come first.
MAX_REPORTED = 12
MAX_LINKS_PER_REQUEST = 24
# Deck outlines one request may carry, and points in each. A city's worth of
# vertiports is tens of outlines of a few dozen points.
MAX_CLEARED_RINGS = 256
MAX_CLEARED_POINTS = 512


def _bounds(points, longitude=lambda p: p[0], latitude=lambda p: p[1]):
    west = south = math.inf
    east = north = -math.inf
    for point in points:
        x, y = longitude(point), latitude(point)
        west, east = min(west, x), max(east, x)
        south, north = min(south, y), max(north, y)
    return west, south, east, north


def _inside(ring, longitude, latitude, x=lambda p: p[0], y=lambda p: p[1]):
    """Whether a point in degrees falls inside a ring (even-odd crossing)."""
    inside = False
    count = len(ring)
    previous = count - 1
    for index in range(count):
        a, b = ring[index], ring[previous]
        ay, by = y(a), y(b)
        if (ay > latitude) != (by > latitude):
            crossing = (x(b) - x(a)) * (latitude - ay) / (by - ay) + x(a)
            if longitude < crossing:
                inside = not inside
        previous = index
    return inside


def _cross(a, b, c, d):
    """Whether segment a-b crosses segment c-d, in degrees."""
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def overlaps_cleared(cleared, outline):
    """Whether a building's outline runs into ground a vertiport deck has taken.

    The same three questions the display asks before it declines to extrude a
    building: a corner of the building standing on the deck, the deck wholly
    inside the building, or a wall driven straight across it. A building that
    merely stands near a deck is a real building and is still measured.
    """
    if not cleared or not outline or len(outline) < 3:
        return False
    box = _bounds(outline)
    for ring in cleared:
        if len(ring) < 3:
            continue
        ring_box = _bounds(ring)
        if box[2] < ring_box[0] or ring_box[2] < box[0] or box[3] < ring_box[1] or ring_box[3] < box[1]:
            continue
        if any(_inside(ring, point[0], point[1]) for point in outline):
            return True
        if any(_inside(outline, point[0], point[1]) for point in ring):
            return True
        for index in range(len(outline)):
            a, b = outline[index], outline[(index + 1) % len(outline)]
            for at in range(len(ring)):
                if _cross(a, b, ring[at], ring[(at + 1) % len(ring)]):
                    return True
    return False


def _outer_ring(ring):
    """A building ring as [[longitude, latitude], ...], however it arrived."""
    outer = (ring or {}).get("outer") if isinstance(ring, dict) else ring
    return outer or []


def validate_cleared(body):
    """Deck outlines the display has taken out of the city, or ValueError.

    A vertiport stands where its host building stood: the map does not draw
    that building, and this check must not measure a route against it either.
    Absent or empty means nothing has been cleared.
    """
    raw = (body or {}).get("cleared")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("cleared: list of outlines expected")
    if len(raw) > MAX_CLEARED_RINGS:
        raise ValueError(f"cleared: at most {MAX_CLEARED_RINGS} outlines")
    rings = []
    for index, ring in enumerate(raw):
        if not isinstance(ring, list):
            raise ValueError(f"cleared[{index}]: list of points expected")
        if len(ring) > MAX_CLEARED_POINTS:
            raise ValueError(f"cleared[{index}]: at most {MAX_CLEARED_POINTS} points")
        points = []
        for point in ring:
            try:
                if isinstance(point, dict):
                    longitude, latitude = float(point["longitude"]), float(point["latitude"])
                else:
                    longitude, latitude = float(point[0]), float(point[1])
            except (TypeError, KeyError, ValueError, IndexError):
                raise ValueError(f"cleared[{index}]: longitude and latitude expected") from None
            if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                raise ValueError(f"cleared[{index}]: outside the globe")
            points.append((longitude, latitude))
        # A ring of two points encloses nothing; it is dropped rather than refused.
        if len(points) >= 3:
            rings.append(points)
    return rings


def height_profile(u):
    """The eased height between two nodes, level at both ends (the display's curve)."""
    t = max(0.0, min(1.0, float(u)))
    return t * t * (3 - 2 * t)


def path_height(start_height, end_height, u):
    return start_height + (end_height - start_height) * height_profile(u)


def ground_along(grounds, u):
    """Ground height at fraction `u` of the link from the samples taken along it."""
    if not grounds:
        return 0.0
    if len(grounds) == 1:
        return float(grounds[0])
    position = max(0.0, min(1.0, float(u))) * (len(grounds) - 1)
    index = min(int(position), len(grounds) - 2)
    fraction = position - index
    return float(grounds[index]) * (1 - fraction) + float(grounds[index + 1]) * fraction


def half_width_of(link):
    width = link.get("width_m")
    try:
        width = float(width) if width is not None else 0.0
    except (TypeError, ValueError):
        width = 0.0
    return width / 2 if width > 0 else LINE_HALF_WIDTH_M


class LinkFrame:
    """Local metres along and across a link, from its start."""

    def __init__(self, start, end):
        self.lon0, self.lat0 = float(start["longitude"]), float(start["latitude"])
        self.cos_lat = math.cos(math.radians(self.lat0)) or 1e-9
        east = (float(end["longitude"]) - self.lon0) * METRES_PER_DEGREE * self.cos_lat
        north = (float(end["latitude"]) - self.lat0) * METRES_PER_DEGREE
        self.length = math.hypot(east, north)
        self.ux, self.uy = (east / self.length, north / self.length) if self.length > 0 else (1.0, 0.0)

    def local(self, longitude, latitude):
        east = (float(longitude) - self.lon0) * METRES_PER_DEGREE * self.cos_lat
        north = (float(latitude) - self.lat0) * METRES_PER_DEGREE
        return east * self.ux + north * self.uy, north * self.ux - east * self.uy   # along, across

    def bbox(self, half_width):
        """The degree box the strip lies in, for a cheap first rejection."""
        margin_lon = (half_width + 5) / (METRES_PER_DEGREE * self.cos_lat)
        margin_lat = (half_width + 5) / METRES_PER_DEGREE
        end_lon = self.lon0 + (self.ux * self.length) / (METRES_PER_DEGREE * self.cos_lat)
        end_lat = self.lat0 + (self.uy * self.length) / METRES_PER_DEGREE
        return (min(self.lon0, end_lon) - margin_lon, min(self.lat0, end_lat) - margin_lat,
                max(self.lon0, end_lon) + margin_lon, max(self.lat0, end_lat) + margin_lat)


def cells_for_link(link, cell_degrees=0.01):
    """The (column, row) cells the link's strip may touch."""
    frame = LinkFrame(link["from"], link["to"])
    lomin, lamin, lomax, lamax = frame.bbox(half_width_of(link))
    return [(column, row)
            for column in range(math.floor(lomin / cell_degrees), math.floor(lomax / cell_degrees) + 1)
            for row in range(math.floor(lamin / cell_degrees), math.floor(lamax / cell_degrees) + 1)]


def ring_bbox(ring):
    lons = [point[0] for point in ring]
    lats = [point[1] for point in ring]
    return (min(lons), min(lats), max(lons), max(lats))


def strip_hit(frame, ring, half_width):
    """Where the ring reaches into the strip: the along position nearest the
    centre line, or None. Vertices inside the strip count, and so does an edge
    that crosses the centre line with both ends outside it."""
    best = None
    points = [frame.local(lon, lat) for lon, lat in ring]
    for along, across in points:
        if 0 <= along <= frame.length and abs(across) <= half_width:
            if best is None or abs(across) < best[1]:
                best = (along, abs(across))
    for (a0, c0), (a1, c1) in zip(points, points[1:]):
        if (c0 < 0) == (c1 < 0) or c0 == c1:
            continue
        along = a0 + (a1 - a0) * (-c0 / (c1 - c0))
        if 0 <= along <= frame.length:
            if best is None or best[1] > 0:
                best = (along, 0.0)
    return best


def terrain_report(link):
    """Centre-line sample clearances only; absent terrain is not a safety result."""
    result = {"terrain_collisions": 0, "terrain_min_clearance_m": None, "terrain_checked": 0}
    samples = link.get("grounds") or []
    if link.get("terrain_available") is False or len(samples) < 2:
        return result
    start, end = float(link["from"]["height"]), float(link["to"]["height"])
    if not all(math.isfinite(float(value)) for value in [start, end, *samples]):
        return result
    clearances = [path_height(start, end, index / (len(samples) - 1)) - float(ground)
                  for index, ground in enumerate(samples)]
    return {"terrain_collisions": sum(value < 0 for value in clearances),
            "terrain_min_clearance_m": round(min(clearances), 1), "terrain_checked": len(samples)}


def check_link(link, buildings, cell_degrees=0.01, cleared=()):
    """Buildings under a link and the clearance to each. `link` carries from/to
    ({longitude, latitude, height}), width_m, and grounds (heights along).
    Returns {"buildings": [...worst first], "min_clearance_m", "collisions", "tight", "checked"}."""
    terrain = terrain_report(link)
    frame = LinkFrame(link["from"], link["to"])
    half_width = half_width_of(link)
    grounds = link.get("grounds") or [link["from"].get("ground", 0.0), link["to"].get("ground", 0.0)]
    start_height, end_height = float(link["from"]["height"]), float(link["to"]["height"])
    lomin, lamin, lomax, lamax = frame.bbox(half_width)
    found, checked = [], 0
    if frame.length <= 0:
        return {"buildings": [], "min_clearance_m": None, "collisions": 0, "tight": 0, "checked": 0, **terrain}
    for building in buildings:
        rings = building.get("rings") or []
        if not rings:
            continue
        # A building the display has taken out because a vertiport deck stands
        # on its ground is not under the route any more. Measuring it would
        # warn about a building nobody can see and nobody could hit.
        if cleared and overlaps_cleared(cleared, _outer_ring(rings[0])):
            continue
        checked += 1
        hit = None
        for ring in rings:
            outer = ring.get("outer") or []
            if len(outer) < 4:
                continue
            bx0, by0, bx1, by1 = building.get("bbox") or ring_bbox(outer)
            if bx1 < lomin or bx0 > lomax or by1 < lamin or by0 > lamax:
                continue
            candidate = strip_hit(frame, outer, half_width)
            if candidate is not None and (hit is None or candidate[1] < hit[1]):
                hit = candidate
        if hit is None:
            continue
        u = hit[0] / frame.length
        top = ground_along(grounds, u) + float(building.get("height_m") or 0.0)
        path = path_height(start_height, end_height, u)
        clearance = path - top
        if clearance >= TIGHT_CLEARANCE_M:
            continue
        found.append({"id": building.get("id", ""), "name": building.get("name", ""),
                      "height_m": round(float(building.get("height_m") or 0.0), 1), "top_m": round(top, 1),
                      "path_m": round(path, 1), "clearance_m": round(clearance, 1), "along_m": round(hit[0], 1),
                      "position": _position_at(frame, hit[0]), "collision": clearance < 0})
    found.sort(key=lambda item: item["clearance_m"])
    return {"buildings": found[:MAX_REPORTED], "checked": checked, **terrain,
            "min_clearance_m": found[0]["clearance_m"] if found else None,
            "collisions": sum(1 for item in found if item["collision"]),
            "tight": sum(1 for item in found if not item["collision"])}


def _position_at(frame, along):
    lon = frame.lon0 + (frame.ux * along) / (METRES_PER_DEGREE * frame.cos_lat)
    lat = frame.lat0 + (frame.uy * along) / METRES_PER_DEGREE
    return {"longitude": round(lon, 7), "latitude": round(lat, 7)}


def validate_request(body):
    """The links to check, or ValueError('field: reason')."""
    if not isinstance(body, dict) or not isinstance(body.get("links"), list):
        raise ValueError("links: list expected")
    if not body["links"]:
        raise ValueError("links: at least one link")
    if len(body["links"]) > MAX_LINKS_PER_REQUEST:
        raise ValueError(f"links: at most {MAX_LINKS_PER_REQUEST} per request")
    links = []
    for index, raw in enumerate(body["links"]):
        if not isinstance(raw, dict) or not raw.get("id"):
            raise ValueError(f"links[{index}].id: required")
        link = {"id": str(raw["id"]), "width_m": raw.get("width_m"), "segment": raw.get("segment")}
        for end in ("from", "to"):
            point = raw.get(end)
            try:
                link[end] = {"longitude": float(point["longitude"]), "latitude": float(point["latitude"]),
                             "height": float(point["height"]), "ground": float(point.get("ground", 0.0))}
            except (TypeError, KeyError, ValueError):
                raise ValueError(f"links[{index}].{end}: longitude, latitude and height expected") from None
            if not (-90 <= link[end]["latitude"] <= 90 and -180 <= link[end]["longitude"] <= 180):
                raise ValueError(f"links[{index}].{end}: outside the globe")
        if "terrain_available" in raw:
            link["terrain_available"] = raw["terrain_available"] is True
        grounds = raw.get("grounds")
        if grounds is not None:
            try:
                link["grounds"] = [float(value) for value in grounds]
            except (TypeError, ValueError):
                raise ValueError(f"links[{index}].grounds: numbers expected") from None
        links.append(link)
    return links
