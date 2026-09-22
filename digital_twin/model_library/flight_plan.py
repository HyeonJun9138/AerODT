"""A whole UAM flight, from the gate it leaves to the charger it comes back to.

A route network says where an aircraft may fly and a vertiport layout says how
it moves on a deck; neither says what one flight looks like. This module joins
them into a timed plan: taxi out of the stand along the deck's own taxiways,
lift off the FATO, climb, cruise the corridor, descend, land on the arrival
FATO, taxi to a stand and charge there.

Every leg carries its path, how long it takes, and what it costs the battery,
so a display can put an aircraft anywhere in the flight by asking for a time
rather than running a simulation.

Height is left as it was designed rather than resolved here. A waypoint at
1,000 ft AGL is 1,000 ft over whatever ground is under it, and a deck is its
vertiport's platform over the terrain it stands on — neither is known without
the terrain, which lives in the display. So every path point carries the datum
it was measured from (`msl`, `agl`, or `deck:<vertiport>`) and the display adds
the ground under it, exactly as it already does for the route it flies. A plan
that resolved heights here would put the aircraft at sea level over a hill.

The aircraft is a tiltrotor, so each leg also says where its rotors point: up
for a hover, forward for a cruise, and turning through the climb and descent
the way the transition really runs.

The numbers are the model library's representative ones, like every other
dimension here: a plausible air taxi, not a certified performance deck.

Nothing is stored and nothing is fetched. Given the vertiports and the network
that are already in hand, this answers what a flight between two of them would
be — which is what a test flight needs.
"""
import heapq
import math
from digital_twin.model_library.uam_energy import energy_profile

SCHEMA_VERSION = 1
METRES_PER_DEGREE = 111320.0
HOVER_CAPTURE_M = 8.0
ROUTE_CAPTURE_M = 150.0


def waypoint_capture_m(vertical, rise_m, hover_m=HOVER_CAPTURE_M, route_m=ROUTE_CAPTURE_M):
    """Shared single/fleet capture policy; a cruise turn is never a hover."""
    if not vertical:
        return route_m
    return min(hover_m, max(1.5, rise_m * 0.06)) if rise_m > 0.0 else hover_m

# Visual substitutes only. No manufacturer performance model is selected here.
VISUAL_MODELS = [
    {"id": "projectairsim_airtaxi", "name": "AirTaxi", "note": "쿼드 틸트로터 · 기준 기체"},
    {"id": "x_57", "name": "X-57", "note": "날개 끝 틸트 · 가상 VTOL 외형"},
    {"id": "joby_s4", "name": "Joby S4", "note": "전방 4개 / 후방 2개 역방향 틸트"},
    {"id": "kp2a", "name": "KP-2A", "note": "전방 로터 틸트 / 후방 수직 로터"},
    {"id": "amvlab_evtol", "name": "EVTOL", "note": "순항 ↔ 수직 이착륙 · 원본 크기 미보정"},
    # NASA UAM reference vehicles. Published as OpenVSP parametric models and
    # converted here, so the rotors and the tilt hinges are the shapes' own
    # declared parts rather than anything guessed from the mesh. They are
    # concepts for analysis, not certified aircraft, and like every entry above
    # they are an outward shape flown by the shared AirTaxi dynamics.
    {"id": "nasa_lift_cruise", "name": "NASA Lift+Cruise", "note": "양력 로터 8 + 추진 프로펠러 · 6인승 기준기체"},
    {"id": "nasa_tiltwing", "name": "NASA Tiltwing", "note": "주익 전체 틸트 · 로터 8 (틸트 리그 미선언)"},
    {"id": "nasa_multi_tiltrotor", "name": "NASA Multi-tiltrotor", "note": "틸트로터 8 · 최신 eVTOL 배치"},
    {"id": "nasa_tiltduct_direct", "name": "NASA Tiltduct (직결)", "note": "덕티드 틸트 6 · 베인 5"},
    {"id": "nasa_tiltduct_cross", "name": "NASA Tiltduct (교차축)", "note": "덕티드 틸트 6 · 베인 없음"},
    {"id": "nasa_quadrotor_collflap", "name": "NASA Quadrotor (콜렉티브)", "note": "대형 4로터 · 콜렉티브/플랩 제어"},
    {"id": "nasa_quadrotor_rpm", "name": "NASA Quadrotor (RPM)", "note": "대형 4로터 · 강성 로터 RPM 제어"},
    {"id": "nasa_side_by_side", "name": "NASA Side-by-Side", "note": "좌우 대형 로터 2 · 회전익에 가장 가까움"},
    {"id": "nasa_qsmr", "name": "NASA 저소음 단일주회전익", "note": "단일 주회전익 · 테일로터 없음"},
]


def visual_model(identifier=None):
    identifier = identifier or "projectairsim_airtaxi"
    for model in VISUAL_MODELS:
        if model["id"] == identifier:
            return model
    raise ValueError("visual_asset_id: unknown visual model")

