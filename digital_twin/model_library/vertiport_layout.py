"""Vertiport definition and generated ground layout.

A vertiport definition is user-authored infrastructure data: where it is, how
it is named and oriented, which design aircraft it serves, how its gates
(stands) and FATOs (final approach and take-off areas) are arranged, what
each FATO is used for and which side of the deck it stands on. This module
validates a definition and compiles it into a ground layout in local metres: a
rectangular platform, FATO and gate circles with their safety areas, and an
explicit taxiway graph (nodes and edges) that later routing can use. It is
pure: no storage, transport or rendering.

The arrangements that line stands up along a taxiway put their FATOs off the
approach edge of the block; a FATO asked for on another side gets a taxiway
loop around the whole block to stand off, so departures can leave one end and
arrivals meet the other, or a FATO can face whatever the site has room for.
The arrangements that put the FATOs in the middle keep them there.

Dimensions are derived from the design aircraft's D-value (the diameter of the
smallest circle that encloses the aircraft) with the proportions used for VTOL
vertiport and heliport design (FATO 1.5 D, stand 1.2 D, safety area 0.25 D or
3 m, taxiway twice the undercarriage width). They are representative sandbox
values, not certification figures, and are reported in every layout so the
display never guesses them.
"""
import math

MAX_GATES = 20
MAX_FATOS = 8
# What a vertiport belongs to, in the operator's own words: a metropolitan area,
# a trial site, whatever the study is organised by. It is a plain label rather
# than a derived region because the grouping people work by is not always the
# one a coordinate implies -- Seoul and Incheon are one capital-area network
# here, and a test site is its own thing however close it sits to a city.
DEFAULT_GROUP = "미분류"
GROUP_MAX_LENGTH = 40
FATO_ROLES = ("takeoff", "landing", "both")
# Which side of the deck a FATO stands off, in the vertiport's own frame: the
# front is the approach edge the name faces, and the sides turn with the
# heading. Only the arrangements that line stands up can use them; the ones
# that put the FATOs in the middle report "center" instead.
FATO_SIDES = ("front", "back", "left", "right")
FATO_SIDE_LABELS = {"front": "앞 (진입면)", "back": "뒤", "left": "왼쪽", "right": "오른쪽"}
DEFAULT_FATO_SIDE = "front"
VEHICLE_D_RANGE = (4.0, 30.0)
PLATFORM_HEIGHT_RANGE = (0.0, 60.0)

# Arrangement families. Design frame: x east, y north, unrotated; the whole
# layout is later turned clockwise by the heading and centred on the platform.
PATTERNS = {
    "row": {"label": "가로 일렬", "description": "게이트를 가로로 한 줄, 유도로 건너편에 FATO 열"},
    "column": {"label": "세로 일렬", "description": "남북 유도로를 따라 게이트를 세로로, 끝에 FATO"},
    "double": {"label": "양옆 이중", "description": "남북 유도로 양옆에 게이트를 번갈아 배치, 끝에 FATO"},
    "flank": {"label": "FATO 중앙", "description": "FATO를 가운데 두고 게이트를 좌우 양옆에"},
    "split": {"label": "좌우 분기", "description": "게이트를 좌·우 두 무리로 나눠 유도로를 두 줄 두고 양 끝에서 이어 순환 경로를 만든다"},
    "radial": {"label": "원형 배치", "description": "중앙에 FATO를 원으로 두고 순환 유도로를 돌린 뒤 그 바깥을 게이트가 둘러싼다"},
    "court": {"label": "중정 사각", "description": "FATO를 가운데 두고 사각 순환 유도로를 돌린 뒤 네 변 바깥에 게이트를 둘러 세운다"},
}
DEFAULT_PATTERN = "row"
# The arrangements whose FATOs stand off an edge of the stand block, and so can
# be asked for on any side of it.
SIDED_PATTERNS = ("row", "column", "double", "split")

# Design aircraft classes by D-value. Representative, not type-specific data.
VEHICLE_CLASSES = [
    {"id": "small", "label": "소형 eVTOL (D 8 m)", "d_m": 8.0, "description": "2인승급 멀티콥터 규모"},
    {"id": "medium", "label": "중형 eVTOL (D 12 m)", "d_m": 12.0, "description": "4~5인승 틸트로터/리프트+크루즈 규모"},
    {"id": "large", "label": "대형 eVTOL (D 16 m)", "d_m": 16.0, "description": "6인승 이상 대형 기체 규모"},
    {"id": "custom", "label": "직접 입력", "d_m": None, "description": "D값(외접원 지름)을 직접 입력"},
]
DEFAULT_VEHICLE_CLASS = "medium"
DEFAULT_PLATFORM_HEIGHT_M = 1.0
DEFAULT_TERMINAL_HEIGHT_M = 30.0
# Sandbox operating bounds, not certified terminal procedures.
TERMINAL_HEIGHT_RANGE_M = (1.0, 300.0)

# How the deck height is chosen over uneven ground. `manual` uses altitude_m.
GROUND_REFERENCES = [
    {"id": "highest", "label": "최고 지면 (기본)", "description": "판 아래 가장 높은 지면 위에 상면을 둔다"},
    {"id": "mean", "label": "평균 지면", "description": "판 아래 지면의 평균 높이; 높은 쪽은 묻힌다"},
    {"id": "lowest", "label": "최저 지면", "description": "판 아래 가장 낮은 지면; 대부분 묻힌다"},
    {"id": "manual", "label": "직접 입력", "description": "기준 고도(타원체 고도, m)를 직접 입력"},
]
DEFAULT_GROUND_REFERENCE = "highest"

# ---------------------------------------------------------------- the people side
#
# A vertiport deck is a place people stand on, not only a place aircraft land
# on. Two things follow, and neither is decided by the arrangement: an edge
# nobody can walk off, and somewhere at each stand for them to come out of.
# Both are derived from the layout after it is laid out, so an arrangement this
# module has never heard of gets them too.
#
# Nothing here is a certified figure. The height is the ordinary one for edge
# protection; the shelter is the size of a small bus stop.

