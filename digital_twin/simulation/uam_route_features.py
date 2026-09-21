"""What the delivered UAM networks have to be fed, built from a flight we hold.

Those models take two things. One is a history of the aircraft's own state,
twenty-one values a step, which is more than a position: attitude, rates, wind
and what the controller is currently aiming at. The other is the route it has
left to fly, cut into at most forty-eight segments of thirteen values each, in
coordinates aligned with where the aircraft is pointing right now.

The route half is exactly what a loaded flight plan gives us. A scheduled day
already knows the corridor each flight is on and where along it the aircraft
is, so the remaining route is a slice of something we hold rather than
something to be inferred. That is the part this module is mostly about, and it
is the part that can be checked on its own: the geometry either matches the
schema or it does not.

The state half is only partly ours. Position, heading and speed come from the
engine; attitude and rates follow from the path it is flying; the controller
values follow from the phase and the next waypoint. Wind is zero unless a
weather feed says otherwise. What no kinematic engine can supply is the
*controller's own behaviour* — a real one wanders off the line and comes back,
and cross-track error is where that shows. Flying exactly on the corridor makes
that column zero for ever, which is honest about what the engine does and
unlike anything the networks were trained on. It is said rather than hidden.

Nothing here runs a model. It builds the two inputs, in the order the training
run fixed, and says how far it could fill them.
"""
import math

SCHEMA_VERSION = 1
ROUTE_SCHEMA = "shared_segment_v014"
MAX_SEGMENTS = 48
ROUTE_FEATURES = 13
STATE_FEATURES = 21
# The delivery says the project's heading is the model's yaw plus ninety
# degrees, so the column is filled the other way round.
YAW_FROM_HEADING_DEG = -90.0
EARTH_RADIUS_M = 6371000.0


def _enu(origin, point):
    """Metres east, north and up from `origin` to `point`, both (lat, lon, alt).

    A local tangent plane. Over the tens of kilometres a UAM route covers the
    error against a proper projection is centimetres, and the model's own frame
    is a local projection too.
    """
    latitude = math.radians((origin[0] + point[0]) / 2.0)
    east = math.radians(point[1] - origin[1]) * EARTH_RADIUS_M * math.cos(latitude)
    north = math.radians(point[0] - origin[0]) * EARTH_RADIUS_M
    return east, north, float(point[2]) - float(origin[2])


def to_body(east, north, up, heading_deg):
    """East/north/up turned into forward/right/up for an aircraft on this heading."""
    heading = math.radians(heading_deg or 0.0)
    sin_h, cos_h = math.sin(heading), math.cos(heading)
    return (east * sin_h + north * cos_h, east * cos_h - north * sin_h, up)


def _unit(vector):
    length = math.sqrt(sum(component * component for component in vector))
    return (0.0, 0.0, 0.0) if length <= 0 else tuple(component / length for component in vector)


# Two points closer together than this are the same place. A plan's legs meet
# at a shared point, so a corridor built by joining them repeats every junction;
# a zero-length segment carries no direction and would tell the model nothing.
SAME_PLACE_M = 1.0


def _thinned(points):
    """The corridor with repeated and coincident points dropped."""
    kept = []
    for point in points:
        candidate = (float(point[0]), float(point[1]), float(point[2]))
        if kept:
            east, north, up = _enu(kept[-1], candidate)
            if math.sqrt(east * east + north * north + up * up) < SAME_PLACE_M:
                continue
        kept.append(candidate)
    return kept


def remaining_route(points, position):
    """The route from where the aircraft is to the end of it.

    `points` is the whole corridor as (lat, lon, altitude) and `position` is on
    it; the first segment runs from the aircraft to the next point, so the route
    starts where the aircraft actually is rather than at a waypoint it has
    already passed.

    Which waypoint is next is decided by the nearest *segment*, not the nearest
    point. Halfway between two waypoints the one ahead can be a metre nearer
    than the one behind, and choosing by point would then drop the waypoint the
    aircraft is flying towards and cut the corner.
    """
    thinned = _thinned(points or [])
    if len(thinned) < 2:
        return []
    nearest, best = 0, None
    for index in range(len(thinned) - 1):
        distance = _distance_to_segment(position, thinned[index], thinned[index + 1])
        if best is None or distance < best:
            nearest, best = index, distance
    return _thinned([tuple(position), *thinned[nearest + 1:]])


