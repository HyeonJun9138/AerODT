"""Simulation Engine: runs a flight plan and produces the twin's state over time.

A plan says what a flight would be; this runs it and produces what the vehicle
*was* — a state every tick, the way the physical layer would report one if the
aircraft were real. That is the whole point of the separation: in live mode the
states come off an aircraft through the Data Layer, and in simulation mode they
come from here through the same Data Layer, and nothing downstream can tell the
difference or needs to.

A state is the vehicle at one instant: where it is, how it is pointed, how fast,
what its rotors are doing, what is left in the battery and who is aboard. It
also carries the leg it belongs to and how far through that leg it is, because
the heights in a plan are designed against a datum — over the ground, over a
deck — and only the display knows the terrain. Carrying the leg lets the display
resolve the plan's few points once and place thousands of states against them,
rather than sampling the terrain under every one.

The integration here is kinematic: the plan's speeds and stage powers, stepped
at a fixed rate. It is not the FastPhysics/SimpleFlight tiltrotor in
digital_twin/simulation's C++ — that runs the native UAM demo. This module is
the seam that engine plugs into: anything that answers `run(plan)` with the
same states can replace it without touching storage, the wire, or the display.
"""
import math

SCHEMA_VERSION = 1
# States a second. Fast enough that a display never has to invent motion
# between two of them, slow enough that a ten-minute flight is a small file.
DEFAULT_RATE_HZ = 5.0
RATE_RANGE_HZ = (1.0, 50.0)
ENGINE = "kinematic-plan-integrator"


def _clamp(value, low, high):
    return min(high, max(low, value))