# Edge protection, right round the deck: how tall, how far in from the edge, and
# how often it is posted. Low enough to see over from inside and to sit under
# any approach surface, which is why it can go round the whole building.
BARRIER_HEIGHT_M = 1.1
BARRIER_INSET_M = 0.9
BARRIER_POST_PITCH_M = 3.0
# The shortest run worth building; shorter stubs are left out.
BARRIER_MIN_RUN_M = 2.0

# The boarding point at each stand: a small shelter people come out of, beside
# that stand's charging cabinet so the two read as one piece of stand equipment.
# It stands off the cabinet rather than beyond it, so it never pushes the deck
# out or reaches towards the taxiway.
BOARDING_SIZE_M = (3.6, 2.6)
BOARDING_HEIGHT_M = 2.8
BOARDING_GAP_M = 1.2

# What is lit after dark, and in what colour. A vertiport is lit the way an
# aerodrome is: the touchdown area's own perimeter in green, the taxi routes
# green down the middle and blue along their edges, and one flashing beacon so
# the site can be picked out from the air. The spacings are the ordinary ones
# -- a heliport's touchdown perimeter is lit every few metres, a taxiway's
# centreline every dozen or so, its edges further apart -- and are reported so
# the display places the lamps rather than inventing a pattern of its own.
# Representative figures, not a certified lighting design.
LIGHTING = {
    "fato_perimeter": {"colour": "green", "spacing_m": 5.0, "minimum": 8},
    "taxiway_centreline": {"colour": "green", "spacing_m": 12.0},
    "taxiway_edge": {"colour": "blue", "spacing_m": 18.0},
    "beacon": {"colour": "white", "period_s": 2.0, "flash_s": 0.35},
    "note": ("대표 제원입니다. FATO 주변등은 녹색, 유도로 중심선은 녹색, 유도로 가장자리는 청색, "
             "식별 비콘은 백색 섬광 — 실제 인증 조명 설계가 아닙니다."),
}


def dimensions_for(vehicle_d_m, undercarriage_m=None):
    """Ground dimensions in metres for a design aircraft of D-value `vehicle_d_m`."""
    d = float(vehicle_d_m)
    ucw = float(undercarriage_m) if undercarriage_m else 0.35 * d
    safety = max(0.25 * d, 3.0)          # safety area beyond the FATO edge
    clearance = max(0.25 * d, 3.0)       # kept between paved elements
    taxiway = 2.0 * ucw
    gate_r, fato_r = 0.6 * d, 0.75 * d
    # Every stand is charged from a small cabinet beside it: a square building
    # that fits inside charger_radius_m, standing clear of the stand circle by
    # more than the 2 m every pair of markings keeps apart, on the side the
    # stand's taxi route does not use.
    charger_r = max(1.0, 0.14 * d)
    dims = {
        "vehicle_d_m": d,
        "undercarriage_m": ucw,
        "fato_radius_m": fato_r,                       # FATO diameter 1.5 D; marking "F"
        "tlof_radius_m": 0.415 * d,                    # touchdown and lift-off area 0.83 D
        "safety_margin_m": safety,
        "gate_radius_m": gate_r,                       # stand diameter 1.2 D; marking "G<n>"
        "taxiway_width_m": taxiway,
        "gate_pitch_m": 2 * gate_r + max(0.5 * d, 3.0),
        "fato_pitch_m": 2 * fato_r + 2 * safety + d,
        "apron_offset_m": gate_r + taxiway / 2 + clearance,      # stand centre to spine centreline
        "fato_offset_m": fato_r + safety + taxiway / 2 + clearance,  # spine centreline to FATO centre
        "platform_margin_m": safety + 2.0,
        "charger_radius_m": charger_r,                          # circle the cabinet fits inside
        "charger_size_m": charger_r * math.sqrt(2),              # side of the square building
        "charger_height_m": max(2.2, 0.22 * d),
        "charger_offset_m": gate_r + 2.5 + charger_r,            # stand centre to cabinet centre
    }
    return {key: round(value, 2) for key, value in dims.items()}


def describe_options():
    """What a form can offer: patterns, vehicle classes, defaults and limits."""
    return {
        "patterns": [{"id": key, **value, "fato_sides": key in SIDED_PATTERNS} for key, value in PATTERNS.items()],
        "vehicle_classes": [dict(item) for item in VEHICLE_CLASSES],
        "fato_roles": list(FATO_ROLES),
        "fato_sides": [{"id": side, "label": FATO_SIDE_LABELS[side]} for side in FATO_SIDES],
        "ground_references": [dict(item) for item in GROUND_REFERENCES],
        "defaults": {"pattern": DEFAULT_PATTERN, "vehicle_class": DEFAULT_VEHICLE_CLASS, "group": DEFAULT_GROUP,
                     "vehicle_d_m": next(c["d_m"] for c in VEHICLE_CLASSES if c["id"] == DEFAULT_VEHICLE_CLASS),
                     "platform_height_m": DEFAULT_PLATFORM_HEIGHT_M, "ground_reference": DEFAULT_GROUND_REFERENCE,
                     "takeoff_height_m": DEFAULT_TERMINAL_HEIGHT_M, "landing_height_m": DEFAULT_TERMINAL_HEIGHT_M,
                     "gates": 4, "fatos": 1},
        "limits": {"gates": [1, MAX_GATES], "fatos": [1, MAX_FATOS],
                   "takeoff_height_m": list(TERMINAL_HEIGHT_RANGE_M), "landing_height_m": list(TERMINAL_HEIGHT_RANGE_M),
                   "group": [1, GROUP_MAX_LENGTH],
                   "vehicle_d_m": [int(VEHICLE_D_RANGE[0]), int(VEHICLE_D_RANGE[1])],
                   "platform_height_m": [int(PLATFORM_HEIGHT_RANGE[0]), int(PLATFORM_HEIGHT_RANGE[1])]},
        "rules": {"fato_diameter": "1.5 D", "stand_diameter": "1.2 D", "tlof_diameter": "0.83 D",
                  "safety_area": "0.25 D 또는 3 m", "taxiway_width": "착륙장치 폭의 2배 (미입력 시 0.35 D)"},
    }