def _distance_to_segment(position, start, end):
    """How far the aircraft is from a segment, measured to the segment itself."""
    east, north, up = _enu(start, end)
    length_squared = east * east + north * north + up * up
    to_east, to_north, to_up = _enu(start, position)
    if length_squared <= 0:
        return math.sqrt(to_east * to_east + to_north * to_north + to_up * to_up)
    along = (to_east * east + to_north * north + to_up * up) / length_squared
    along = max(0.0, min(1.0, along))
    offset = (to_east - east * along, to_north - north * along, to_up - up * along)
    return math.sqrt(sum(component * component for component in offset))


def crop_distance(horizon_seconds, target_speed_mps):
    """How much route the networks are given: what they could fly in the horizon."""
    horizon = max(0.0, float(horizon_seconds or 0.0))
    speed = max(0.0, float(target_speed_mps or 0.0))
    return horizon * speed


def route_segments(points, position, heading_deg, *, horizon_seconds=10.0, target_speed_mps=0.0,
                   max_segments=MAX_SEGMENTS):
    """The remaining route as `shared_segment_v014` rows, body-aligned.

    Cut at the distance the aircraft could cover in the horizon, keeping the
    segment that crosses that boundary, and never more than `max_segments`.
    Answers the rows and the mask the model is given alongside them.
    """
    route = remaining_route(points, position)
    if len(route) < 2:
        return [], []
    limit = crop_distance(horizon_seconds, target_speed_mps)
    rows, travelled = [], 0.0
    for index in range(len(route) - 1):
        start, end = route[index], route[index + 1]
        east, north, up = _enu(start, end)
        length = math.sqrt(east * east + north * north + up * up)
        # Where the segment's far end sits relative to the aircraft now.
        end_body = to_body(*_enu(position, end), heading_deg)
        direction = _unit(to_body(east, north, up, heading_deg))
        after = _turn_after(route, index, heading_deg)
        rows.append([
            end_body[0], end_body[1], end_body[2],
            direction[0], direction[1], direction[2],
            length, travelled, travelled + length,
            after[0], after[1], after[2],
            1.0 if index == len(route) - 2 else 0.0,
        ])
        travelled += length
        # The segment that crosses the boundary is kept, and then it stops.
        if limit > 0 and travelled >= limit:
            break
        if len(rows) >= max_segments:
            break
    rows = rows[:max_segments]
    return rows, [True] * len(rows)


def _turn_after(route, index, heading_deg):
    """The turn at the far end of this segment, as (sin, cos, valid)."""
    if index + 2 >= len(route):
        return (0.0, 0.0, 0.0)
    here = to_body(*_enu(route[index], route[index + 1]), heading_deg)
    onward = to_body(*_enu(route[index + 1], route[index + 2]), heading_deg)
    first, second = math.atan2(here[1], here[0]), math.atan2(onward[1], onward[0])
    turn = (second - first + math.pi) % (2 * math.pi) - math.pi
    return (math.sin(turn), math.cos(turn), 1.0)


def padded(rows, masks, max_segments=MAX_SEGMENTS):
    """Rows and mask at full width, valid segments first, the rest zeroed."""
    rows = [list(row) for row in rows[:max_segments]]
    mask = [bool(flag) for flag in masks[:max_segments]]
    while len(rows) < max_segments:
        rows.append([0.0] * ROUTE_FEATURES)
        mask.append(False)
    return rows, mask


