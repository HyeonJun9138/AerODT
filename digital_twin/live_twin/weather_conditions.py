"""Provider weather payload -> typed conditions.

A coarse picture of the window: what each sampled point reports now, plus a
summary that names the centre and does not hide the worst corner. Pure: no
requests, no storage, no clock. A payload that cannot be read yields no points
rather than raising, because the display must survive a bad answer.
"""
from collections.abc import Mapping

SCHEMA_VERSION = 1


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _point(entry):
    # Data freezes records: a dict arrives as a mapping proxy, a list as a tuple.
    if not isinstance(entry, Mapping):
        return None
    current = entry.get("current")
    if not isinstance(current, Mapping):
        return None
    latitude, longitude = _number(entry.get("latitude")), _number(entry.get("longitude"))
    if latitude is None or longitude is None:
        return None
    return {
        "latitude": latitude, "longitude": longitude,
        "observed_time": current.get("time") if isinstance(current.get("time"), str) else None,
        "cloud_cover_percent": _number(current.get("cloud_cover")),
        "cloud_low_percent": _number(current.get("cloud_cover_low")),
        "cloud_mid_percent": _number(current.get("cloud_cover_mid")),
        "cloud_high_percent": _number(current.get("cloud_cover_high")),
        "visibility_m": _number(current.get("visibility")),
        "wind_speed_ms": _number(current.get("wind_speed_10m")),
        "wind_gust_ms": _number(current.get("wind_gusts_10m")),
        "wind_direction_deg": _number(current.get("wind_direction_10m")),
        "temperature_c": _number(current.get("temperature_2m")),
        "weather_code": _number(current.get("weather_code")),
        "pressure_hpa": _number(current.get("surface_pressure")),
    }


def read_conditions(payload, received_time):
    entries = payload if isinstance(payload, (list, tuple)) else [payload]
    points = [point for point in (_point(entry) for entry in entries) if point is not None]
    visibilities = [point["visibility_m"] for point in points if point["visibility_m"] is not None]
    centre = points[0] if points else {}
    return {
        "schema_version": SCHEMA_VERSION,
        "received_time": received_time,
        "observed_time": centre.get("observed_time"),
        "points": points,
        "summary": {
            "cloud_cover_percent": centre.get("cloud_cover_percent"),
            "visibility_m": centre.get("visibility_m"),
            "wind_speed_ms": centre.get("wind_speed_ms"),
            "wind_direction_deg": centre.get("wind_direction_deg"),
            "temperature_c": centre.get("temperature_c"),
            "worst_visibility_m": min(visibilities) if visibilities else None,
        },
    }
