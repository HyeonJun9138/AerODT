"""Which satellites are over the area on screen.

A satellite is worth carrying when it is above the horizon from somewhere the
operator is looking at, which is a property of the object and the ground, not of
the camera: it does not flicker with a pan and it can be decided from a latitude
and longitude box alone. The angle to the horizon grows with height, so a low
orbit is kept only while it is nearly overhead, and a geostationary one is kept
across a third of the globe, which is exactly where each can be seen from.

Pure geometry: no propagation, no state, no display.
"""
import math

EARTH_RADIUS_M = 6371008.8  # mean radius; the difference to the ellipsoid is far below the margin used


def horizon_angle_deg(altitude_m):
    """How far from its sub-point a satellite at this height is still above the
    horizon, as a great-circle angle. Zero at or below the surface."""
    if altitude_m is None or not math.isfinite(altitude_m) or altitude_m <= 0:
        return 0.0
    return math.degrees(math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + altitude_m)))


def _longitude_gap(low, high, longitude):
    """Degrees of longitude from a value to the [low, high] span, across the
    antimeridian if that is the shorter way round."""
    if low <= longitude <= high:
        return 0.0
    return min(abs((longitude - low + 180) % 360 - 180), abs((longitude - high + 180) % 360 - 180))


def separation_deg(view, latitude_deg, longitude_deg):
    """Great-circle angle from a point to the nearest corner or edge of a view.

    The nearest point is taken by clamping latitude and longitude separately,
    which at high latitude can name a point slightly farther than the true
    nearest one on the box. The overstatement is under a degree where it happens
    at all, so callers add a margin rather than solving the exact geodesic.
    """
    if not all(math.isfinite(value) for value in (latitude_deg, longitude_deg)):
        return 180.0
    latitude = min(max(latitude_deg, view["lamin"]), view["lamax"])
    gap = _longitude_gap(view["lomin"], view["lomax"], longitude_deg)
    longitude = longitude_deg if gap == 0 else longitude_deg + math.copysign(
        gap, ((view["lomin"] + view["lomax"]) / 2 - longitude_deg + 180) % 360 - 180)
    first, second = math.radians(latitude_deg), math.radians(latitude)
    delta = math.radians(longitude - longitude_deg)
    cosine = math.sin(first) * math.sin(second) + math.cos(first) * math.cos(second) * math.cos(delta)
    return math.degrees(math.acos(min(1.0, max(-1.0, cosine))))


def over_view(view, latitude_deg, longitude_deg, altitude_m, margin_deg=0.0):
    """Whether this object can be seen from the view, allowing a margin.

    The margin is what makes a periodic sweep safe: it holds objects that are
    about to rise, so one is already in hand before it is needed. A sub-point
    travels about 0.065 degrees a second in low orbit, so a degree covers some
    fifteen seconds of approach.
    """
    if not view:
        return True
    return separation_deg(view, latitude_deg, longitude_deg) <= horizon_angle_deg(altitude_m) + max(0.0, margin_deg)