def state_row(state, *, elapsed_s, origin, route_points=None, wind=(0.0, 0.0, 0.0),
              previous=None, dt=None):
    """One step of history, in the twenty-one columns the training run fixed.

    `origin` is the reference the model's `x`/`y` are measured from, which the
    checkpoint carries. `previous` and `dt` are the step before this one and how
    long ago it was, so the body rates are the ones the aircraft actually flew
    rather than zeros.
    """
    latitude, longitude = float(state["latitude_deg"]), float(state["longitude_deg"])
    altitude = float(state["altitude_m"])
    heading = state.get("heading_deg")
    heading = 0.0 if heading is None else float(heading)
    east, north, _ = _enu((origin[0], origin[1], 0.0), (latitude, longitude, 0.0))
    speed = float(state.get("speed_mps") or 0.0)
    roll, pitch = _attitude(state, previous, dt)
    rates = _rates(state, previous, dt, roll, pitch)
    target = _controller(state, route_points, (latitude, longitude, altitude), heading)
    return [
        float(elapsed_s), east, north, altitude,
        roll, pitch, heading + YAW_FROM_HEADING_DEG,
        speed, 0.0, _climb_rate(state, previous, dt),
        rates[0], rates[1], rates[2],
        float(wind[0]), float(wind[1]), float(wind[2]),
        target["speed"], target["cross_track"],
        target["forward"], target["right"], target["up"],
    ]


def _attitude(state, previous, dt):
    """Roll from how fast the heading is turning, pitch from the climb.

    A kinematic engine flies a path rather than an airframe, so neither is
    measured. Both follow from the path it is flying, which is the closest thing
    to an attitude it has.
    """
    speed = float(state.get("speed_mps") or 0.0)
    turn = _turn_rate(state, previous, dt)
    roll = math.degrees(math.atan2(math.radians(turn) * speed, 9.80665)) if speed > 0 else 0.0
    climb = _climb_rate(state, previous, dt)
    pitch = math.degrees(math.atan2(climb, speed)) if speed > 0 else 0.0
    return roll, pitch


def _turn_rate(state, previous, dt):
    if not previous or not dt or state.get("heading_deg") is None or previous.get("heading_deg") is None:
        return 0.0
    change = (float(state["heading_deg"]) - float(previous["heading_deg"]) + 180.0) % 360.0 - 180.0
    return change / dt


def _climb_rate(state, previous, dt):
    if not previous or not dt:
        return 0.0
    return (float(state["altitude_m"]) - float(previous["altitude_m"])) / dt


def _rates(state, previous, dt, roll, pitch):
    """Roll, pitch and yaw rates. Only yaw is really flown; the other two are
    how fast the attitudes above are changing."""
    yaw_rate = _turn_rate(state, previous, dt)
    if not previous or not dt:
        return (0.0, 0.0, yaw_rate)
    previous_roll, previous_pitch = previous.get("_roll", roll), previous.get("_pitch", pitch)
    return ((roll - previous_roll) / dt, (pitch - previous_pitch) / dt, yaw_rate)


def _controller(state, route_points, position, heading_deg):
    """What a controller flying this would be aiming at.

    The target speed is the speed the phase is flown at. The waypoint values are
    the next route point relative to the aircraft. Cross-track error is zero
    because the engine flies the corridor exactly, and that is a fact about the
    engine rather than about the flight.
    """
    speed = float(state.get("speed_mps") or 0.0)
    empty = {"speed": speed, "cross_track": 0.0, "forward": 0.0, "right": 0.0, "up": 0.0}
    route = remaining_route(route_points or [], position)
    if len(route) < 2:
        return empty
    forward, right, up = to_body(*_enu(position, route[1]), heading_deg)
    return {"speed": speed, "cross_track": 0.0, "forward": forward, "right": right, "up": up}


def describe(rows, masks, *, points, horizon_seconds, target_speed_mps):
    """What was built, so a caller can say whether it is enough to run a model."""
    valid = sum(1 for flag in masks if flag)
    return {
        "schema": ROUTE_SCHEMA,
        "segments": valid,
        "max_segments": MAX_SEGMENTS,
        "features": ROUTE_FEATURES,
        "route_points": len(points or []),
        "crop_m": round(crop_distance(horizon_seconds, target_speed_mps), 1),
        "route_m": round(rows[-1][8], 1) if rows else 0.0,
        "complete": bool(rows) and masks[-1] and rows[-1][12] == 1.0,
        # The one column a kinematic engine cannot fill honestly.
        "cross_track_is_zero": True,
    }
