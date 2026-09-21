"""Resolve supplied waypoint order and prepare right-side cruise geometry.

This is planning geometry, not separation assurance or vehicle dynamics.
Source waypoint coordinates and the shared route network remain unchanged.
"""
import math
from digital_twin.model_library.flight_plan import air_graph, haversine_m

# Centre of the right-hand half of an ordinary 300 m corridor. The caller
# caps this at one quarter of the actual corridor width, never outside it.
RIGHT_OFFSET_M = 75.0
MERGE_LENGTH_M = 300.0


def resolve(network, names, start_id, end_id, provisional_names=()):
    places, _, ground = air_graph(network)
    aliases = {}
    for node in [*network.get("nodes", ()), *network.get("fatos", ())]:
        aliases.setdefault(node.get("name", ""), []).append(node["id"])
    nodes, provisional = [], []
    for i, name in enumerate(names):
        candidates = [name] if name in places else aliases.get(name, [])
        if not candidates and name in provisional_names and 0 < i < len(names)-1:
            before = [names[i-1]] if names[i-1] in places else aliases.get(names[i-1], [])
            after = [names[i+1]] if names[i+1] in places else aliases.get(names[i+1], [])
            if len(before) == len(after) == 1 and ground[before[0]]["datum"] == ground[after[0]]["datum"]:
                a, b = before[0], after[0]
                identifier = f"provisional:{name}:{a}:{b}"
                places[identifier] = tuple((x+y)/2 for x, y in zip(places[a], places[b]))
                ground[identifier] = dict(ground[a], name=f"{name} (임시 연결)",
                    altitude_m=(ground[a]["altitude_m"]+ground[b]["altitude_m"])/2)
                candidates = [identifier]
                provisional.append(name)
        if len(candidates) != 1:
            raise ValueError(f"경유점 {name!r}: " + ("지도에 없습니다" if not candidates else "이름이 중복됩니다"))
        nodes.append(candidates[0])
    if len(nodes) < 2 or nodes[0] != start_id or nodes[-1] != end_id:
        raise ValueError("route_path의 처음/끝 FATO가 출발/도착 FATO와 다릅니다")
    if any(node.startswith("fato:") for node in nodes[1:-1]):
        raise ValueError("경로 중간에 다른 FATO가 있습니다")
    links = []
    indexed = {(x["from"], x["to"]): x for x in network.get("links", ())}
    for i, (a, b) in enumerate(zip(nodes, nodes[1:])):
        if a == b or haversine_m(places[a], places[b]) < 0.1:
            raise ValueError("인접 경유점이 중복됩니다")
        # The supplied route authorizes this traversal, including the opposite
        # direction. Reuse corridor width, not an opposite flight's C/G phase.
        source = indexed.get((a, b)) or indexed.get((b, a)) or {}
        links.append({"from": a, "to": b, "segment": "C" if i == 0 else "G" if i == len(nodes)-2 else "F",
                      "width_m": source.get("width_m") or 300.0,
                      "source": "supplied-flight-plan", "network_link": source.get("id")})
    return {"nodes": nodes, "points": [places[n] for n in nodes], "ground": [ground[n] for n in nodes],
            "links": links, "distance_m": sum(haversine_m(places[a], places[b]) for a, b in zip(nodes, nodes[1:])),
            "supplied": True, "direct": False, "provisional_waypoints": provisional}


def right_cruise(points, offset_m=RIGHT_OFFSET_M):
    """(lat, lon, altitude) polyline, offset right in its travel direction.

    Miter joins are bounded to twice the offset. First/last columns are retained
    and the lane is entered/exited over 300 m, so takeoff/descent do not jump.
    """
    if len(points) < 2 or offset_m <= 0:
        return list(points)
    origin = points[0]
    cosine = math.cos(math.radians(origin[0]))
    local = [((p[1]-origin[1])*111320*cosine, (p[0]-origin[0])*111320, p[2]) for p in points]
    lengths = [math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(local, local[1:])]
    if not all(length > 0.01 for length in lengths):
        raise ValueError("순항 경로에 중복 좌표가 있습니다")
    total = sum(lengths)
    ramp = min(MERGE_LENGTH_M, total/3)
    marks, distance = [0.0], 0.0
    for length in lengths:
        distance += length
        marks.append(distance)
    # Add ramp endpoints even on a two-point corridor. Interior intersections
    # keep their directional offset; they do not merge back to the centreline.
    distances = sorted(set([*marks, ramp, total-ramp]))
    result = []
    for wanted in distances:
        index = next((i for i in range(len(lengths)) if marks[i+1] >= wanted-1e-8), len(lengths)-1)
        share = min(1, max(0, (wanted-marks[index])/lengths[index]))
        a, b = local[index], local[index+1]
        x, y, altitude = (a[k]+(b[k]-a[k])*share for k in range(3))
        nx, ny = (b[1]-a[1])/lengths[index], -(b[0]-a[0])/lengths[index]
        join = next((j for j, mark in enumerate(marks[1:-1], 1) if abs(mark-wanted)<1e-6), None)
        scale = 1.0
        if join is not None:
            c, d = local[join], local[join+1]
            rx, ry = (d[1]-c[1])/lengths[join], -(d[0]-c[0])/lengths[join]
            norm = math.hypot(nx+rx, ny+ry)
            if norm > 0.1:
                nx, ny = (nx+rx)/norm, (ny+ry)/norm
                scale = min(2.0, 1/max(0.5, nx*rx+ny*ry))
        taper = min(1.0, wanted/ramp, (total-wanted)/ramp)
        x += nx*offset_m*scale*taper
        y += ny*offset_m*scale*taper
        result.append((origin[0]+y/111320, origin[1]+x/(111320*cosine), altitude))
    return result
