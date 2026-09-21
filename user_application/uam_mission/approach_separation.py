"""Bounded, level separation goals for a stopped, yielding approach.

The leader remains stopped. A follower may vacate only along a checked segment;
an already deficient separation must increase, never become a new crossing.
These are pilot goals, not edits to physical state or landing permissions.
"""
import math
from digital_twin.model_library.terminal_paths import segment_distance
from .traffic_awareness import relative, velocity


def clear_transfer(own, target, observations, policy):
    horizontal = policy.get('traffic_horizontal_m', 120.0)
    vertical = policy.get('traffic_vertical_m', 45.0)
    horizon = policy.get('traffic_lookahead_s', 35.0)
    delta = relative(own, dict(latitude_deg=target[0], longitude_deg=target[1], altitude_m=target[2]))
    # Candidate generation is exactly level. Rechecking an existing target
    # must tolerate normal sub-metre native altitude tracking error, otherwise
    # every acceleration cancels and recreates the same manoeuvre.
    if abs(delta[2]) > 1.0 or math.hypot(*delta[:2]) > horizontal * 2 + 1:
        return False
    for other in observations:
        if other['aircraft_id'] == own['aircraft_id']:
            continue
        p = relative(own, other)
        vn, ve, vz = velocity(other)
        reserved = other.get('separation_target')
        end = relative(own, dict(latitude_deg=reserved[0], longitude_deg=reserved[1], altitude_m=reserved[2])) if reserved else (
            p[0] + vn*horizon, p[1] + ve*horizon, p[2] + vz*horizon)
        if min(p[2], end[2]) > vertical or max(p[2], end[2]) < -vertical:
            continue
        distance = math.hypot(*p[:2])
        closest = segment_distance((0, 0), delta[:2], p[:2], end[:2])
        if distance < horizontal:
            # Recovery from an existing infringement is allowed only away from
            # a stopped neighbour. Moving/also relocating traffic is not fixed.
            if (math.hypot(vn, ve) > .5 or abs(vz) > .2 or reserved
                    or closest < distance - .05
                    or math.dist(delta[:2], p[:2]) < horizontal + 20):
                return False
        elif closest < horizontal:
            return False
    return True


def candidates(own, observations, policy):
    if (own.get('guidance', {}).get('landing_yaw_mutable') is not True
            or own.get('speed_mps', 0) > 1 or not own.get('airborne')):
        return []
    threat = next((r for r in observations if r['aircraft_id'] == own.get('instruction', {}).get('traffic_id')), None)
    if threat is None:
        return []
    north, east, _ = relative(threat, own)
    bearing = math.atan2(east, north)
    distance = policy.get('traffic_horizontal_m', 120.0) * 1.5
    scale = 111320 * math.cos(math.radians(own['latitude_deg']))
    answers = []
    for angle in (0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180):
        yaw = bearing + math.radians(angle)
        target = (own['latitude_deg'] + math.cos(yaw)*distance/111320,
                  own['longitude_deg'] + math.sin(yaw)*distance/scale, own['altitude_m'])
        if clear_transfer(own, target, observations, policy):
            answers.append(target)
    return answers