def _distance_m(a, b):
    """Metres between (lat, lon) pairs; the same haversine the plan was measured with."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d_lat, d_lon = lat2 - lat1, lon2 - lon1
    h = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    return 2 * 6371000.0 * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d_lon = lon2 - lon1
    y = math.sin(d_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _marks(path):
    """How far along each point of a leg is, and the whole length."""
    marks, total = [0.0], 0.0
    for before, after in zip(path, path[1:]):
        total += _distance_m((before[1], before[0]), (after[1], after[0]))
        marks.append(total)
    return marks, total


def along_leg(leg, fraction):
    """Where a leg is a fraction of the way through, and which way it points.
    A leg that covers no ground — a vertical climb, a charge — is walked by
    point index instead, so it still rises."""
    path = leg.get("path") or []
    if not path:
        return None
    if len(path) == 1:
        point = path[0]
        return {"longitude": point[0], "latitude": point[1], "altitude_m": point[2],
                "datum": point[3] if len(point) > 3 else "msl", "heading_deg": None, "index": 0}
    marks, total = _marks(path)
    eased = _clamp(fraction, 0.0, 1.0)
    scale = marks if total > 0 else [float(index) for index in range(len(path))]
    target = eased * (total if total > 0 else len(path) - 1)
    index = 1
    while index < len(scale) - 1 and scale[index] < target:
        index += 1
    span = scale[index] - scale[index - 1]
    within = (target - scale[index - 1]) / span if span > 0 else 0.0
    start, end = path[index - 1], path[index]
    moved = _distance_m((start[1], start[0]), (end[1], end[0])) > 0.01
    return {
        "longitude": start[0] + (end[0] - start[0]) * within,
        "latitude": start[1] + (end[1] - start[1]) * within,
        "altitude_m": start[2] + (end[2] - start[2]) * within,
        "datum": start[3] if len(start) > 3 else "msl",
        "heading_deg": _bearing_deg((start[1], start[0]), (end[1], end[0])) if moved else None,
        "index": index - 1,
    }


def leg_at(plan, seconds):
    """The leg a second of the flight falls in, and how far through it."""
    legs = plan.get("legs") or []
    if not legs:
        return None
    total = float((plan.get("totals") or {}).get("duration_s") or 0.0)
    time = _clamp(seconds, 0.0, total)
    index = next((at for at, leg in enumerate(legs) if time < leg["end_s"]), len(legs) - 1)
    leg = legs[index]
    span = leg["end_s"] - leg["start_s"]
    return index, leg, (_clamp((time - leg["start_s"]) / span, 0.0, 1.0) if span > 0 else 1.0)


def state_at(plan, seconds, last_heading=0.0):
    """The vehicle at one instant of the flight."""
    found = leg_at(plan, seconds)
    if found is None:
        return None
    index, leg, fraction = found
    total = float((plan.get("totals") or {}).get("duration_s") or 0.0)
    time = _clamp(seconds, 0.0, total)
    point = along_leg(leg, fraction)
    path_fraction = fraction
    ground_speed = None
    if leg.get('ground_motion'):
        from digital_twin.model_library.ground_motion import at
        path_fraction,ground_speed=at(leg['ground_motion'],time-leg['start_s'])
        point=along_leg(leg,path_fraction)
    heading = point["heading_deg"] if point and point["heading_deg"] is not None else last_heading
    if leg.get('ground_motion'):
        from digital_twin.model_library.ground_motion import heading_at
        tangent=heading_at(leg['ground_motion'],path_fraction,time-leg['start_s'])
        if tangent is not None:heading=tangent
    battery = leg["battery_start_pct"] + (leg["battery_end_pct"] - leg["battery_start_pct"]) * fraction
    tilt_from = float(leg.get("tilt_start_deg") or 0.0)
    tilt_to = float(leg.get("tilt_end_deg") or 0.0)
    tilt = tilt_from + (tilt_to - tilt_from) * fraction
    # The nose follows the path: a climbing leg is nose up, a descending one down.
    path = leg.get("path") or []
    climb = (path[-1][2] - path[0][2]) if len(path) >= 2 else 0.0
    pitch = (_clamp(math.degrees(math.atan2(climb, leg["distance_m"])), -25.0, 25.0)
             if leg["kind"] == "air" and leg["distance_m"] > 1 else 0.0)
    flown = sum(item["distance_m"] for item in (plan.get("legs") or [])[:index]) + leg["distance_m"] * path_fraction
    speed = leg["speed_mps"] if (leg["kind"] != "vertical" and leg["distance_m"] > 0) else (
        0.0 if leg["stage"] == "charge" else leg["speed_mps"])
    return {
        "t": round(time, 3), "leg": index, "f": round(path_fraction, 6),
        "stage": leg["stage"], "kind": leg["kind"], "mode": mode_of(tilt),
        "latitude": round(point["latitude"], 7), "longitude": round(point["longitude"], 7),
        "altitude_m": round(point["altitude_m"], 2), "datum": point["datum"],
        "heading_deg": round(heading, 2), "pitch_deg": round(pitch, 2), "tilt_deg": round(tilt, 2),
        "speed_mps": round(ground_speed if ground_speed is not None else speed, 2), "battery_pct": round(battery, 3),
        "distance_done_m": round(flown, 1),
    }


def mode_of(tilt_deg):
    """What the rotors are doing at this tilt."""
    if tilt_deg >= 85:
        return "fixed_wing"
    if tilt_deg <= 5:
        return "multirotor"
    return "transition"


def run(plan, rate_hz=DEFAULT_RATE_HZ):
    """Fly the plan. Returns the states and what the run amounted to.

    Raises ValueError('field: reason') for a plan it cannot fly."""
    legs = (plan or {}).get("legs") or []
    if not legs:
        raise ValueError("plan: no legs to fly")
    try:
        rate = float(rate_hz)
    except (TypeError, ValueError):
        raise ValueError("rate_hz: number expected") from None
    if not RATE_RANGE_HZ[0] <= rate <= RATE_RANGE_HZ[1]:
        raise ValueError(f"rate_hz: {RATE_RANGE_HZ[0]} to {RATE_RANGE_HZ[1]}")
    total = float((plan.get("totals") or {}).get("duration_s") or 0.0)
    step = 1.0 / rate
    states, heading = [], 0.0
    time = 0.0
    # Every tick, and the last instant exactly, so the flight ends where it ends
    # rather than a fraction of a second short of the stand.
    while time < total:
        state = state_at(plan, time, heading)
        heading = state["heading_deg"]
        states.append(state)
        time += step
    final = state_at(plan, total, heading)
    if final is not None and (not states or states[-1]["t"] < final["t"]):
        states.append(final)
    stages = {}
    for state in states:
        stages[state["stage"]] = stages.get(state["stage"], 0) + 1
    summary = {
        "engine": ENGINE, "rate_hz": rate, "states": len(states),
        "duration_s": round(total, 1),
        "battery_start_pct": states[0]["battery_pct"] if states else None,
        "battery_end_pct": states[-1]["battery_pct"] if states else None,
        "battery_min_pct": round(min((state["battery_pct"] for state in states), default=0.0), 3),
        "max_altitude_m": round(max((state["altitude_m"] for state in states), default=0.0), 2),
        "max_speed_mps": round(max((state["speed_mps"] for state in states), default=0.0), 2),
        "distance_m": states[-1]["distance_done_m"] if states else 0.0,
        "stage_states": stages,
    }
    return {"schema_version": SCHEMA_VERSION, "states": states, "summary": summary}