# The stages of a flight, in order, with what each is called and whether it is
# flown or driven. The three airborne runs match the route network's segments
# (C climb-out, F cruise, G descent) so a leg can be read against the links it
# came from; the rest belong to the vertiport.
# `tilt` is where the rotors point through the stage, in degrees: 0 is straight
# up as a multirotor, 90 is fully forward as a fixed wing. The climb tilts
# forward as it accelerates and the descent tilts back — the same transition
# the SimpleFlight tiltrotor controller blends through.
STAGES = [
    {"id": "gate_out", "label": "지상 이동 (게이트 → FATO)", "kind": "ground", "segment": "A", "tilt": (0.0, 0.0)},
    {"id": "takeoff", "label": "수직 이륙", "kind": "vertical", "segment": "B", "tilt": (0.0, 0.0)},
    {"id": "climb", "label": "상승 (전환)", "kind": "air", "segment": "C", "tilt": (0.0, 90.0)},
    {"id": "cruise", "label": "순항", "kind": "air", "segment": "F", "tilt": (90.0, 90.0)},
    {"id": "descent", "label": "강하 (전환)", "kind": "air", "segment": "G", "tilt": (90.0, 0.0)},
    {"id": "landing", "label": "수직 착륙", "kind": "vertical", "segment": "J", "tilt": (0.0, 0.0)},
    {"id": "gate_in", "label": "지상 이동 (FATO → 게이트)", "kind": "ground", "segment": "K", "tilt": (0.0, 0.0)},
    {"id": "charge", "label": "충전", "kind": "ground", "segment": "-", "tilt": (0.0, 0.0)},
]
# The datum a path point's height is measured from. `deck:<id>` is the top of
# that vertiport's platform, which the display knows once it has placed it.
MSL, AGL = "msl", "agl"


def deck_datum(vertiport_id):
    return f"deck:{vertiport_id}"
STAGE_IDS = tuple(stage["id"] for stage in STAGES)
STAGE_BY_ID = {stage["id"]: stage for stage in STAGES}

# A representative air taxi: the tiltrotor the model library carries, with the
# speeds and the power it draws in each stage. Power is what makes a battery
# readout mean anything — a hover costs several times what a cruise does.
# The largest cabin a caller may declare. Not a rule about airframes — a bound
# so a stranger file cannot ask for a thousand people to walk across a deck.
MAXIMUM_SEATS = 20

_ENERGY_PROFILE = energy_profile(4)
AIRCRAFT = {
    "id": "aerodt_airtaxi",
    "label": "AeroDT 에어택시 (쿼드 틸트로터)",
    # The model the display draws it with: the same quad tiltrotor the
    # simulation flies, from the visual asset library.
    "asset_id": "projectairsim_airtaxi",
    "passenger_capacity": 4,
    "cruise_speed_mps": 45.0,
    "climb_speed_mps": 30.0,
    "descent_speed_mps": 28.0,
    "vertical_speed_mps": 3.0,
    "taxi_speed_mps": 4.0,
    "battery_capacity_kwh": _ENERGY_PROFILE["capacity_kwh"],
    "charge_power_kw": _ENERGY_PROFILE["charger_kw"],
    # Draw by stage, in kW.
    "power_kw": {**{k: v for k, v in _ENERGY_PROFILE["power_kw"].items() if k != "hold"}, "charge": 0.0},
}
# What a flight is planned to leave with and come back above.
DEFAULT_BATTERY_START_PCT = 100.0
DEFAULT_CHARGE_TARGET_PCT = 100.0
# Turnaround at the stand before the charger is plugged in, and the pause at
# either end of the deck taxi. Small, but a plan without them reads as a
# vehicle teleporting between stages.
GATE_HOLD_SECONDS = 30.0


