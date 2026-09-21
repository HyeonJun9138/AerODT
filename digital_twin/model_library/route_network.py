"""UAM route network: waypoint nodes, segment links and the FATO endpoints.

A route is user-authored infrastructure data, like a vertiport: nodes are
waypoints with a position and an altitude, links join two nodes with a corridor
width and a flight-profile segment. The segments follow the UAM flight profile
used for the vertiport work: the vertical take-off (B) and landing (J) are part
of the vertiport's FATO, so a route starts at a take-off FATO with the climb-out
(C) and ends at a landing FATO with the descent (G). The climb-out and the
descent are each flown as one diagonal, so the letters they cover are merged.
This module validates definitions and derives the FATO endpoints from
vertiport layouts. It is pure: no storage, transport or rendering.
"""
import math
from .vertiport_layout import DEFAULT_TERMINAL_HEIGHT_M

# The selectable parts of the flight profile. The climb out of a vertiport is
# flown as one diagonal, so C, D and E are drawn and chosen together, and the
# descent likewise joins G, H and I. B and J are the vertical phases over a
# FATO and belong to the vertiport; A and K are the ground taxi on its deck.
SEGMENTS = [
    {"id": "C", "label": "Climb-out", "korean": "상승", "phase": "departure", "color": "#ffb457",
     "covers": "C–E",
     "parts": ["C 전환 상승", "D 출발 터미널 절차", "E 가속 상승"]},
    {"id": "F", "label": "Cruise", "korean": "순항", "phase": "cruise", "color": "#7fe9f5",
     "covers": "F", "parts": ["F 순항"]},
    {"id": "G", "label": "Descent", "korean": "강하", "phase": "arrival", "color": "#a5c8ff",
     "covers": "G–I",
     "parts": ["G 감속 강하", "H 도착 터미널 절차", "I 전환 강하"]},
]
SEGMENT_IDS = tuple(item["id"] for item in SEGMENTS)
# The letters that used to be chosen on their own, folded into the run they are
# part of, so a link saved before the profile was joined up still reads.
MERGED_SEGMENTS = {"D": "C", "E": "C", "H": "G", "I": "G"}
# The one segment that is a corridor with a width; the others are lines.
CORRIDOR_SEGMENT = "F"
# What usually follows a segment when the next link is drawn from the same node.
NEXT_SEGMENT = {"C": "F", "F": "F", "G": "G"}
# A FATO decides the segment: a route leaves one climbing and meets one descending.
DEPARTURE_SEGMENT = "C"
ARRIVAL_SEGMENT = "G"

ALTITUDE_REFERENCES = [
    {"id": "agl", "label": "지면 기준 (AGL)", "description": "지점 아래 지면에서 잰 높이"},
    {"id": "msl", "label": "절대 고도", "description": "타원체 기준 절대 높이 (m)"},
]
FEET_PER_METRE = 1 / 0.3048
DEFAULT_ALTITUDE_FT = 1000.0
DEFAULT_ALTITUDE_M = round(DEFAULT_ALTITUDE_FT * 0.3048, 3)   # 304.8
DEFAULT_ALTITUDE_REFERENCE = "agl"
DEFAULT_WIDTH_M = 300.0
WIDTH_RANGE_M = (20.0, 5000.0)
ALTITUDE_RANGE_M = (0.0, 10000.0)
# The top of the vertical take-off or landing phase over a FATO: where a route
# leaves or meets the vertiport. Representative, not a procedure figure.
FATO_HOVER_M = DEFAULT_TERMINAL_HEIGHT_M
DEFAULT_NODE_NAME = "지점"
MAX_NAME = 80

FATO_PREFIX = "fato:"


def describe_options():
    """What an editor can offer: segments, references, defaults and limits."""
    return {
        "segments": [dict(item) for item in SEGMENTS],
        "next_segment": dict(NEXT_SEGMENT),
        "altitude_references": [dict(item) for item in ALTITUDE_REFERENCES],
        "defaults": {"altitude_m": DEFAULT_ALTITUDE_M, "altitude_ft": DEFAULT_ALTITUDE_FT,
                     "altitude_reference": DEFAULT_ALTITUDE_REFERENCE, "width_m": DEFAULT_WIDTH_M,
                     "fato_hover_m": FATO_HOVER_M, "segment": "F", "corridor_segment": CORRIDOR_SEGMENT},
        "limits": {"width_m": list(WIDTH_RANGE_M), "altitude_m": list(ALTITUDE_RANGE_M), "name": MAX_NAME},
        "merged_segments": dict(MERGED_SEGMENTS),
        "fato_segments": {"departure": DEPARTURE_SEGMENT, "arrival": ARRIVAL_SEGMENT},
        # What the vertiport owns at either end of a route, for the picture the
        # editor draws: the deck taxi and the vertical phase over the FATO.
        "profile": {"A": "Ground Taxi", "B": "Vertical Take-off (FATO)",
                    "J": "Vertical Landing (FATO)", "K": "Ground Taxi"},
    }


def _number(raw, key, low, high, required=True, default=None):
    value = raw.get(key)
    if value is None or value == "":
        if required and default is None:
            raise ValueError(f"{key}: required")
        return default
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key}: number expected") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{key}: must be between {low} and {high}")
    return value


