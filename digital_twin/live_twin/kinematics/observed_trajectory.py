"""Bounded aircraft projection from the active estimation model."""

import math

from digital_twin.live_twin.kinematics.motion import advance_state, heading_after, up_at

PREDICTION_STEP_SECONDS = 1.0
MAX_PREDICTION_POINTS = 300
PREDICTION_LEAD_SECONDS = 8.0


def aircraft_trajectory(entity, model, seconds, turn_rate_dps=None, target=None):
    """Where the estimation model says this aircraft goes next.

    A projection of the observed velocity — and, under a turning model, the
    observed turn rate — for `seconds` ahead, cut short where the estimate stops
    being valid. It is not a filed route and not a measured track. An aircraft
    whose state is already past its validity edge gets nothing: there is
    nothing left to project from.
    """
    target = entity.state_time if target is None else target
    velocity = entity.velocity_ecef_mps
    if not velocity or not math.isfinite(target) or not math.isfinite(seconds) or seconds <= 0:
        return None
    valid_until = entity.valid_until
    if valid_until is not None and target >= valid_until:
        return None
    span = seconds if valid_until is None else min(seconds, valid_until - target)
    if span <= 0:
        return None
    # What is drawn is `span`; what is computed runs a little past it so the
    # display can keep sliding its window until it asks again.
    covered = span + PREDICTION_LEAD_SECONDS if valid_until is None else min(span + PREDICTION_LEAD_SECONDS, valid_until - target)
    step = max(PREDICTION_STEP_SECONDS, covered / (MAX_PREDICTION_POINTS - 1))
    up = up_at(entity.latitude_deg, entity.longitude_deg)
    turn = turn_rate_dps if model.get("turn") else None
    points, moment = [], 0.0
    while moment < covered + 1e-9:
        position, _ = advance_state(entity.position_ecef_m, velocity, up, turn, moment)
        points.append([target + moment, *position])
        moment += step
    if len(points) < 2:
        return None
    if points[-1][0] < target + covered - 1e-9:
        position, _ = advance_state(entity.position_ecef_m, velocity, up, turn, covered)
        points.append([target + covered, *position])
    climb = sum(u * v for u, v in zip(up, velocity))
    ground = math.sqrt(max(0.0, sum(v * v for v in velocity) - climb * climb))
    return {
        "schema_version": 1, "kind": "aircraft", "reference_frame": "ecef_m",
        "derivation": "estimated", "span_seconds": span, "valid_until": valid_until,
        "points": points,
        "summary": {
            "model": model.get("model_id", ""), "model_label": model.get("label", ""),
            "seconds": span, "requested_seconds": seconds, "covered_seconds": covered,
            "ground_speed_mps": ground, "climb_mps": climb,
            "heading_deg": entity.heading_deg,
            "heading_end_deg": heading_after(entity.heading_deg, turn, span),
            "turn_rate_dps": turn,
            "distance_m": math.dist(points[0][1:], _at(points, target + span)),
            "observation_age_seconds": (None if entity.observation_time is None
                                        else max(0.0, target - entity.observation_time)),
            "truncated": span < seconds,
        },
        "note": "관측된 속도로 앞을 계산한 예상 경로입니다. 제출된 비행계획이나 측정된 궤적이 아닙니다.",
    }


def _at(points, moment):
    """The sampled position at `moment`, between the two points around it."""
    if moment <= points[0][0]:
        return points[0][1:]
    for earlier, later in zip(points, points[1:]):
        if moment <= later[0]:
            span = later[0] - earlier[0]
            share = 0.0 if span <= 0 else (moment - earlier[0]) / span
            return [a + (b - a) * share for a, b in zip(earlier[1:], later[1:])]
    return points[-1][1:]