def haversine_m(a, b):
    """Metres between two (latitude, longitude) pairs."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d_lat, d_lon = lat2 - lat1, lon2 - lon1
    h = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    return 2 * 6371000.0 * math.asin(min(1.0, math.sqrt(h)))


def _local_to_global(frame, east, north):
    """A vertiport's local (east, north) metres as latitude and longitude. The
    layout has already turned its points by the heading, so this only shifts."""
    latitude, longitude = float(frame["latitude"]), float(frame["longitude"])
    cos_lat = math.cos(math.radians(latitude)) or 1e-9
    return (round(latitude + north / METRES_PER_DEGREE, 7),
            round(longitude + east / (METRES_PER_DEGREE * cos_lat), 7))


def _shortest_path(start, goal, neighbours):
    """Dijkstra over `neighbours(node) -> [(next, cost)]`; the node ids from
    start to goal, or None when the goal cannot be reached."""
    if start == goal:
        return [start]
    best = {start: 0.0}
    came = {}
    queue = [(0.0, start)]
    seen = set()
    while queue:
        cost, node = heapq.heappop(queue)
        if node in seen:
            continue
        seen.add(node)
        if node == goal:
            path = [node]
            while path[-1] != start:
                path.append(came[path[-1]])
            return list(reversed(path))
        for nxt, step in neighbours(node):
            through = cost + max(float(step), 0.0)
            if nxt not in seen and through < best.get(nxt, math.inf):
                best[nxt] = through
                came[nxt] = node
                heapq.heappush(queue, (through, nxt))
    return None


# ---------------------------------------------------------------- the deck

def deck_graph(layout):
    """The taxiway graph of one layout: node id → position, and the undirected
    edges between them with their lengths."""
    nodes = {node["id"]: node for node in layout.get("nodes") or ()}
    edges = {}
    for edge in layout.get("edges") or ():
        start, end = edge.get("from"), edge.get("to")
        if start in nodes and end in nodes:
            edges.setdefault(start, []).append((end, float(edge.get("length_m") or 0.0)))
            edges.setdefault(end, []).append((start, float(edge.get("length_m") or 0.0)))
    return nodes, edges


def taxi_path(layout, start_id, goal_id):
    """The positions a vehicle taxis through from one deck node to another,
    as (latitude, longitude) with the metres between them, or None. The deck
    itself is the datum: a taxiing aircraft is on the platform, whatever
    height the terrain puts that platform at."""
    nodes, edges = deck_graph(layout)
    if start_id not in nodes or goal_id not in nodes:
        return None
    path = _shortest_path(start_id, goal_id, lambda node: edges.get(node, ()))
    if not path:
        return None
    frame = (layout.get("frame") or {})
    points = [_local_to_global(frame, *nodes[node]["position_m"]) for node in path]
    return {"nodes": path, "points": points,
            "distance_m": sum(haversine_m(a, b) for a, b in zip(points, points[1:]))}


def taxi_path_from_position(layout, position, goal_id, max_join_m=2.5):
    """Join only a nearby authored edge, never a straight shortcut to a gate.

    The small join tolerance encloses the existing 2 m taxi corner trimming.
    Motion authority must independently check the resulting swept path.
    """
    nodes, edges = deck_graph(layout)
    frame = layout.get('frame') or {}
    points = {key:_local_to_global(frame,*node['position_m']) for key,node in nodes.items()}
    scale = math.pi*6371000/180
    east = scale*math.cos(math.radians(position[0]))
    xy = {key:((p[0]-position[0])*scale,(p[1]-position[1])*east) for key,p in points.items()}
    candidates = []
    visited = set()
    for first, links in edges.items():
        for second,_ in links:
            key = tuple(sorted((first,second)))
            if key in visited: continue
            visited.add(key)
            a,b = xy[first],xy[second]
            d = b[0]-a[0],b[1]-a[1]
            f = max(0,min(1,-(a[0]*d[0]+a[1]*d[1])/max(1e-12,d[0]**2+d[1]**2)))
            join = (a[0]+f*d[0],a[1]+f*d[1])
            if math.hypot(*join)>max_join_m: continue
            ll = (position[0]+join[0]/scale,position[1]+join[1]/east)
            for endpoint in (first,second):
                tail = taxi_path(layout,endpoint,goal_id)
                if not tail: continue
                path = [tuple(position),ll,*tail['points']]
                clean = [path[0]]
                for p in path[1:]:
                    if haversine_m(clean[-1],p)>.001: clean.append(p)
                distance = sum(haversine_m(a,b) for a,b in zip(clean,clean[1:]))
                candidates.append((distance,endpoint,clean,tail['nodes']))
    if not candidates:
        raise ValueError('현재 위치에서 배정 게이트로 연결되는 유도로가 없습니다')
    distance,_,path,names = min(candidates)
    return {'points':path,'nodes':names,'distance_m':distance}


# ---------------------------------------------------------------- the air

# The last few networks the graph was built for, by identity. A network is a
# dict the store hands out whole and never edits in place (an edit is a new
# dict), so the same object is the same graph. A day's load builds seven
# hundred routes against one network and a schedule run over a thousand
# plans; each rebuilt this from every node and link.
_AIR_GRAPHS = []
_AIR_GRAPH_KEEP = 4


def air_graph(network):
    """`_air_graph` for this network, built once. The places and ground
    tables are handed out as copies: `scheduled_route.resolve` adds
    provisional nodes to the tables it is given, and one caller's provisional
    node must not be another caller's route."""
    for entry in _AIR_GRAPHS:
        if entry[0] is network:
            return dict(entry[1]), entry[2], dict(entry[3])
    places, out, ground = _air_graph(network)
    _AIR_GRAPHS.append((network, places, out, ground))
    del _AIR_GRAPHS[:-_AIR_GRAPH_KEEP]
    return dict(places), out, dict(ground)


def _air_graph(network):
    """Where the aircraft may fly: every endpoint's position and altitude, and
    the links out of it. A drawn F corridor joins waypoints both ways; C/G
    retain their departure/arrival direction. Source links are not mutated."""
    places, out = {}, {}
    ground = {}
    for node in network.get("nodes") or ():
        places[node["id"]] = (float(node["latitude"]), float(node["longitude"]))
        # A waypoint keeps the datum it was designed against: 1,000 ft AGL is
        # over the ground beneath it, not over the sea.
        ground[node["id"]] = {"altitude_m": float(node.get("altitude_m") or 0.0),
                              "datum": MSL if node.get("altitude_reference") == "msl" else AGL,
                              "kind": "node", "name": node.get("name") or node["id"]}
    for fato in network.get("fatos") or ():
        places[fato["id"]] = (float(fato["latitude"]), float(fato["longitude"]))
        # A route meets a FATO at the hover point over its deck, so the deck is
        # the datum and the hover height is what is added to it.
        ground[fato["id"]] = {"altitude_m": float(fato.get("hover_m") or 0.0),
                              "datum": deck_datum(fato.get("vertiport")), "kind": "fato",
                              "name": fato.get("name") or fato["id"]}
    for link in network.get("links") or ():
        start, end = link.get("from"), link.get("to")
        if start in places and end in places and not link.get("problem"):
            distance = haversine_m(places[start], places[end])
            out.setdefault(start, []).append((end, distance, link))
            if (link.get("segment") == "F" and link.get("direction") != "forward"
                    and ground[start]["kind"] == "node"
                    and ground[end]["kind"] == "node"):
                out.setdefault(end, []).append((start, distance, dict(link, **{"from": end, "to": start})))
    return places, out, ground