def _name(raw, key="name", fallback=None):
    name = str(raw.get(key) or "").strip()
    if not name:
        if fallback is None:
            raise ValueError(f"{key}: required")
        name = fallback
    if len(name) > MAX_NAME:
        raise ValueError(f"{key}: at most {MAX_NAME} characters")
    return name


def unique_name(base, existing):
    """`base`, or `base 2`, `base 3`… when it is already taken. A place name
    serves many waypoints, so the number tells them apart."""
    base = str(base or DEFAULT_NODE_NAME).strip() or DEFAULT_NODE_NAME
    taken = {str(name).strip() for name in existing}
    if base not in taken:
        return base
    index = 2
    while f"{base} {index}" in taken:
        index += 1
    return f"{base} {index}"


def validate_node(raw, existing_names=()):
    """A normalised waypoint or ValueError('field: reason'). A blank name is
    given from `place_name` (what the display found nearby) or the default,
    numbered to be unique among `existing_names`."""
    if not isinstance(raw, dict):
        raise ValueError("node: object expected")
    given = str(raw.get("name") or "").strip()
    if given:
        name = _name(raw)
    else:
        name = unique_name(str(raw.get("place_name") or "").strip() or DEFAULT_NODE_NAME, existing_names)
    latitude = _number(raw, "latitude", -90, 90)
    longitude = _number(raw, "longitude", -180, 180)
    altitude = _number(raw, "altitude_m", *ALTITUDE_RANGE_M, required=False, default=DEFAULT_ALTITUDE_M)
    reference = str(raw.get("altitude_reference") or DEFAULT_ALTITUDE_REFERENCE).strip().lower()
    if reference not in {item["id"] for item in ALTITUDE_REFERENCES}:
        raise ValueError("altitude_reference: one of agl, msl")
    node = {"name": name, "latitude": latitude, "longitude": longitude,
            "altitude_m": round(altitude, 3), "altitude_reference": reference}
    for key in ("id", "created_at", "updated_at"):
        if raw.get(key):
            node[key] = str(raw[key])
    return node


def is_fato(identifier):
    return isinstance(identifier, str) and identifier.startswith(FATO_PREFIX)


def fato_id(vertiport_id, fato):
    return f"{FATO_PREFIX}{vertiport_id}:{fato}"


def fato_endpoints(vertiports):
    """The FATO endpoints of wire-shaped vertiport records (with layouts): where
    a route can start (take-off FATO) or end (landing FATO). Positions are the
    FATO centres; the display stands them at the deck plus the hover height."""
    endpoints = []
    metres_per_degree = 111320.0
    for record in vertiports or []:
        layout = record.get("layout") or {}
        frame = layout.get("frame") or {}
        latitude, longitude = frame.get("latitude", record.get("latitude")), frame.get("longitude", record.get("longitude"))
        if latitude is None or longitude is None:
            continue
        cos_lat = math.cos(math.radians(float(latitude))) or 1e-9
        heights = {key: float(record.get(key, layout.get(key, FATO_HOVER_M)))
                   for key in ("takeoff_height_m", "landing_height_m")}
        for fato in layout.get("fatos") or []:
            east, north = fato.get("center_m") or (0.0, 0.0)
            endpoints.append({
                "id": fato_id(record["id"], fato["id"]), "kind": "fato",
                "name": f"{record.get('name', '')} {fato['id']}".strip(),
                "vertiport": record["id"], "vertiport_name": record.get("name", ""), "fato": fato["id"],
                "role": fato.get("role", "both"),
                "latitude": round(float(latitude) + north / metres_per_degree, 7),
                "longitude": round(float(longitude) + east / (metres_per_degree * cos_lat), 7),
                "platform_height_m": float((layout.get("platform") or {}).get("height_m", 0.0) or 0.0),
                **heights,
                # Older consumers have one height. Shared pads need the two
                # directional fields when used as arrival/departure endpoints.
                "hover_m": heights["landing_height_m" if fato.get("role") == "landing" else "takeoff_height_m"],
            })
    return endpoints


