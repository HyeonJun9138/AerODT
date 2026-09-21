"""Deterministic boarding schedule on the selected stand, not crowd physics."""
import heapq
import math
import json
from pathlib import Path
from functools import lru_cache

@lru_cache(maxsize=32)
def door_spec(asset_id):
    if not asset_id or not all(c.isalnum() or c == "_" for c in asset_id):
        return {}
    path = Path(__file__).parent / "visual_assets/aircraft/civilian" / asset_id / "asset.json"
    if not path.is_file(): return {}
    return json.loads(path.read_text(encoding="utf-8")).get("cockpit", {}).get("ground_door", {})

def onboard(schedule, elapsed, alighting=False):
    if not schedule: return 0
    releases=schedule.get("release_s", [])
    # Boarding crosses the sill at the end; alighting leaves the seat at release.
    if alighting: return sum(elapsed < t for t in releases)
    return sum(elapsed >= t + schedule["walk_s"] + schedule["enter_s"] for t in releases)


WALK_MPS = 1.15
SPACING_S = 2.0
ENTER_S = 1.2


def rotate(point, degrees):
    a = math.radians(degrees)
    x, y = point
    return (x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a))


def crosses(a, b, box):
    """Open rectangle intersection; paths along inflated boundaries are allowed."""
    low, high = 0.0, 1.0
    for k in (0, 1):
        d = b[k] - a[k]
        lo, hi = box[k] + 1e-6, box[k + 2] - 1e-6
        if abs(d) < 1e-10:
            if not lo < a[k] < hi:
                return False
        else:
            t, u = sorted(((lo - a[k]) / d, (hi - a[k]) / d))
            low, high = max(low, t), min(high, u)
            if low >= high:
                return False
    return low < high


# The part of the walking graph that belongs to the deck rather than to one
# walk: which obstacle corners can see each other. A deck with sixteen
# shelters and cabinets has some seventy corners and two thousand pairs, each
# tested against every box - tens of thousands of crossing tests - and it is
# the same for every passenger who ever walks that deck. Worked out once per
# deck geometry and kept; a walk then only has to join its own two ends to it.
_GRAPHS = {}
_GRAPH_LIMIT = 64
# Finished walks, by deck geometry, stand and approach: see `prepare`.
_WALKS = {}
_WALK_LIMIT = 512


def _inside(p, bounds):
    return bounds[0] <= p[0] <= bounds[2] and bounds[1] <= p[1] <= bounds[3]


def deck_graph(obstacles, bounds):
    """Obstacle corners inside the deck and the clear lines between them."""
    key = (tuple(tuple(box) for box in obstacles), tuple(bounds))
    graph = _GRAPHS.get(key)
    if graph is not None:
        return graph
    points = []
    for x, y, X, Y in obstacles:
        points.extend(p for p in ((x, y), (x, Y), (X, y), (X, Y)) if _inside(p, bounds))
    edges = [[] for _ in points]
    for i, a in enumerate(points):
        for j in range(i):
            b = points[j]
            if not any(crosses(a, b, box) for box in obstacles):
                distance = math.dist(a, b)
                edges[i].append((j, distance)); edges[j].append((i, distance))
    graph = {'points': points, 'edges': edges}
    if len(_GRAPHS) >= _GRAPH_LIMIT:
        _GRAPHS.pop(next(iter(_GRAPHS)))
    _GRAPHS[key] = graph
    return graph


def route(start, end, obstacles, bounds):
    if not _inside(start, bounds) or not _inside(end, bounds):
        raise ValueError('boarding: 탑승 동선이 데크를 벗어납니다.')
    graph = deck_graph(obstacles, bounds)
    # This walk's two ends in front of the deck's corners, whose lines between
    # each other are already known; only the lines to and from the ends are new.
    points = [start, end, *graph['points']]
    edges = [[], [], *([(j + 2, d) for j, d in row] for row in graph['edges'])]
    for i, a in ((0, start), (1, end)):
        for j in range(i + 1, len(points)):
            b = points[j]
            if not any(crosses(a, b, box) for box in obstacles):
                distance = math.dist(a, b)
                edges[i].append((j, distance)); edges[j].append((i, distance))
    queue, best, parents = [(0, 0)], {0: 0}, {}
    while queue:
        cost, i = heapq.heappop(queue)
        if cost > best[i]: continue
        if i == 1:
            ids = [1]
            while ids[-1] != 0: ids.append(parents[ids[-1]])
            return [points[k] for k in reversed(ids)]
        for j, step in edges[i]:
            if cost + step < best.get(j, math.inf):
                best[j], parents[j] = cost + step, i
                heapq.heappush(queue, (cost + step, j))
    raise ValueError('boarding: 시설을 피하는 탑승 동선을 만들 수 없습니다.')