def _terminal_ground(network, identifier, ground, role):
    """Select a shared pad's directional height without changing graph data."""
    endpoint = next((item for item in network.get("fatos") or () if item["id"] == identifier), {})
    return dict(ground, altitude_m=float(endpoint.get(f"{role}_height_m", ground["altitude_m"])))


# A corridor for two decks the drawn network does not join. The network the
# operator has drawn covers a handful of pairs; a schedule somebody else wrote
# will name pairs it does not cover, and refusing those flights would answer a
# question about the day with a question about the map. So a straight corridor
# is synthesised instead — and it is marked, so nothing downstream mistakes it
# for a route anybody designed.
#
# The two levels are the ones the drawn network already uses (1,000 and 1,500
# feet above the ground). Which one a flight gets is decided by the direction it
# is heading, so opposing corridors are 500 feet apart. That is not a separation
# service; it is the cheapest thing that stops two aircraft flying the same line
# in opposite directions at the same height.
DIRECT_CRUISE_AGL_M = (305.0, 457.0)
# How far from the pad the climb takes, and the descent before it. Capped at a
# share of the leg so a short hop still has some cruise between them.
DIRECT_TRANSITION_M = 2500.0
DIRECT_TRANSITION_SHARE = 0.35


def _along(start, end, distance_m):
    """A point `distance_m` from `start` towards `end`.

    Linear in latitude and longitude: over the tens of kilometres between two
    city decks the difference from a great circle is under a metre, and the
    corridor is a synthetic one either way.
    """
    span = haversine_m(start, end)
    if span <= 0:
        return start
    share = max(0.0, min(1.0, distance_m / span))
    return (start[0] + (end[0] - start[0]) * share, start[1] + (end[1] - start[1]) * share)


def direct_path(network, start_id, goal_id):
    """A straight corridor between two endpoints, in the shape `air_path` gives.

    Four points: the hover over the departure pad, a top of climb, a top of
    descent, and the hover over the arrival pad — joined by one climbing, one
    cruising and one descending link, so everything downstream cuts it into legs
    the same way it cuts a designed route.
    """
    places, _, ground = air_graph(network)
    if start_id not in places or goal_id not in places:
        return None
    start, goal = places[start_id], places[goal_id]
    distance = haversine_m(start, goal)
    if distance <= 0:
        return None
    # East and north of the departure means the higher level, so a pair gets one
    # level each way rather than both flights at the same height.
    eastbound = (goal[1], goal[0]) > (start[1], start[0])
    level = DIRECT_CRUISE_AGL_M[1] if eastbound else DIRECT_CRUISE_AGL_M[0]
    transition = min(DIRECT_TRANSITION_M, distance * DIRECT_TRANSITION_SHARE)
    top, bottom = _along(start, goal, transition), _along(goal, start, transition)
    start_ground = ground.get(start_id) or {"altitude_m": 0.0, "datum": AGL, "name": start_id}
    goal_ground = ground.get(goal_id) or {"altitude_m": 0.0, "datum": AGL, "name": goal_id}
    start_ground = _terminal_ground(network, start_id, start_ground, "takeoff")
    goal_ground = _terminal_ground(network, goal_id, goal_ground, "landing")
    middle = {"altitude_m": level, "datum": AGL, "kind": "direct"}
    nodes = [start_id, f"{start_id}→직항", f"직항→{goal_id}", goal_id]
    points = [start, top, bottom, goal]
    grounds = [start_ground,
               dict(middle, name=f"{start_ground['name']} 상승 종료"),
               dict(middle, name=f"{goal_ground['name']} 강하 시작"),
               goal_ground]
    links = [{"segment": "C", "direct": True}, {"segment": "F", "direct": True},
             {"segment": "G", "direct": True}]
    return {"nodes": nodes, "points": points, "links": links, "ground": grounds,
            "distance_m": sum(haversine_m(a, b) for a, b in zip(points, points[1:])),
            "direct": True}


def air_path(network, start_id, goal_id):
    """The endpoints an aircraft flies through, with the link taken at each
    step, or None when the network does not join the two."""
    places, out, ground = air_graph(network)
    if start_id not in places or goal_id not in places:
        return None
    path = _shortest_path(start_id, goal_id,
                          lambda node: [(end, cost) for end, cost, _ in out.get(node, ())])
    if not path:
        return None
    links = []
    for start, end in zip(path, path[1:]):
        links.append(next(link for target, _, link in out[start] if target == end))
    heights = [ground[node] for node in path]
    heights[0] = _terminal_ground(network, start_id, heights[0], "takeoff")
    heights[-1] = _terminal_ground(network, goal_id, heights[-1], "landing")
    return {"nodes": path, "points": [places[node] for node in path], "links": links,
            "ground": heights,
            "distance_m": sum(haversine_m(places[a], places[b]) for a, b in zip(path, path[1:]))}


