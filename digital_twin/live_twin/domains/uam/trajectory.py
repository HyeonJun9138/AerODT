"""Bounded, deterministic UAM intent prediction. This does not run the pilot.

Starts with measured velocity, approaches route guidance with bounded changes,
and stops at the currently granted hold/terminal target. Far-future clearances,
wind and controller responses are unknown; the result remains an estimate.
"""
import math

from digital_twin.model_library.uam_intent_model import MODEL
from digital_twin.live_twin.kinematics.observed_trajectory import aircraft_trajectory
from digital_twin.live_twin.kinematics.motion import up_at

MAX_SECONDS = 240.0
LEAD_SECONDS = 8.0
MAX_POINTS = 300
STEP_SECONDS = .2
GROUND_PHASES = {"parked", "charge", "gate_in", "gate_out"}


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _clamp(value, low, high):
    return max(low, min(high, value))


def _approach(value, target, amount):
    return value + _clamp(target - value, -amount, amount)


def _ecef(latitude, longitude, altitude):
    lat, lon = math.radians(latitude), math.radians(longitude)
    n = 6378137.0 / math.sqrt(1 - 6.69437999014e-3 * math.sin(lat) ** 2)
    return ((n + altitude) * math.cos(lat) * math.cos(lon),
            (n + altitude) * math.cos(lat) * math.sin(lon),
            (n * (1 - 6.69437999014e-3) + altitude) * math.sin(lat))