def validate_link(raw, nodes, fatos, existing_links=()):
    """A normalised link or ValueError. `nodes` and `fatos` are the endpoints
    that exist (id → record). A FATO is only a start when it takes off and
    only an end when it lands; two FATOs are not joined directly, because the
    profile between them needs at least one waypoint. A pair of waypoints is
    joined once: drawing the reverse as well is the same pair twice and is
    refused. A FATO endpoint is the exception, because its two directions are
    the vertiport's departure and its arrival."""
    if not isinstance(raw, dict):
        raise ValueError("link: object expected")
    start, end = str(raw.get("from") or "").strip(), str(raw.get("to") or "").strip()
    if not start:
        raise ValueError("from: required")
    if not end:
        raise ValueError("to: required")
    if start == end:
        raise ValueError("to: must differ from from")

    def endpoint(identifier, key):
        if is_fato(identifier):
            record = fatos.get(identifier)
            if record is None:
                raise ValueError(f"{key}: unknown FATO")
            return record
        record = nodes.get(identifier)
        if record is None:
            raise ValueError(f"{key}: unknown node")
        return record

    first, last = endpoint(start, "from"), endpoint(end, "to")
    if is_fato(start) and is_fato(end):
        raise ValueError("to: a route between two FATOs needs a waypoint between them")
    if is_fato(start) and first.get("role") not in ("takeoff", "both"):
        raise ValueError("from: this FATO does not take off")
    if is_fato(end) and last.get("role") not in ("landing", "both"):
        raise ValueError("to: this FATO does not land")
    own = str(raw.get("id") or "")
    key = pair_key(start, end)
    for link in existing_links:
        if link.get("id") != own and pair_key(link.get("from"), link.get("to")) == key:
            raise ValueError("to: these endpoints are already linked")
    segment = str(raw.get("segment") or "").strip().upper()
    segment = MERGED_SEGMENTS.get(segment, segment)
    if segment not in SEGMENT_IDS:
        raise ValueError(f"segment: one of {', '.join(SEGMENT_IDS)}")
    fixed = fato_segment(start, end)
    if fixed is not None and segment != fixed:
        raise ValueError(f"segment: {'a route leaves a FATO climbing' if is_fato(start) else 'a route meets a FATO descending'} ({fixed})")
    # Only the cruise segment is a corridor with a width; the climb, descent
    # and terminal segments are drawn as lines and carry none.
    width = None
    if segment == CORRIDOR_SEGMENT:
        width = round(_number(raw, "width_m", *WIDTH_RANGE_M, required=False, default=DEFAULT_WIDTH_M), 3)
    name = _name(raw, fallback=f"{first.get('name', start)} → {last.get('name', end)}")
    link = {"name": name, "from": start, "to": end, "width_m": width, "segment": segment}
    for key in ("id", "created_at", "updated_at"):
        if raw.get(key):
            link[key] = str(raw[key])
    return link


def fato_segment(from_id, to_id):
    """The one segment a link touching a FATO can be: the climb-out when it
    leaves one, the descent when it arrives at one; None between waypoints."""
    if is_fato(from_id):
        return DEPARTURE_SEGMENT
    if is_fato(to_id):
        return ARRIVAL_SEGMENT
    return None


def link_problem(link, fatos):
    """Why a stored link no longer fits its FATOs, or None. A vertiport edited
    after the link was drawn can leave it leaving a FATO that only lands,
    arriving at one that only takes off, or flying the wrong segment."""
    start, end = link.get("from"), link.get("to")
    if is_fato(start):
        role = (fatos.get(start) or {}).get("role", "both")
        if role not in ("takeoff", "both"):
            return "from: this FATO does not take off"
    if is_fato(end):
        role = (fatos.get(end) or {}).get("role", "both")
        if role not in ("landing", "both"):
            return "to: this FATO does not land"
    fixed = fato_segment(start, end)
    segment = MERGED_SEGMENTS.get(link.get("segment"), link.get("segment"))
    if fixed is not None and segment != fixed:
        return f"segment: {'a route leaves a FATO climbing' if is_fato(start) else 'a route meets a FATO descending'} ({fixed})"
    return None


def pair_key(from_id, to_id):
    """How two endpoints compare for "already joined". Between two waypoints a
    corridor is drawn once (F is flown both ways), so the reverse is the same
    pair and is not drawn twice. A FATO is different: one direction is the vertiport's departure and
    the other its arrival, so each is a pair of its own."""
    if is_fato(from_id) or is_fato(to_id):
        return (from_id, to_id)
    return tuple(sorted((from_id, to_id)))


def suggest_segment(from_id, to_id, links):
    """The segment a new link most likely is: a climb away from a FATO, a
    descent into one, otherwise what follows the segment that arrives at the
    start node, and cruise when nothing does."""
    if is_fato(from_id):
        return "C"
    if is_fato(to_id):
        return "G"
    arriving = [MERGED_SEGMENTS.get(link["segment"], link["segment"]) for link in links if link.get("to") == from_id]
    if arriving:
        return NEXT_SEGMENT.get(arriving[-1], "F")
    return "F"


def prune_links(links, node_ids, fato_ids):
    """The links whose endpoints still exist. A deleted node or vertiport takes
    its links with it rather than leaving them pointing at nothing."""
    valid = set(node_ids) | set(fato_ids)
    return [link for link in links if link.get("from") in valid and link.get("to") in valid]


def network(nodes, links, vertiports):
    """The wire-shaped network: waypoints, the FATO endpoints derived from the
    vertiports, and the links that still have both ends."""
    fatos = fato_endpoints(vertiports)
    kept = prune_links(links, (node["id"] for node in nodes), (fato["id"] for fato in fatos))
    by_id = {fato["id"]: fato for fato in fatos}
    shaped = []
    for link in kept:
        item = dict(link)
        problem = link_problem(link, by_id)
        if problem:
            item["problem"] = problem
        shaped.append(item)
    return {"nodes": [dict(node) for node in nodes], "fatos": fatos, "links": shaped,
            "dropped_links": len(links) - len(kept), "problem_links": sum(1 for item in shaped if "problem" in item)}