# ---------------------------------------------------------------- the plan

def _leg(stage_id, name, points, heights, distance_m, duration_s, speed_mps, extra=None):
    """One leg. `heights` pairs each point with (altitude_m, datum), so the
    display resolves the height the same way it resolves the route's own."""
    stage = STAGE_BY_ID[stage_id]
    return {"stage": stage_id, "stage_label": stage["label"], "kind": stage["kind"],
            "segment": stage["segment"], "name": name,
            "tilt_start_deg": stage["tilt"][0], "tilt_end_deg": stage["tilt"][1],
            "path": [[round(lon, 7), round(lat, 7), round(float(alt), 2), datum]
                     for (lat, lon), (alt, datum) in zip(points, heights)],
            "distance_m": round(distance_m, 1), "duration_s": round(duration_s, 1),
            "speed_mps": round(speed_mps, 2), **(extra or {})}


def _split_air(path, aircraft):
    """The air path cut into climb, cruise and descent by the segment each link
    carries. A link the operator marked C is climbing, G is descending and
    everything else is cruise; consecutive links of a run become one leg."""
    runs = []
    for index, link in enumerate(path["links"]):
        segment = str(link.get("segment") or "F").upper()
        stage = {"C": "climb", "G": "descent"}.get(segment, "cruise")
        if runs and runs[-1]["stage"] == stage:
            runs[-1]["to"] = index + 1
        else:
            runs.append({"stage": stage, "from": index, "to": index + 1})
    speeds = {"climb": aircraft["climb_speed_mps"], "cruise": aircraft["cruise_speed_mps"],
              "descent": aircraft["descent_speed_mps"]}
    legs = []
    for run in runs:
        points = path["points"][run["from"]:run["to"] + 1]
        heights = [(item["altitude_m"], item["datum"]) for item in path["ground"][run["from"]:run["to"] + 1]]
        distance = sum(haversine_m(a, b) for a, b in zip(points, points[1:]))
        speed = speeds[run["stage"]]
        names = [path["ground"][run["from"]]["name"], path["ground"][run["to"]]["name"]]
        legs.append(_leg(run["stage"], " → ".join(names), points, heights,
                         distance, distance / speed if speed else 0.0, speed,
                         {"waypoints": path["nodes"][run["from"]:run["to"] + 1]}))
    return legs


def _vertical(stage_id, name, place, hover_m, datum, aircraft, rising, speed=None):
    """Off the deck to the hover point, or back down. Both ends stand on the
    same deck, so only how far above it changes."""
    # The lift off the pad and the descent onto it are not the same rate.
    speed = speed or aircraft["vertical_speed_mps"]
    low, high = (0.0, datum), (hover_m, datum)
    heights = (low, high) if rising else (high, low)
    return _leg(stage_id, name, [place, place], heights, 0.0,
                hover_m / speed if speed else 0.0, speed, {"climb_m": round(hover_m, 2)})


def _ground_leg(stage_id, name, taxi, datum, aircraft, speed=None):
    from .ground_motion import prepare
    # Out to the pad and back in are different speeds in the operating figures.
    speed = speed or aircraft["taxi_speed_mps"]
    path,profile,distance,duration=prepare(taxi['points'],speed,GATE_HOLD_SECONDS)
    route_detail = {key: taxi[key] for key in (
        'route_id', 'rank', 'distance_m', 'clear_distance_m', 'blocked_by') if key in taxi}
    route_detail = {
        'ground_route_id': route_detail.get('route_id'),
        'ground_route_rank': route_detail.get('rank'),
        'ground_route_distance_m': route_detail.get('distance_m'),
        'ground_route_clear_distance_m': route_detail.get('clear_distance_m'),
        'ground_route_blocked_by': route_detail.get('blocked_by'),
    } if route_detail else {}
    return _leg(stage_id, name, path, [(0.0, datum)] * len(path), distance,
                duration, speed, {"taxi_nodes": taxi["nodes"], **route_detail,
                                  **({'ground_motion':profile} if profile else {})})


def _charge_leg(place, datum, aircraft, from_pct, target_pct, gate, charger):
    capacity, power = aircraft["battery_capacity_kwh"], aircraft["charge_power_kw"]
    needed_kwh = max(0.0, (target_pct - from_pct) / 100.0 * capacity)
    seconds = needed_kwh / power * 3600.0 if power else 0.0
    leg = _leg("charge", f"{gate} 충전", [place, place], [(0.0, datum), (0.0, datum)], 0.0, seconds, 0.0,
               {"charger": charger, "gate": gate, "charge_kwh": round(needed_kwh, 2),
                "charge_power_kw": power})
    return leg


def _vertiport_index(vertiports):
    return {record["id"]: record for record in vertiports or () if record.get("id")}


def _gate_for(layout, wanted=None):
    gates = [gate["id"] for gate in layout.get("gates") or ()]
    if not gates:
        return None
    return wanted if wanted in gates else gates[0]