def validate_definition(raw):
    """Return a normalised definition or raise ValueError('field: reason')."""
    if not isinstance(raw, dict):
        raise ValueError("definition: object expected")

    def number(key, low, high, required=True):
        value = raw.get(key)
        if value is None or value == "":
            if required:
                raise ValueError(f"{key}: required")
            return None
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key}: number expected") from None
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{key}: must be between {low} and {high}")
        return value

    name = str(raw.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("name: 1 to 80 characters")
    latitude = number("latitude", -90, 90)
    longitude = number("longitude", -180, 180)
    altitude = number("altitude_m", -500, 10000, required=False)
    heading = number("heading_deg", -360, 360, required=False)
    heading = 0.0 if heading is None else heading % 360
    pattern = str(raw.get("pattern") or DEFAULT_PATTERN).strip().lower()
    if pattern not in PATTERNS:
        raise ValueError(f"pattern: one of {', '.join(PATTERNS)}")
    vehicle_class = str(raw.get("vehicle_class") or "").strip().lower() or None
    classes = {item["id"]: item for item in VEHICLE_CLASSES}
    if vehicle_class is not None and vehicle_class not in classes:
        raise ValueError(f"vehicle_class: one of {', '.join(classes)}")
    vehicle_d = number("vehicle_d_m", *VEHICLE_D_RANGE, required=False)
    if vehicle_class is None:
        vehicle_class = "custom" if vehicle_d is not None else DEFAULT_VEHICLE_CLASS
    if classes[vehicle_class]["d_m"] is not None:
        vehicle_d = classes[vehicle_class]["d_m"]
    elif vehicle_d is None:
        raise ValueError("vehicle_d_m: required for a custom vehicle class")
    undercarriage = number("undercarriage_m", 0.5, VEHICLE_D_RANGE[1], required=False)
    if undercarriage is not None and undercarriage >= vehicle_d:
        raise ValueError("undercarriage_m: must be smaller than vehicle_d_m")
    platform_height = number("platform_height_m", *PLATFORM_HEIGHT_RANGE, required=False)
    if platform_height is None:
        platform_height = DEFAULT_PLATFORM_HEIGHT_M
    ground_reference = str(raw.get("ground_reference") or DEFAULT_GROUND_REFERENCE).strip().lower()
    if ground_reference not in {item["id"] for item in GROUND_REFERENCES}:
        raise ValueError(f"ground_reference: one of {', '.join(item['id'] for item in GROUND_REFERENCES)}")
    if ground_reference == "manual" and altitude is None:
        raise ValueError("altitude_m: required when ground_reference is manual")
    gates = raw.get("gates", 1)
    if isinstance(gates, bool) or not isinstance(gates, int) or not 1 <= gates <= MAX_GATES:
        try:
            gates = int(gates)
        except (TypeError, ValueError):
            raise ValueError(f"gates: integer 1 to {MAX_GATES}") from None
        if not 1 <= gates <= MAX_GATES:
            raise ValueError(f"gates: integer 1 to {MAX_GATES}")
    fatos_raw = raw.get("fatos")
    if fatos_raw is None:
        fatos_raw = [{"role": "both"}]
    if not isinstance(fatos_raw, list) or not 1 <= len(fatos_raw) <= MAX_FATOS:
        raise ValueError(f"fatos: list of 1 to {MAX_FATOS}")
    fatos = []
    for index, item in enumerate(fatos_raw, start=1):
        item = item if isinstance(item, dict) else {"role": item}
        role = str(item.get("role") or "both").strip().lower()
        if role not in FATO_ROLES:
            raise ValueError(f"fatos[{index}].role: one of {', '.join(FATO_ROLES)}")
        side = str(item.get("side") or DEFAULT_FATO_SIDE).strip().lower()
        if side not in FATO_SIDES:
            raise ValueError(f"fatos[{index}].side: one of {', '.join(FATO_SIDES)}")
        # An arrangement that keeps its FATOs in the middle has no sides to
        # offer, so a side chosen under another arrangement does not linger.
        if pattern not in SIDED_PATTERNS:
            side = DEFAULT_FATO_SIDE
        fatos.append({"id": f"F{index}", "role": role, "side": side})
    if len(fatos) == 1:
        fatos[0]["role"] = "both"   # the only FATO must serve arrivals and departures
    group = str(raw.get("group") or "").strip() or DEFAULT_GROUP
    if len(group) > GROUP_MAX_LENGTH:
        raise ValueError(f"group: 1 to {GROUP_MAX_LENGTH} characters")
    definition = {"name": name, "group": group, "latitude": latitude, "longitude": longitude,
                  "heading_deg": heading, "pattern": pattern,
                  "vehicle_class": vehicle_class, "vehicle_d_m": vehicle_d,
                  "platform_height_m": platform_height, "ground_reference": ground_reference,
                  "gates": gates, "fatos": fatos}
    if undercarriage is not None:
        definition["undercarriage_m"] = undercarriage
    for key in ("takeoff_height_m", "landing_height_m"):
        if isinstance(raw.get(key), bool):
            raise ValueError(f"{key}: number expected")
        value = number(key, *TERMINAL_HEIGHT_RANGE_M, required=False)
        definition[key] = DEFAULT_TERMINAL_HEIGHT_M if value is None else value
    if altitude is not None:
        definition["altitude_m"] = altitude
    for key in ("id", "created_at", "updated_at"):
        if raw.get(key):
            definition[key] = str(raw[key])
    return definition


def rotate(point, heading_deg):
    """Local (east, north) of an unrotated design point, heading clockwise from north."""
    angle = math.radians(heading_deg)
    x, y = point
    return (x * math.cos(angle) + y * math.sin(angle), -x * math.sin(angle) + y * math.cos(angle))


def _row(count, pitch):
    return [(index - (count - 1) / 2) * pitch for index in range(count)]


class _Design:
    """Nodes, stubs and straight taxiway lines in the unrotated design frame."""

    def __init__(self, dims):
        self.dims = dims
        self.gates, self.fatos, self.stubs, self.lines = [], [], [], []
        # Taxiways that are not axis aligned, and the stubs that reach them.
        self.rings, self.links = [], []

    def gate(self, index, x, y, along=None):
        """A stand at (x, y). `along` ('x' or 'y') runs its stub to the nearest
        taxiway line; without one the caller links the stand itself."""
        node = {"id": f"G{index}", "kind": "gate", "design_m": (x, y)}
        self.gates.append(node)
        if along:
            self.stubs.append((node, along, "stand"))
        return node

    def fato(self, fato, x, y, along=None):
        node = {"id": fato["id"], "kind": "fato", "role": fato["role"], "side": fato.get("side", DEFAULT_FATO_SIDE),
                "design_m": (x, y)}
        self.fatos.append(node)
        if along:
            self.stubs.append((node, along, "approach"))
        return node

    def line(self, axis, at, start, end):
        """A taxiway line along `axis` ('x' or 'y') at the other coordinate `at`.
        Collinear lines are one line, so a loop edge that falls on a bar the
        arrangement already has becomes that bar rather than a twin of it."""
        start, end = min(start, end), max(start, end)
        for line in self.lines:
            if line["axis"] == axis and abs(line["at"] - at) < 1e-6:
                line["start"], line["end"] = min(line["start"], start), max(line["end"], end)
                return
        self.lines.append({"axis": axis, "at": at, "start": start, "end": end})

    def ring(self, points):
        """A closed taxiway through explicit points, for layouts that are not
        laid out on axes. Its points become junctions a link can land on."""
        self.rings.append([(float(x), float(y)) for x, y in points])

    def link(self, node, point, kind):
        """A stub from a stand or FATO straight to a point on a ring."""
        self.links.append((node, (float(point[0]), float(point[1])), kind))


def _by_side(fatos):
    """The FATOs of a definition grouped by the side they were asked for."""
    sides = {side: [] for side in FATO_SIDES}
    for fato in fatos:
        sides[fato.get("side", DEFAULT_FATO_SIDE)].append(fato)
    return sides


def _charger_points(design, edges, dims):
    """Where each stand's charging cabinet goes: opposite the way the stand is
    taxied into, so it never stands on the route. Which way that is comes from
    the graph, so every arrangement — including the ring — places it alike."""
    entry = {item["from"]: item["design_m"][1] for item in edges if item["kind"] == "stand"}
    offset = dims["charger_offset_m"]
    points = []
    for node in design.gates:
        x, y = node["design_m"]
        towards = entry.get(node["id"])
        away = (0.0, -1.0)
        if towards is not None:
            dx, dy = x - towards[0], y - towards[1]
            length = math.hypot(dx, dy)
            if length > 1e-9:
                away = (dx / length, dy / length)
        points.append((x + away[0] * offset, y + away[1] * offset))
    return points


def _deck_edges(min_x, max_x, min_y, max_y):
    """The four sides of the deck rectangle, each as the span it runs over."""
    return [
        {"id": "-y", "axis": "x", "at": min_y, "span": (min_x, max_x)},
        {"id": "+y", "axis": "x", "at": max_y, "span": (min_x, max_x)},
        {"id": "-x", "axis": "y", "at": min_x, "span": (min_y, max_y)},
        {"id": "+x", "axis": "y", "at": max_x, "span": (min_y, max_y)},
    ]


def _barrier(min_x, max_x, min_y, max_y, fatos, dims, corner_radius=None):
    """Edge protection right round the deck.

    Every side carries it, including the sides a FATO departs over: at just over
    a metre it stands well below any approach surface, and an edge people can
    reach with nothing on it is the thing being avoided. It is still broken
    where a run would fall inside a FATO's own safety area, which the platform
    margin normally keeps it clear of anyway.

    A deck drawn with rounded corners (`corner_radius`, the radial pattern's
    full circle) gets its barrier along that rounded edge. Worked out on the
    rectangle, as every other deck is, the four straight runs stood in the air
    outside a round deck, squared off around a circle."""
    inset = BARRIER_INSET_M
    if corner_radius is not None:
        return _rounded_barrier(min_x, max_x, min_y, max_y, fatos, dims, corner_radius, inset)
    # The corners are rounded on the drawn deck, so a run stops short of them
    # and the corner itself is left open rather than cutting across it.
    corner = min(0.22 * min(max_x - min_x, max_y - min_y), 12.0) + inset
    runs = []
    for edge in _deck_edges(min_x + inset, max_x - inset, min_y + inset, max_y - inset):
        start_at, end_at = edge["span"][0] + corner, edge["span"][1] - corner
        if end_at - start_at < 2.0:
            continue
        blocked = []
        for node in fatos:
            x, y = node["design_m"]
            along, across = (x, y - edge["at"]) if edge["axis"] == "x" else (y, x - edge["at"])
            reach = dims["fato_radius_m"] + dims["safety_margin_m"]
            span = reach * reach - across * across
            if span > 0:
                width = math.sqrt(span)
                blocked.append((along - width, along + width))
        for piece in _without(start_at, end_at, blocked):
            if piece[1] - piece[0] < 2.0:
                continue
            runs.append([_on_edge(edge, piece[0]), _on_edge(edge, piece[1])])
    return {"height_m": BARRIER_HEIGHT_M, "inset_m": inset, "post_pitch_m": BARRIER_POST_PITCH_M,
            "runs": runs}


def _on_edge(edge, along):
    return (along, edge["at"]) if edge["axis"] == "x" else (edge["at"], along)


def _rounded_outline_points(min_x, max_x, min_y, max_y, radius, step=BARRIER_MIN_RUN_M + 0.5):
    """The deck's rounded outline as a closed ring of points, counter-clockwise.

    Straight sides between quarter arcs of `radius` at each corner; a radius of
    half the shorter side is a full semicircle at either end, which for a square
    deck is the circle the radial pattern draws. Every chord is at least a run
    worth building (`BARRIER_MIN_RUN_M`), so the rail is posts and panels rather
    than a polyline of stubs."""
    radius = max(0.0, min(radius, (max_x - min_x) / 2, (max_y - min_y) / 2))
    corners = [((max_x - radius, min_y + radius), -math.pi / 2), ((max_x - radius, max_y - radius), 0.0),
               ((min_x + radius, max_y - radius), math.pi / 2), ((min_x + radius, min_y + radius), math.pi)]
    points = []
    for (cx, cy), start in corners:
        if radius <= 0:
            points.append((cx, cy))
            continue
        count = max(1, math.floor(radius * math.pi / 2 / step))
        for index in range(count + 1):
            angle = start + (math.pi / 2) * index / count
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    # Consecutive duplicates come from arcs that meet with no straight side between them.
    ring = []
    for point in points:
        if not ring or math.dist(ring[-1], point) > 1e-6:
            ring.append(point)
    if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
        ring.pop()
    return ring


def _rounded_barrier(min_x, max_x, min_y, max_y, fatos, dims, corner_radius, inset):
    """Runs along the rounded edge, inset like the straight ones and broken the
    same way where a FATO's safety area reaches the edge."""
    ring = _rounded_outline_points(min_x + inset, max_x - inset, min_y + inset, max_y - inset,
                                   max(0.0, corner_radius - inset))
    reach = dims["fato_radius_m"] + dims["safety_margin_m"]
    blocked = [any(math.dist(point, node["design_m"]) < reach for node in fatos) for point in ring]
    count = len(ring)
    result = {"height_m": BARRIER_HEIGHT_M, "inset_m": inset, "post_pitch_m": BARRIER_POST_PITCH_M, "runs": []}
    if count < 2:
        return result
    if not any(blocked):
        # Nothing breaks it: one run right round, closed on itself.
        result["runs"] = [[*ring, ring[0]]]
        return result
    # Start at a blocked point so no run is split by the seam of the ring.
    first = blocked.index(True)
    runs, current = [], []
    for offset in range(1, count + 1):
        index = (first + offset) % count
        if blocked[index]:
            if len(current) >= 2:
                runs.append(current)
            current = []
        else:
            current.append(ring[index])
    if len(current) >= 2:
        runs.append(current)
    result["runs"] = [run for run in runs if sum(math.dist(a, b) for a, b in zip(run, run[1:])) >= BARRIER_MIN_RUN_M]
    return result


def _without(start, end, blocked):
    """`start`..`end` with every blocked span taken out of it."""
    pieces = [(start, end)]
    for low, high in blocked:
        cut = []
        for a, b in pieces:
            if high <= a or low >= b:
                cut.append((a, b))
                continue
            if a < low:
                cut.append((a, min(low, b)))
            if b > high:
                cut.append((max(high, a), b))
        pieces = cut
    return pieces


def _boarding_points(design, chargers, dims):
    """Where people come out at each stand: a shelter beside that stand's
    charging cabinet.

    Beside, not beyond: the cabinet already sits as far from the stand as the
    deck has room for, so the shelter steps sideways from it along the row. That
    keeps it off the stand circle, off the taxi route the stand is entered from,
    and inside the deck the cabinet is already inside."""
    points = []
    for node, charger in zip(design.gates, chargers):
        gate = node["design_m"]
        centre = charger["design_m"]
        away = (centre[0] - gate[0], centre[1] - gate[1])
        length = math.hypot(*away) or 1.0
        away = (away[0] / length, away[1] / length)
        # Along the row is across the way the cabinet was put out.
        beside = (-away[1], away[0])
        step = dims["charger_radius_m"] + BOARDING_GAP_M + BOARDING_SIZE_M[0] / 2
        place = (centre[0] + beside[0] * step, centre[1] + beside[1] * step)
        wide = abs(beside[0]) >= abs(beside[1])
        points.append({
            "id": f"B{len(points) + 1}", "gate": node["id"], "charger": charger["id"],
            "design_m": place, "radius_m": max(BOARDING_SIZE_M) / 2,
            "size_m": list(BOARDING_SIZE_M) if wide else [BOARDING_SIZE_M[1], BOARDING_SIZE_M[0]],
            "height_m": BOARDING_HEIGHT_M, "along": "x" if wide else "y",
        })
    return points


def _perimeter(design, dims, front_at, sides):
    """A taxiway loop around the stand block for the FATOs asked for on its
    back, left and right. The line the front FATOs already stand off becomes
    the loop's top edge; the other three edges go round everything the block
    has — stands, their cabinets, its taxiways — at the same clearance every
    paved element keeps, and each FATO stands off its edge by the usual
    approach offset with a stub straight to it. Rows on adjacent sides cannot
    meet: each row's ends are kept inside the loop's span, so two FATOs at a
    corner are a diagonal apart, further than two on one edge."""
    if not (sides["back"] or sides["left"] or sides["right"]):
        return
    half = dims["taxiway_width_m"] / 2
    pad = max(0.25 * dims["vehicle_d_m"], 3.0) + half
    reach = dims["fato_radius_m"] + dims["safety_margin_m"] + pad
    pitch, offset = dims["fato_pitch_m"], dims["fato_offset_m"]
    _, edges = _graph(design)
    items = [(node["design_m"], dims["gate_radius_m"]) for node in design.gates]
    items += [(point, dims["charger_radius_m"]) for point in _charger_points(design, edges, dims)]
    for line in design.lines:
        for at in (line["start"], line["end"]):
            items.append(((at, line["at"]) if line["axis"] == "x" else (line["at"], at), half))
    west, east = min(p[0] - r for p, r in items) - pad, max(p[0] + r for p, r in items) + pad
    south, north = min(p[1] - r for p, r in items) - pad, front_at
    # The front row stands outside the top edge already, but the edge must
    # reach past it so a FATO on a side is clear of the corner.
    for node in design.fatos:
        west, east = min(west, node["design_m"][0] - reach), max(east, node["design_m"][0] + reach)
    span = lambda fatos: (len(fatos) - 1) * pitch / 2 + reach
    if sides["back"]:
        centre = (west + east) / 2
        west, east = min(west, centre - span(sides["back"])), max(east, centre + span(sides["back"]))
    across = max((span(sides[side]) for side in ("left", "right") if sides[side]), default=0.0)
    # A side row is centred on the block, and pushed down when it would
    # otherwise reach past the top edge.
    centre_y = min((south + north) / 2, north - across)
    south = min(south, centre_y - across)
    # The block's own taxiways reach the loop; the loop closes the rectangle.
    for line in design.lines:
        if line["axis"] == "x":
            line["start"], line["end"] = min(line["start"], west), max(line["end"], east)
        else:
            line["start"], line["end"] = min(line["start"], south), max(line["end"], north)
    design.line("x", north, west, east)
    design.line("x", south, west, east)
    design.line("y", west, south, north)
    design.line("y", east, south, north)
    centre_x = (west + east) / 2
    for fato, x in zip(sides["back"], _row(len(sides["back"]), pitch)):
        design.fato(fato, centre_x + x, south - offset, "y")
    for fato, y in zip(sides["left"], _row(len(sides["left"]), pitch)):
        design.fato(fato, west - offset, centre_y + y, "x")
    for fato, y in zip(sides["right"], _row(len(sides["right"]), pitch)):
        design.fato(fato, east + offset, centre_y + y, "x")


def _design_row(count, fatos, dims):
    sides = _by_side(fatos)
    design = _Design(dims)
    gate_xs, fato_xs = _row(count, dims["gate_pitch_m"]), _row(len(sides["front"]), dims["fato_pitch_m"])
    for index, x in enumerate(gate_xs, start=1):
        design.gate(index, x, -dims["apron_offset_m"], "y")
    for fato, x in zip(sides["front"], fato_xs):
        design.fato(fato, x, dims["fato_offset_m"], "y")
    xs = gate_xs + fato_xs
    design.line("x", 0.0, min(xs), max(xs))
    _perimeter(design, dims, 0.0, sides)
    return design


def _design_flank(count, fatos, dims):
    design = _Design(dims)
    fato_xs = _row(len(fatos), dims["fato_pitch_m"])
    for fato, x in zip(fatos, fato_xs):
        design.fato(fato, x, dims["fato_offset_m"], "y")
    gap = dims["fato_radius_m"] + dims["safety_margin_m"] + max(0.25 * dims["vehicle_d_m"], 3.0) + dims["gate_radius_m"]
    left_count = math.ceil(count / 2)
    xs = []
    for index in range(count):
        side, slot = (-1, index) if index < left_count else (1, index - left_count)
        x = side * (max(abs(fato_xs[0]), abs(fato_xs[-1])) + gap + slot * dims["gate_pitch_m"])
        design.gate(index + 1, x, dims["apron_offset_m"], "y")
        xs.append(x)
    design.line("x", 0.0, min(xs + fato_xs), max(xs + fato_xs))
    return design


def _design_column(count, fatos, dims, both_sides):
    sides = _by_side(fatos)
    design = _Design(dims)
    levels = []
    for index in range(count):
        side = (-1 if index % 2 else 1) if both_sides else 1
        level = index // 2 if both_sides else index
        y = level * dims["gate_pitch_m"]
        design.gate(index + 1, side * dims["apron_offset_m"], y, "x")
        levels.append(y)
    bar_y = max(levels) + dims["apron_offset_m"]
    fato_xs = _row(len(sides["front"]), dims["fato_pitch_m"])
    for fato, x in zip(sides["front"], fato_xs):
        design.fato(fato, x, bar_y + dims["fato_offset_m"], "y")
    design.line("y", 0.0, min(levels), bar_y)
    # The cross bar carries the FATO approaches; with one FATO it is a single junction.
    design.line("x", bar_y, min(fato_xs + [0.0]), max(fato_xs + [0.0]))
    _perimeter(design, dims, bar_y, sides)
    return design


def _design_split(count, fatos, dims):
    """Two spines side by side, each serving its own block of stands, joined at
    both ends so every stand has a way round as well as a way out."""
    sides = _by_side(fatos)
    design = _Design(dims)
    apron = dims["apron_offset_m"]
    # Far enough apart that the two blocks' inner charging points clear each other.
    spine = apron + dims["charger_offset_m"] + dims["charger_radius_m"] + 1.05
    left_count = math.ceil(count / 2)
    levels = [0.0]
    index = 0
    for centre, block in ((-spine, left_count), (spine, count - left_count)):
        for slot in range(block):
            index += 1
            y = (slot // 2) * dims["gate_pitch_m"]
            design.gate(index, centre + (-apron if slot % 2 else apron), y, "x")
            levels.append(y)
    top, bottom = max(levels) + apron, -apron
    fato_xs = _row(len(sides["front"]), dims["fato_pitch_m"])
    for fato, x in zip(sides["front"], fato_xs):
        design.fato(fato, x, top + dims["fato_offset_m"], "y")
    design.line("y", -spine, bottom, top)
    design.line("y", spine, bottom, top)
    design.line("x", top, min(fato_xs + [-spine]), max(fato_xs + [spine]))
    design.line("x", bottom, -spine, spine)
    _perimeter(design, dims, top, sides)
    return design


def _design_court(count, fatos, dims):
    """FATOs in the middle of the deck, a rectangular taxiway loop around them,
    and the stands on the outside of the loop on all four sides: the square
    site's answer to the ring. Stands go to the front and back first, so the
    long edges fill before the short ones; every row is centred on its edge
    and the loop is stretched to hold the longest."""
    design = _Design(dims)
    half = dims["taxiway_width_m"] / 2
    pad = max(0.25 * dims["vehicle_d_m"], 3.0) + half
    offset, apron = dims["fato_offset_m"], dims["apron_offset_m"]
    fato_xs = _row(len(fatos), dims["fato_pitch_m"])
    for fato, x in zip(fatos, fato_xs):
        design.fato(fato, x, 0.0, "y")
    reach = dims["fato_radius_m"] + dims["safety_margin_m"] + pad
    west, east = min(fato_xs) - reach, max(fato_xs) + reach
    south, north = -offset, offset
    order = ("front", "back", "left", "right")
    rows = {side: [] for side in order}
    for index in range(count):
        rows[order[index % 4]].append(index + 1)
    span = lambda gates: (len(gates) - 1) * dims["gate_pitch_m"] / 2 + dims["gate_radius_m"] + pad
    for side in ("front", "back"):
        if rows[side]:
            west, east = min(west, -span(rows[side])), max(east, span(rows[side]))
    for side in ("left", "right"):
        if rows[side]:
            south, north = min(south, -span(rows[side])), max(north, span(rows[side]))
    # The front edge first, so a FATO midway between the two attaches to it.
    design.line("x", north, west, east)
    design.line("x", south, west, east)
    design.line("y", west, south, north)
    design.line("y", east, south, north)
    pitch = dims["gate_pitch_m"]
    for index, x in zip(rows["front"], _row(len(rows["front"]), pitch)):
        design.gate(index, x, north + apron, "y")
    for index, x in zip(rows["back"], _row(len(rows["back"]), pitch)):
        design.gate(index, x, south - apron, "y")
    for index, y in zip(rows["left"], _row(len(rows["left"]), pitch)):
        design.gate(index, west - apron, y, "x")
    for index, y in zip(rows["right"], _row(len(rows["right"]), pitch)):
        design.gate(index, east + apron, y, "x")
    design.gates.sort(key=lambda node: int(node["id"][1:]))
    return design


def _design_radial(count, fatos, dims):
    """FATOs on a circle at the centre, a taxiway ring around them and the
    stands facing in from a wider circle."""
    design = _Design(dims)
    half = dims["taxiway_width_m"] / 2
    clearance = max(0.25 * dims["vehicle_d_m"], 3.0)
    safety = dims["fato_radius_m"] + dims["safety_margin_m"]
    # A single FATO stands on the centre; more share a circle wide enough to
    # keep their safety areas apart.
    fato_radius = 0.0 if len(fatos) == 1 else (safety + 1.05) / math.sin(math.pi / len(fatos))
    ring_radius = fato_radius + safety + clearance + half
    gate_radius = dims["gate_radius_m"]
    # The stand circle clears the ring, the neighbouring stands, and — because a
    # stub is radial — the line every neighbouring stub runs along.
    wanted = [ring_radius + gate_radius + half + clearance]
    if count > 1:
        wanted.append((gate_radius + 1.05) / math.sin(math.pi / count))
    if count > 2:
        wanted.append((gate_radius + half + 0.5) / math.sin(2 * math.pi / count))
    stand_radius = max(wanted)

    def around(items, start):
        return [start + 2 * math.pi * index / len(items) for index in range(len(items))]

    gate_angles = around(range(count), -math.pi / 2)
    fato_angles = [0.0] if len(fatos) == 1 else around(fatos, math.pi / 2)
    on = lambda radius, angle: (radius * math.cos(angle), radius * math.sin(angle))
    for index, angle in enumerate(gate_angles, start=1):
        node = design.gate(index, *on(stand_radius, angle))
        design.link(node, on(ring_radius, angle), "stand")
    for fato, angle in zip(fatos, fato_angles):
        node = design.fato(fato, *on(fato_radius, angle))
        design.link(node, on(ring_radius, angle), "approach")
    # The ring passes through every stub point; the rest of its corners are
    # spaced evenly so it reads as a circle rather than a polygon.
    step = 2 * math.pi / _RING_CORNERS
    angles = sorted((angle % (2 * math.pi)) for angle in set(gate_angles + fato_angles))
    for corner in range(_RING_CORNERS):
        angle = corner * step
        apart = min(min(abs(angle - kept), 2 * math.pi - abs(angle - kept)) for kept in angles)
        if apart > step / 3:
            angles.append(angle)
    design.ring([on(ring_radius, angle) for angle in sorted(angles)])
    return design


_RING_CORNERS = 36

_DESIGNERS = {
    "row": lambda count, fatos, dims: _design_row(count, fatos, dims),
    "flank": lambda count, fatos, dims: _design_flank(count, fatos, dims),
    "column": lambda count, fatos, dims: _design_column(count, fatos, dims, both_sides=False),
    "double": lambda count, fatos, dims: _design_column(count, fatos, dims, both_sides=True),
    "split": lambda count, fatos, dims: _design_split(count, fatos, dims),
    "radial": lambda count, fatos, dims: _design_radial(count, fatos, dims),
    "court": lambda count, fatos, dims: _design_court(count, fatos, dims),
}


def _graph(design):
    """Nodes and edges from a design: stubs meet the nearest line, lines are split at junctions."""
    junctions = {}
    nodes = list(design.gates) + list(design.fatos)
    edges = []
    on_line = {id(line): [] for line in design.lines}

    def junction(point):
        key = (round(point[0], 6), round(point[1], 6))
        if key not in junctions:
            node = {"id": f"J{len(junctions) + 1}", "kind": "junction", "design_m": point}
            junctions[key] = node
            nodes.append(node)
        return junctions[key]

    def edge(start, end, kind):
        points = (start["design_m"], end["design_m"])
        length = math.dist(*points)
        if length <= 1e-9:
            return
        edges.append({"id": f"E{len(edges) + 1}", "from": start["id"], "to": end["id"], "kind": kind,
                      "length_m": length, "design_m": points})

    for node, along, kind in design.stubs:
        x, y = node["design_m"]
        # The stub runs along one axis until it meets a line of the other axis.
        candidates = [line for line in design.lines if line["axis"] != along
                      and line["start"] - 1e-6 <= (x if along == "y" else y) <= line["end"] + 1e-6]
        line = min(candidates, key=lambda item: abs(item["at"] - (y if along == "y" else x)))
        point = (x, line["at"]) if along == "y" else (line["at"], y)
        target = junction(point)
        on_line[id(line)].append(target)
        edge(node, target, kind)
    # Lines meet each other where one ends on the other.
    for line in design.lines:
        for other in design.lines:
            if other is line or other["axis"] == line["axis"]:
                continue
            for end in (line["start"], line["end"]):
                point = (end, line["at"]) if line["axis"] == "x" else (line["at"], end)
                across, along = (point[1], point[0]) if other["axis"] == "x" else (point[0], point[1])
                if abs(across - other["at"]) < 1e-6 and other["start"] - 1e-6 <= along <= other["end"] + 1e-6:
                    target = junction(point)
                    on_line[id(line)].append(target)
                    on_line[id(other)].append(target)
    for points in design.rings:
        corners = [junction(point) for point in points]
        for start, end in zip(corners, corners[1:] + corners[:1]):
            edge(start, end, "spine")
    for node, point, kind in design.links:
        edge(node, junction(point), kind)
    for line in design.lines:
        index = 0 if line["axis"] == "x" else 1
        ordered = sorted({node["id"]: node for node in on_line[id(line)]}.values(), key=lambda node: node["design_m"][index])
        for left, right in zip(ordered, ordered[1:]):
            edge(left, right, "spine")
    return nodes, edges


def generate_layout(definition):
    """Compile a validated definition into a platform, circles and a taxiway graph."""
    dims = dimensions_for(definition["vehicle_d_m"], definition.get("undercarriage_m"))
    heading = float(definition["heading_deg"])
    pattern = definition.get("pattern", DEFAULT_PATTERN)
    design = _DESIGNERS[pattern](int(definition["gates"]), definition["fatos"], dims)
    # FATOs read in the order they were defined, whichever side placed them last.
    order = {fato["id"]: index for index, fato in enumerate(definition["fatos"])}
    design.fatos.sort(key=lambda node: order[node["id"]])
    nodes, edges = _graph(design)

    # A charging point per stand, opposite the way the stand is taxied into.
    charger_radius = dims["charger_radius_m"]
    chargers = [{"id": f"C{index}", "gate": node["id"], "design_m": point}
                for index, (node, point) in enumerate(zip(design.gates, _charger_points(design, edges, dims)), start=1)]
    # Where people come out at each stand, beside that stand's cabinet.
    boarding = _boarding_points(design, chargers, dims)

    # Platform rectangle: everything paved plus the safety margin, then centred.
    half_width = dims["taxiway_width_m"] / 2
    extents = []
    for node in design.gates:
        extents.append((node["design_m"], dims["gate_radius_m"]))
    for node in design.fatos:
        extents.append((node["design_m"], dims["fato_radius_m"] + dims["safety_margin_m"]))
    for item in chargers:
        extents.append((item["design_m"], charger_radius))
    for item in boarding:
        extents.append((item["design_m"], item["radius_m"]))
    for item in edges:
        extents.extend((point, half_width) for point in item["design_m"])
    margin = dims["platform_margin_m"]
    min_x = min(p[0] - r for p, r in extents) - margin
    max_x = max(p[0] + r for p, r in extents) + margin
    min_y = min(p[1] - r for p, r in extents) - margin
    max_y = max(p[1] + r for p, r in extents) + margin
    # An empty strip along the far edge carries the painted name, as an apron
    # does. Every arrangement puts its FATOs at the top of the design frame, so
    # the name reads from the approach rather than from the back of the deck.
    name_height = max(4.0, round(0.4 * dims["vehicle_d_m"], 2))
    strip = name_height + 2 * 1.5
    name_area = {"along": "x", "design_center": ((min_x + max_x) / 2, max_y + strip / 2),
                 "length_m": round(max_x - min_x - 2 * margin, 3)}
    max_y += strip
    shift = ((min_x + max_x) / 2, (min_y + max_y) / 2)

    def place(point):
        east, north = rotate((point[0] - shift[0], point[1] - shift[1]), heading)
        return [round(east, 3), round(north, 3)]

    corners = [place(p) for p in ((min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y))]
    # The people side, worked out on the finished rectangle: the edge they
    # cannot walk off, and the walk that takes them between the stands and the
    # way down. Both are derived here and only placed below, so they turn with
    # the rest of the layout instead of being rebuilt for every heading.
    barrier = _barrier(min_x, max_x, min_y, max_y, design.fatos, dims,
                       corner_radius=min(max_x - min_x, max_y - min_y) / 2 if pattern == "radial" else None)
    layout = {
        "schema_version": 2,
        "pattern": pattern,
        "pattern_label": PATTERNS[pattern]["label"],
        "frame": {"latitude": definition["latitude"], "longitude": definition["longitude"],
                  "altitude_m": definition.get("altitude_m"), "heading_deg": heading},
        "dimensions": dims,
        "takeoff_height_m": float(definition.get("takeoff_height_m", DEFAULT_TERMINAL_HEIGHT_M)),
        "landing_height_m": float(definition.get("landing_height_m", DEFAULT_TERMINAL_HEIGHT_M)),
        "ground_reference": definition.get("ground_reference", DEFAULT_GROUND_REFERENCE),
        "platform": {"corners_m": corners, "height_m": float(definition.get("platform_height_m", DEFAULT_PLATFORM_HEIGHT_M)),
                     "size_m": [round(max_x - min_x, 3), round(max_y - min_y, 3)],
                     **({"corner_radius_m": round(min(max_x - min_x, max_y - min_y) / 2, 3)} if pattern == "radial" else {})},
        "name_area": {"center_m": place(name_area["design_center"]), "along": name_area["along"],
                      "length_m": name_area["length_m"], "height_m": round(name_height, 3), "strip_m": round(strip, 3)},
        "fatos": [{"id": node["id"], "role": node["role"], "marking": "F", "center_m": place(node["design_m"]),
                   "side": node["side"] if pattern in SIDED_PATTERNS else "center",
                   "radius_m": dims["fato_radius_m"], "tlof_radius_m": dims["tlof_radius_m"],
                   "safety_radius_m": round(dims["fato_radius_m"] + dims["safety_margin_m"], 2)} for node in design.fatos],
        "gates": [{"id": node["id"], "marking": node["id"], "center_m": place(node["design_m"]),
                   "radius_m": dims["gate_radius_m"]} for node in design.gates],
        "chargers": [{"id": item["id"], "gate": item["gate"], "center_m": place(item["design_m"]),
                      "radius_m": round(charger_radius, 2)} for item in chargers],
        "nodes": [{"id": node["id"], "kind": node["kind"], "position_m": place(node["design_m"]),
                   **({"role": node["role"]} if "role" in node else {})} for node in nodes],
        "edges": [{"id": item["id"], "from": item["from"], "to": item["to"], "kind": item["kind"],
                   "length_m": round(item["length_m"], 3), "width_m": dims["taxiway_width_m"],
                   "points_m": [place(p) for p in item["design_m"]]} for item in edges],
        "barrier": {**{key: barrier[key] for key in ("height_m", "inset_m", "post_pitch_m")},
                    "runs_m": [[place(point) for point in run] for run in barrier["runs"]]},
        "lighting": {**LIGHTING, "beacon": {**LIGHTING["beacon"],
                     "center_m": place(name_area["design_center"])}},
        "boarding_points": [{"id": item["id"], "gate": item["gate"], "charger": item["charger"],
                             "center_m": place(item["design_m"]), "size_m": item["size_m"],
                             "height_m": item["height_m"], "along": item["along"]}
                            for item in boarding],
    }
    layout["bounds_m"] = {"min": [round(min(c[0] for c in corners), 3), round(min(c[1] for c in corners), 3)],
                          "max": [round(max(c[0] for c in corners), 3), round(max(c[1] for c in corners), 3)]}
    layout["note"] = ("Generated ground layout with representative dimensions derived from the design "
                      "aircraft D-value; not a surveyed or certified vertiport design.")
    return layout