def uam_trajectory(entity, seconds, intent=None):
    target = entity.state_time
    velocity = entity.velocity_ecef_mps
    if velocity is None and intent is not None and entity.flight_phase in GROUND_PHASES:
        velocity = (0.0, 0.0, 0.0)
    if (not velocity or not all(math.isfinite(x) for x in (*velocity, *entity.position_ecef_m, target, seconds))
            or seconds <= 0):
        return None
    valid = (intent is not None and intent.entity_id == entity.entity_id
             and abs(intent.state_time - target) < 1e-6 and intent.phase == entity.flight_phase)
    if not valid:
        path = aircraft_trajectory(entity, MODEL, min(10.0, seconds))
        if path:
            path["summary"].update(basis="velocity_fallback", requested_seconds=seconds,
                                   flight_phase=entity.flight_phase, truncated=seconds > 10)
            path["note"] = "현재 임무 정보가 없어 실제 속도로 최대 10초만 예측합니다."
        return path
    span = min(MAX_SECONDS, seconds)
    if entity.valid_until is not None:
        span = min(span, entity.valid_until - target)
    if span <= 0:
        return None
    covered = span + LEAD_SECONDS
    if entity.valid_until is not None:
        covered = min(covered, entity.valid_until - target)
    lat, lon, alt = entity.latitude_deg, entity.longitude_deg, entity.altitude_m
    if not all(math.isfinite(x) for x in (lat, lon, alt)) or abs(lat) > 85:
        return None
    north = (-math.sin(math.radians(lat)) * math.cos(math.radians(lon)),
             -math.sin(math.radians(lat)) * math.sin(math.radians(lon)), math.cos(math.radians(lat)))
    east = (-math.sin(math.radians(lon)), math.cos(math.radians(lon)), 0.0)
    up = up_at(lat, lon)
    vn, ve, vz = _dot(velocity, north), _dot(velocity, east), _dot(velocity, up)
    speed, heading = math.hypot(vn, ve), math.atan2(ve, vn)
    initial_speed, initial_climb = speed, vz
    # An established cruise is measured, not an instruction to accelerate to
    # the catalogue's nominal speed. Keep that observed trim until a planned
    # speed reduction, turn or approach requires a change.
    cruise_trim = speed if entity.flight_phase == "cruise" and speed > 1 else None
    scale = 111320.0
    east_scale = scale * math.cos(math.radians(lat))

    def local(point):
        return ((point[0] - lat) * scale, (point[1] - lon) * east_scale, point[2])

    route = []
    for wp in intent.waypoints[:4096]:
        if not all(math.isfinite(x) for x in (*wp.start, *wp.end, wp.speed_mps)) or wp.speed_mps < 0:
            return None
        route.append((local(wp.start), local(wp.end), wp.speed_mps, wp.phase))
    # Idle aircraft have no granted departure. An absent airborne route is not
    # permission to invent one; use the explicitly labelled short fallback.
    if not route and intent.phase not in GROUND_PHASES:
        return uam_trajectory(entity, seconds, None)
    wing_tail = [0.0] * len(route)
    for i in range(len(route)-2, -1, -1):
        a, b, _, phase = route[i+1]
        if phase in {"cruise", "climb"}:
            wing_tail[i] = math.hypot(b[0]-a[0], b[1]-a[1]) + wing_tail[i+1]
    limits = (intent.max_speed_mps, intent.climb_rate_mps, intent.descent_rate_mps,
              intent.landing_rate_mps, intent.approach_speed_mps, intent.hold_speed_mps, intent.brake_mps2,
              intent.reverse_speed_mps, intent.reverse_transition_s, intent.reverse_margin_m, intent.wing_recover_mps)
    if not all(math.isfinite(x) and x > 0 for x in limits):
        return None
    max_speed = min(100.0, intent.max_speed_mps)
    brake = _clamp(intent.brake_mps2, .2, 5.0)
    n = e = 0.0
    z = alt
    cursor = 0
    points = [[target, *entity.position_ecef_m]]
    spacing = max(.5, covered / (MAX_POINTS - 1))
    elapsed = 0.0
    phase = intent.phase
    reached = not route
    alignment_until = None
    reversing = False
    while elapsed < covered - 1e-9:
        sample_at = min(covered, len(points) * spacing)
        while elapsed < sample_at - 1e-9:
            dt = min(STEP_SECONDS, sample_at - elapsed)
            if route and not reached:
                start, end, planned_speed, phase = route[cursor]
                dn, de, dz = end[0] - n, end[1] - e, end[2] - z
                distance = math.hypot(dn, de)
                segment_n, segment_e = end[0] - start[0], end[1] - start[1]
                segment = math.hypot(segment_n, segment_e)
                terminal = cursor == len(route) - 1
                precise = phase in {"takeoff", "landing", "hold", "gate_in", "gate_out"}
                fly_through = not terminal and phase in {"cruise", "climb"} and route[cursor+1][3] in {"cruise", "climb"}
                capture = 1.0 if precise or terminal else (min(150.0, segment*.45) if fly_through else 35.0)
                if distance < capture and (fly_through or abs(dz) < (1.0 if precise else 4.0)):
                    if not terminal:
                        cursor += 1
                        continue
                    if speed < .4 and abs(vz) < .3:
                        reached = True
                # Look along the active segment; only move to the next segment
                # in order. Crossing another leg cannot switch the active target.
                along = 0.0 if segment < .01 else _clamp(
                    ((n - start[0]) * segment_n + (e - start[1]) * segment_e) / segment, 0, segment)
                look = min(segment, along + (max(60.0, min(360.0, speed*7)) if fly_through else max(8.0, speed*1.5)))
                fraction = 1.0 if segment < .01 else look / segment
                aim_n = start[0] + segment_n * fraction - n
                aim_e = start[1] + segment_e * fraction - e
                desired_heading = math.atan2(aim_e, aim_n) if math.hypot(aim_n, aim_e) > .1 else heading
                wanted = min(max_speed, planned_speed)
                if phase == "cruise" and cruise_trim is not None:
                    wanted = min(wanted, cruise_trim)
                if phase in {"cruise", "climb"}:
                    wing_distance = distance + wing_tail[cursor]
                    entry_speed = max(intent.reverse_speed_mps, intent.wing_recover_mps + 4)
                    room = entry_speed * intent.reverse_transition_s + intent.reverse_margin_m
                    if wing_distance < room and speed <= entry_speed:
                        reversing = True
                    if reversing:
                        wanted = min(wanted, intent.reverse_speed_mps)
                    else:
                        wanted = min(wanted, math.sqrt(entry_speed**2 + 2*brake*max(0, wing_distance-room)))
                if phase in {"descent", "hold_exit", "hold_return"}:
                    wanted = min(wanted, intent.approach_speed_mps)
                if intent.holding or phase == "hold":
                    wanted = min(wanted, intent.hold_speed_mps)
                if phase in {"takeoff", "landing"}:
                    wanted = min(wanted, 2.0)
                # Braking begins before a sharp corner, and before every stop.
                exit_speed = 0.0 if terminal or phase in {"takeoff", "landing", "hold"} else wanted
                if not terminal:
                    _, following, next_speed, next_phase = route[cursor + 1]
                    next_heading = math.atan2(following[1] - end[1], following[0] - end[0])
                    corner = abs((next_heading - math.atan2(segment_e, segment_n) + math.pi) % (2 * math.pi) - math.pi)
                    exit_speed = min(exit_speed, next_speed, max(3.0, wanted * math.cos(corner / 2)))
                    if next_phase in {"descent", "landing", "hold"}:
                        exit_speed = min(exit_speed, intent.approach_speed_mps)
                wanted = min(wanted, math.sqrt(max(0.0, exit_speed ** 2 + 2 * brake * max(0, distance - .5))))
                if terminal or phase in {"takeoff", "landing", "hold"}:
                    wanted = min(wanted, distance * .65)
                vertical_limit = intent.climb_rate_mps if dz > 0 else (
                    intent.landing_rate_mps if phase == "landing" else intent.descent_rate_mps)
                # Follow the segment's vertical profile and slow horizontally
                # when a steep approach needs time at its limited descent rate.
                if phase in {"descent", "hold_return"} and distance > 10 and abs(dz) > 1:
                    wanted = min(wanted, vertical_limit * distance / abs(dz))
                # Native climb guidance aims at the target altitude. Returning
                # to the geometric segment height would predict a false descent
                # after an aircraft has already levelled at its assigned height.
                height_target = end[2]
                desired_climb = _clamp((height_target - z) * .8, -vertical_limit, vertical_limit)
                if phase in {"descent", "hold_return"} and distance > 10:
                    desired_climb = _clamp(dz / distance * wanted, -vertical_limit, vertical_limit)
                # The native departure aligns yaw before translation. Estimate
                # that bounded dwell only at the first airborne departure leg,
                # using its 10 deg/s yaw command and a short settling allowance.
                if phase == "climb" and intent.target_index + cursor == 1 and initial_speed < 1:
                    if alignment_until is None:
                        bearing = math.degrees(math.atan2(segment_e, segment_n))
                        angle = abs((bearing - (entity.heading_deg or 0) + 180) % 360 - 180)
                        alignment_until = elapsed + angle / 10.0 + 4.0
                    if elapsed < alignment_until:
                        wanted = desired_climb = 0.0
            else:
                wanted, desired_climb, desired_heading = 0.0, 0.0, heading
            old_vn, old_ve, old_vz = speed * math.cos(heading), speed * math.sin(heading), vz
            error = (desired_heading - heading + math.pi) % (2 * math.pi) - math.pi
            if phase not in {"cruise", "climb"}:
                # Hover/approach control can translate independently of yaw.
                # Forcing a fixed-wing turn radius near a stop makes it orbit.
                dvn = wanted * math.cos(desired_heading) - old_vn
                dve = wanted * math.sin(desired_heading) - old_ve
                factor = min(1.0, brake * dt / max(1e-9, math.hypot(dvn, dve)))
                vn, ve = old_vn + dvn * factor, old_ve + dve * factor
                speed, heading = math.hypot(vn, ve), math.atan2(ve, vn) if math.hypot(vn, ve) > 1e-9 else heading
            else:
                heading += _clamp(error, -min(.6, 3.0 / max(speed, 1.0)) * dt,
                                  min(.6, 3.0 / max(speed, 1.0)) * dt)
                speed = _approach(speed, wanted, brake * dt)
            vz = _approach(vz, desired_climb, .5 * dt)
            n += (old_vn + speed * math.cos(heading)) * .5 * dt
            e += (old_ve + speed * math.sin(heading)) * .5 * dt
            z += (old_vz + vz) * .5 * dt
            elapsed += dt
        points.append([target + elapsed, *_ecef(lat + n / scale, lon + e / east_scale, z)])
    return {
        "schema_version": 1, "kind": "aircraft", "reference_frame": "ecef_m", "derivation": "estimated",
        "span_seconds": span, "valid_until": entity.valid_until, "points": points,
        "summary": {"model": MODEL["model_id"], "model_label": MODEL["label"], "basis": "mission_intent",
                    "seconds": span, "requested_seconds": seconds, "covered_seconds": covered,
                    "ground_speed_mps": initial_speed, "climb_mps": initial_climb,
                    "heading_deg": entity.heading_deg, "flight_phase": intent.phase,
                    "mission_id": intent.mission_id, "target_index": intent.target_index,
                    "holding": intent.holding, "truncated": span < seconds,
                    "distance_m": sum(math.dist(a[1:], b[1:]) * min(1.0, max(0.0, (target + span - a[0]) / (b[0] - a[0])))
                                      for a, b in zip(points, points[1:])),
                    "observation_age_seconds": 0.0},
        "note": "현재 속도·남은 경유점·비행 단계로 계산한 예상입니다. 실제 비행이나 향후 관제 허가를 보장하지 않습니다.",
    }