def _fato_for(layout, role, wanted=None, connected=None):
    """A FATO on this deck that can do `role`; the one asked for when it can.

    `connected` is the set of pads the network actually joins in that
    direction. A deck whose shared pads are each wired one way - one leaves,
    the other arrives - must not be handed the pad the drawing never lands on:
    that made every flight into such a deck "not joined" while the deck was."""
    usable = [fato["id"] for fato in layout.get("fatos") or ()
              if fato.get("role") in (role, "both")]
    if not usable:
        return None
    if wanted in usable:
        return wanted
    if connected:
        for fato in usable:
            if fato in connected:
                return fato
    return usable[0]


def linked_fatos(network, vertiport_id, role):
    """The pads of one deck the network joins for `role`: a link leaving the
    pad when it takes off, a link arriving at it when it lands."""
    key = "from" if role == "takeoff" else "to"
    prefix = f"fato:{vertiport_id}:"
    return {str(link.get(key))[len(prefix):] for link in (network or {}).get("links") or ()
            if str(link.get(key) or "").startswith(prefix)}


def plan_options(vertiports, network):
    """What a test flight can be built from: the vertiports that have both a
    stand and a usable FATO, and — because a plan needs the network to join
    them — which of them the links actually reach from each departure."""
    index = _vertiport_index(vertiports)
    _, out, _ = air_graph(network)
    reachable = {}
    places = []
    for record in index.values():
        layout = record.get("layout") or {}
        gates = [gate["id"] for gate in layout.get("gates") or ()]
        takeoff = _fato_for(layout, "takeoff", connected=linked_fatos(network, record["id"], "takeoff"))
        landing = _fato_for(layout, "landing", connected=linked_fatos(network, record["id"], "landing"))
        if not gates or not (takeoff or landing):
            continue
        places.append({"id": record["id"], "name": record.get("name", record["id"]),
                       "gates": gates, "takeoff_fato": takeoff, "landing_fato": landing,
                       "latitude": record.get("latitude"), "longitude": record.get("longitude")})
    ids = {item["id"] for item in places}
    for item in places:
        if not item["takeoff_fato"]:
            continue
        start = f"fato:{item['id']}:{item['takeoff_fato']}"
        seen = {start}
        stack = [start]
        while stack:
            node = stack.pop()
            for end, _, _ in out.get(node, ()):
                if end not in seen:
                    seen.add(end)
                    stack.append(end)
        found = sorted({node.split(":")[1] for node in seen
                        if node.startswith("fato:") and node.split(":")[1] in ids and node != start}
                       - {item["id"]})
        reachable[item["id"]] = found
    return {"schema_version": SCHEMA_VERSION, "vertiports": places, "reachable": reachable,
            "aircraft": [dict(AIRCRAFT)], "visual_models": [dict(model) for model in VISUAL_MODELS],
            "stages": [dict(stage) for stage in STAGES],
            "defaults": {"aircraft": AIRCRAFT["id"], "passengers": 3,
                         "battery_start_pct": DEFAULT_BATTERY_START_PCT,
                         "charge_target_pct": DEFAULT_CHARGE_TARGET_PCT}}


def validate_request(raw, options):
    """A normalised plan request or ValueError('field: reason')."""
    if not isinstance(raw, dict):
        raise ValueError("plan: object expected")
    visual = visual_model(raw.get("visual_asset_id"))
    by_id = {item["id"]: item for item in options["vertiports"]}
    start = str(raw.get("from_vertiport") or "").strip()
    end = str(raw.get("to_vertiport") or "").strip()
    if start not in by_id:
        raise ValueError("from_vertiport: unknown vertiport")
    if end not in by_id:
        raise ValueError("to_vertiport: unknown vertiport")
    if start == end:
        raise ValueError("to_vertiport: must differ from the departure")
    # How many seats this cabin has. The representative airframe's four stand in
    # when the caller does not say, which is every hand-made plan; a scheduled
    # flight knows its own cabin and the people who walk to it are the people
    # the schedule assigned, not the ones a stand-in airframe could hold.
    capacity = AIRCRAFT["passenger_capacity"]
    if raw.get("seat_capacity") is not None:
        try:
            capacity = int(raw["seat_capacity"])
        except (TypeError, ValueError):
            raise ValueError("seat_capacity: whole number expected") from None
        if not 1 <= capacity <= MAXIMUM_SEATS:
            raise ValueError(f"seat_capacity: 1 to {MAXIMUM_SEATS}")
    passengers = raw.get("passengers", options["defaults"]["passengers"])
    try:
        passengers = int(passengers)
    except (TypeError, ValueError):
        raise ValueError("passengers: whole number expected") from None
    if not 0 <= passengers <= capacity:
        raise ValueError(f"passengers: 0 to {capacity}")

    def percent(key, fallback):
        value = raw.get(key, fallback)
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key}: number expected") from None
        if not 0.0 <= value <= 100.0:
            raise ValueError(f"{key}: 0 to 100")
        return value

    return {"from_vertiport": start, "to_vertiport": end,
            "visual_asset_id": visual["id"],
            "from_gate": str(raw.get("from_gate") or "").strip() or None,
            "to_gate": str(raw.get("to_gate") or "").strip() or None,
            "passengers": passengers, "seat_capacity": capacity,
            "battery_start_pct": percent("battery_start_pct", DEFAULT_BATTERY_START_PCT),
            "charge_target_pct": percent("charge_target_pct", DEFAULT_CHARGE_TARGET_PCT)}