def prepare(layout, gate_id, count, taxi_leg, *, alighting=False, door=None):
    if count == 0:
        return None
    shelter = next((p for p in layout.get('boarding_points', []) if p['gate'] == gate_id), None)
    if not shelter:
        # Legacy layouts retain their old plan behavior rather than inventing a building.
        return None
    heading = layout['frame'].get('heading_deg', 0)
    local = lambda p: rotate(p, -heading)
    gate = local(next(g['center_m'] for g in layout['gates'] if g['id'] == gate_id))
    centre = local(shelter['center_m'])
    size = shelter['size_m']
    toward = (gate[0] - centre[0], gate[1] - centre[1])
    axis = max((0, 1), key=lambda k: abs(toward[k]) / size[k])
    start = list(centre)
    start[axis] += math.copysign(size[axis] / 2 + .5, toward[axis])
    # The door is a representative cabin-side point, not a certified model hatch.
    path = taxi_leg['path']
    a, z = (path[-2], path[-1]) if alighting else (path[0], path[1])
    delta = ((z[0] - a[0]) * math.cos(math.radians(a[1])), z[1] - a[1])
    forward = local(delta); length = math.hypot(*forward) or 1
    forward = (forward[0] / length, forward[1] / length)
    right = (forward[1], -forward[0])
    sign = 1 if sum((centre[k] - gate[k]) * right[k] for k in (0, 1)) >= 0 else -1
    spec=door or {}
    width=float(spec.get('right_m',1.1)); ahead=float(spec.get('forward_m',.3))
    sill=float(spec.get('height_m',0))
    door = tuple(gate[k] + right[k] * sign * width + forward[k] * ahead for k in (0, 1))
    step = tuple(door[k] + right[k]*sign*1.3 for k in (0,1))
    approach = tuple(gate[k] + right[k] * sign * (width+1.3) + forward[k] * max(4.5,ahead+2) for k in (0, 1))
    obstacles = []
    for item in layout.get('boarding_points', []):
        x, y = local(item['center_m']); w, h = item['size_m']
        obstacles.append((x-w/2-.35, y-h/2-.35, x+w/2+.35, y+h/2+.35))
    for item in layout.get('chargers', []):
        x, y = local(item['center_m']); r = item['radius_m'] + .4
        obstacles.append((x-r, y-r, x+r, y+r))
    corners = [local(p) for p in layout['platform']['corners_m']]
    bounds = (min(p[0] for p in corners)+.4, min(p[1] for p in corners)+.4,
              max(p[0] for p in corners)-.4, max(p[1] for p in corners)-.4)
    # The walk itself depends on the deck, the stand and which way the aircraft
    # sits on it - not on which flight, nor how many are boarding. A day of a
    # few hundred flights between eighteen decks asks for the same few dozen
    # walks over and over; each is worked out once.
    walk_key = (tuple(tuple(box) for box in obstacles), bounds, gate_id, bool(alighting),
                tuple(start), approach, step, door)
    cached = _WALKS.get(walk_key)
    if cached is None:
        points = route(tuple(start), approach, obstacles, bounds)
        points += route(approach, step, obstacles, bounds)[1:]
        points += route(step, door, obstacles, bounds)[1:]
        if alighting:
            points.reverse()
            # Cross the doorway only at the destination, then disappear inside.
            interior = list(start)
            interior[axis] -= math.copysign(.9, toward[axis])
            points.append(tuple(interior))
        marks = [0.0]
        for a, b in zip(points, points[1:]): marks.append(marks[-1] + math.dist(a, b))
        if len(_WALKS) >= _WALK_LIMIT:
            _WALKS.pop(next(iter(_WALKS)))
        cached = _WALKS[walk_key] = (tuple(points), tuple(marks))
    points, marks = list(cached[0]), list(cached[1])
    frame = layout['frame']; latitude = frame['latitude']; longitude = frame['longitude']
    positions = []
    for p in points:
        east, north = rotate(p, heading)
        positions.append([longitude + east / (111320 * math.cos(math.radians(latitude))),
                          latitude + north / 111320])
    walk = marks[-1] / WALK_MPS
    duration = round(2 + (count - 1) * SPACING_S + walk + ENTER_S + 2, 3)
    if not alighting:
        profile = taxi_leg.get('ground_motion')
        if not profile:
            raise ValueError('boarding: 탑승 완료를 기다리는 지상 이동 시간표가 없습니다.')
        extra = max(0, duration - profile['times_s'][0])
        profile['times_s'] = [t + extra for t in profile['times_s']]
        taxi_leg['duration_s'] = round(taxi_leg['duration_s'] + extra, 1)
    return {'schema_version': 1, 'source': 'planned-passenger-visualization', 'gate': gate_id,
            'start_stage': 'charge' if alighting else 'gate_out',
            'facility': shelter['id'], 'count': count, 'path': positions, 'distances_m': marks,
            'walk_mps': WALK_MPS, 'walk_s': walk, 'enter_s': ENTER_S, 'duration_s': duration,
            'release_s': [2 + i * SPACING_S for i in range(count)],
            'door_side': sign, 'door_height_m': sill,
            'path_height_offsets_m': [sill if i == (0 if alighting else len(positions)-1) else 0 for i in range(len(positions))],
            'asset_id': 'kenney_blocky_person_a', 'height_m': 1.75,
            'datum': z[3]}
