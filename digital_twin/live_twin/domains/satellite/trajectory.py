"""Satellite orbit propagation and bounded display trajectory."""

import math

EARTH_RADIUS_KM = 6378.137
EARTH_MU_KM3_S2 = 398600.4418
EARTH_ROTATION_RAD_S = 7.29211514670698e-5
MAX_POINTS = 600
MAX_SPAN_SECONDS = 6 * 3600
DENSE_WINDOW_SECONDS = 240
DENSE_STEP_SECONDS = 2


def propagate_ecef(sat, unix_time):
    """Earth-fixed position and velocity in metres; None when the model fails.

    GMST rotation only: a visualization-grade approximation without UT1 or polar
    motion, the same one the current state uses.
    """
    from sgp4.propagation import gstime

    julian = 2440587.5 + unix_time / 86400
    whole = math.floor(julian)
    error, position, velocity = sat.sgp4(whole, julian - whole)
    if error or not all(math.isfinite(value) for value in position + velocity):
        return None
    angle = gstime(julian)
    cosine, sine = math.cos(angle), math.sin(angle)
    fixed = ((cosine * position[0] + sine * position[1]) * 1000,
             (-sine * position[0] + cosine * position[1]) * 1000,
             position[2] * 1000)
    fixed_velocity = ((cosine * velocity[0] + sine * velocity[1]) * 1000 + EARTH_ROTATION_RAD_S * fixed[1],
                      (-sine * velocity[0] + cosine * velocity[1]) * 1000 - EARTH_ROTATION_RAD_S * fixed[0],
                      velocity[2] * 1000)
    return fixed, fixed_velocity


def orbit_summary(sat):
    """Shape of the orbit from the mean elements, not from the sampled points."""
    revolutions = getattr(sat, "no_kozai", None)
    if not revolutions or not math.isfinite(revolutions) or revolutions <= 0:
        return {}
    period_minutes = 2 * math.pi / revolutions
    semi_major_axis_km = (EARTH_MU_KM3_S2 / (revolutions / 60) ** 2) ** (1 / 3)
    eccentricity = float(sat.ecco)
    return {
        "period_minutes": period_minutes,
        "semi_major_axis_km": semi_major_axis_km,
        "apogee_km": semi_major_axis_km * (1 + eccentricity) - EARTH_RADIUS_KM,
        "perigee_km": semi_major_axis_km * (1 - eccentricity) - EARTH_RADIUS_KM,
        "inclination_deg": math.degrees(sat.inclo),
        "eccentricity": eccentricity,
    }


def sample_times(target, start, end, coarse_samples):
    """Coarse over the whole arc, dense around the current position, in order."""
    coarse_step = (end - start) / max(1, coarse_samples - 1)
    times = [start + index * coarse_step for index in range(coarse_samples)]
    steps = int(DENSE_WINDOW_SECONDS / DENSE_STEP_SECONDS)
    times += [target + offset * DENSE_STEP_SECONDS for offset in range(-steps, steps + 1)]
    ordered, previous = [], None
    for moment in sorted(times):
        if start <= moment <= end and (previous is None or moment - previous > DENSE_STEP_SECONDS / 4):
            ordered.append(moment)
            previous = moment
    return ordered[:MAX_POINTS]


def satellite_trajectory(sat, epoch, target, valid_until, *, samples=181):
    """One orbit around the current time, truncated at the catalogue validity edge."""
    summary = orbit_summary(sat)
    period = summary.get("period_minutes", 0) * 60
    span = min(MAX_SPAN_SECONDS, period) if period > 60 else 3600.0
    start = target - span * 0.25
    end = min(start + span, valid_until)
    points = []
    for moment in sample_times(target, start, end, max(2, samples)):
        state = propagate_ecef(sat, moment)
        if state is None:
            continue
        points.append([moment, *state[0]])
    if not points:
        return None
    summary = dict(summary, orbit_epoch=epoch, epoch_age_hours=(target - epoch) / 3600,
                   truncated=span < period)
    return {
        "schema_version": 1, "kind": "satellite", "reference_frame": "ecef_m",
        "derivation": "gp_propagated", "span_seconds": span, "valid_until": valid_until,
        "points": points, "summary": summary,
        "note": "SGP4 propagation of the stored orbital elements; not a measured track.",
    }