def build_plan(request, vertiports, network, *, allow_direct=False, supplied_air_path=None,
               profile=None, departure_taxi=None):
    """The whole flight as timed legs, or ValueError naming what stopped it.

    `allow_direct` lets a pair the network does not join be flown down a
    synthesised corridor instead of being refused. The plan says so, so a
    display and a report can both tell the two apart.

    `profile` is how fast the aircraft is flown — the taxi, the lift, the
    cruise — in the numbers a pilot sets. Without one the operating figures'
    own values are used. It decides speeds and nothing else: where the flight
    goes and how high are the route network's, and the aircraft climbs and
    descends along the route it was assigned.
    """
    from . import uam_operating_profile
    profile = uam_operating_profile.validate(profile if isinstance(profile, dict) else None)
    flown = uam_operating_profile.speeds(profile)
    index = _vertiport_index(vertiports)
    start_record, end_record = index.get(request["from_vertiport"]), index.get(request["to_vertiport"])
    if start_record is None or end_record is None:
        raise ValueError("from_vertiport: unknown vertiport")
    start_layout = start_record.get("layout") or {}
    end_layout = end_record.get("layout") or {}
    start_gate = _gate_for(start_layout, request.get("from_gate"))
    end_gate = _gate_for(end_layout, request.get("to_gate"))
    if not start_gate:
        raise ValueError("from_gate: the departure vertiport has no stand")
    if not end_gate:
        raise ValueError("to_gate: the arrival vertiport has no stand")
    start_fato = request.get("from_fato") or _fato_for(
        start_layout, "takeoff", connected=linked_fatos(network, request["from_vertiport"], "takeoff"))
    end_fato = request.get("to_fato") or _fato_for(
        end_layout, "landing", connected=linked_fatos(network, request["to_vertiport"], "landing"))
    if start_fato not in {x["id"] for x in start_layout.get("fatos", ())}:
        raise ValueError("from_fato: unknown FATO")
    if end_fato not in {x["id"] for x in end_layout.get("fatos", ())}:
        raise ValueError("to_fato: unknown FATO")
    start_role = next(x.get("role") for x in start_layout["fatos"] if x["id"] == start_fato)
    end_role = next(x.get("role") for x in end_layout["fatos"] if x["id"] == end_fato)
    if start_role not in ("takeoff", "both") or end_role not in ("landing", "both"):
        raise ValueError("FATO 역할이 출발/착륙 용도와 다릅니다")
    if not start_fato:
        raise ValueError("from_vertiport: no FATO that takes off")
    if not end_fato:
        raise ValueError("to_vertiport: no FATO that lands")

    out_taxi = departure_taxi or taxi_path(start_layout, start_gate, start_fato)
    in_taxi = taxi_path(end_layout, end_fato, end_gate)
    if out_taxi is None:
        raise ValueError(f"from_gate: {start_gate} has no taxiway to {start_fato}")
    if (not out_taxi.get('nodes') or out_taxi['nodes'][0] != start_gate
            or out_taxi['nodes'][-1] != start_fato):
        raise ValueError('departure taxi proposal does not join the selected stand and FATO')
    if in_taxi is None:
        raise ValueError(f"to_gate: {end_fato} has no taxiway to {end_gate}")
    start_node = f"fato:{request['from_vertiport']}:{start_fato}"
    end_node = f"fato:{request['to_vertiport']}:{end_fato}"
    air = supplied_air_path if supplied_air_path is not None else air_path(network, start_node, end_node)
    if supplied_air_path is not None and (air["nodes"][0] != start_node or air["nodes"][-1] != end_node):
        raise ValueError("supplied route endpoints do not match FATO")
    if air is None and allow_direct:
        air = direct_path(network, start_node, end_node)
    if air is None:
        raise ValueError("to_vertiport: the route network does not join these two vertiports")

    # Supplied routes can predate an infrastructure edit. Keep the air and
    # vertical phases continuous using the current deck settings, without
    # modifying a candidate path shared by other scheduled flights.
    air = dict(air, ground=[dict(item) for item in air["ground"]])
    for position, record, layout, role in ((0, start_record, start_layout, "takeoff"),
                                           (-1, end_record, end_layout, "landing")):
        key = f"{role}_height_m"
        air["ground"][position]["altitude_m"] = float(record.get(
            key, layout.get(key, air["ground"][position]["altitude_m"])))
        air["ground"][position]["datum"] = deck_datum(record["id"])

    aircraft = dict(AIRCRAFT)
    aircraft["passenger_capacity"] = request.get("seat_capacity", AIRCRAFT["passenger_capacity"])
    # Everything timed below is timed at the profile's speeds.
    aircraft.update(cruise_speed_mps=flown["cruise_mps"], climb_speed_mps=flown["climb_mps"],
                    descent_speed_mps=flown["descent_mps"], vertical_speed_mps=flown["vertical_mps"],
                    taxi_speed_mps=flown["taxi_out_mps"], operating_profile=dict(profile))
    visual = visual_model(request.get("visual_asset_id"))
    aircraft.update(asset_id=visual["id"], visual_label=visual["name"],
                    dynamics_label="AirTaxi · FastPhysics + SimpleFlight")
    start_deck = float((start_layout.get("platform") or {}).get("height_m") or 0.0)
    end_deck = float((end_layout.get("platform") or {}).get("height_m") or 0.0)
    start_datum = deck_datum(request["from_vertiport"])
    end_datum = deck_datum(request["to_vertiport"])
    start_hover = air["ground"][0]["altitude_m"]
    end_hover = air["ground"][-1]["altitude_m"]
    start_place, end_place = air["points"][0], air["points"][-1]

    legs = [
        _ground_leg("gate_out", f"{start_gate} → {start_fato}", out_taxi, start_datum, aircraft,
                    flown["taxi_out_mps"]),
        _vertical("takeoff", f"{start_fato} 이륙", start_place, start_hover, start_datum, aircraft, True,
                  flown["vertical_mps"]),
        *_split_air(air, aircraft),
        _vertical("landing", f"{end_fato} 착륙", end_place, end_hover, end_datum, aircraft, False,
                  flown["landing_vertical_mps"]),
        _ground_leg("gate_in", f"{end_fato} → {end_gate}", in_taxi, end_datum, aircraft,
                    flown["taxi_in_mps"]),
    ]
    from .passenger_boarding import prepare as prepare_boarding, door_spec
    hatch = door_spec(visual["id"])
    boarding = prepare_boarding(start_layout, start_gate, request['passengers'], legs[0], door=hatch)
    alighting = prepare_boarding(end_layout, end_gate, request['passengers'], legs[-1], alighting=True, door=hatch)

    # Time and battery run through the legs in order; the charge leg is last
    # because how long it takes depends on what the flight spent.
    capacity = aircraft["battery_capacity_kwh"]
    battery = float(request["battery_start_pct"])
    elapsed = 0.0
    for leg in legs:
        power = aircraft["power_kw"].get(leg["stage"], 0.0)
        used = power * leg["duration_s"] / 3600.0
        leg["start_s"] = round(elapsed, 1)
        elapsed += leg["duration_s"]
        leg["end_s"] = round(elapsed, 1)
        leg["energy_kwh"] = round(used, 3)
        leg["battery_start_pct"] = round(battery, 2)
        battery = max(0.0, battery - (used / capacity * 100.0 if capacity else 0.0))
        leg["battery_end_pct"] = round(battery, 2)
    charger = next((item["id"] for item in end_layout.get("chargers") or ()
                    if item.get("gate") == end_gate), None)
    charge = _charge_leg(in_taxi["points"][-1], end_datum, aircraft, battery,
                         float(request["charge_target_pct"]), end_gate, charger)
    if alighting:
        # Keep the stand phase alive even if the requested battery level is already met.
        charge['passenger_hold_s'] = math.ceil(alighting['duration_s'] * 10) / 10
        charge['duration_s'] = max(charge['duration_s'], charge['passenger_hold_s'])
    charge["start_s"] = round(elapsed, 1)
    elapsed += charge["duration_s"]
    charge["end_s"] = round(elapsed, 1)
    charge["energy_kwh"] = -charge["charge_kwh"]
    charge["battery_start_pct"] = round(battery, 2)
    charge["battery_end_pct"] = round(max(battery, float(request["charge_target_pct"])), 2)
    legs.append(charge)

    flown = sum(leg["distance_m"] for leg in legs if leg["kind"] == "air")
    return {
        "schema_version": SCHEMA_VERSION,
        "request": dict(request),
        **({'boarding': boarding} if boarding else {}),
        **({'alighting': alighting} if alighting else {}),
        "aircraft": aircraft,
        "vehicle": {"id": f"UAM-{request['from_vertiport']}-{request['to_vertiport']}",
                    "type": aircraft["id"], "label": visual["name"] + " (AirTaxi 동역학)",
                    "passengers": request["passengers"], "capacity": aircraft["passenger_capacity"]},
        "departure": {"vertiport": request["from_vertiport"], "name": start_record.get("name", ""),
                      "gate": start_gate, "fato": start_fato, "deck_height_m": start_deck,
                      "datum": start_datum, "hover_m": start_hover},
        "arrival": {"vertiport": request["to_vertiport"], "name": end_record.get("name", ""),
                    "gate": end_gate, "fato": end_fato, "deck_height_m": end_deck, "charger": charger,
                    "datum": end_datum, "hover_m": end_hover},
        # Which vertiport decks the display has to resolve before it can place
        # the flight, so it never has to guess from the path alone.
        "decks": sorted({start_datum.split(":", 1)[1], end_datum.split(":", 1)[1]}),
        # True when no drawn route joined these decks and a corridor was made up
        # to join them. Everything that reports on the flight says so.
        "direct": bool(air.get("direct")),
        "legs": legs,
        "totals": {"duration_s": round(elapsed, 1),
                   "flight_duration_s": round(legs[-1]["start_s"], 1),
                   "air_distance_m": round(flown, 1),
                   "ground_distance_m": round(out_taxi["distance_m"] + in_taxi["distance_m"], 1),
                   "energy_kwh": round(sum(leg["energy_kwh"] for leg in legs if leg["energy_kwh"] > 0), 3),
                   "battery_start_pct": round(float(request["battery_start_pct"]), 2),
                   "battery_landing_pct": legs[-1]["battery_start_pct"],
                   "battery_end_pct": legs[-1]["battery_end_pct"],
                   "waypoints": len(air["nodes"])},
    }
