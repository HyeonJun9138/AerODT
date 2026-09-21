"""Compatibility exports for the former mixed trajectory module."""

from digital_twin.live_twin.kinematics.observed_trajectory import (
    MAX_PREDICTION_POINTS,
    PREDICTION_LEAD_SECONDS,
    PREDICTION_STEP_SECONDS,
    _at,
    aircraft_trajectory,
)
from digital_twin.live_twin.domains.satellite.trajectory import (
    DENSE_STEP_SECONDS,
    DENSE_WINDOW_SECONDS,
    EARTH_MU_KM3_S2,
    EARTH_RADIUS_KM,
    EARTH_ROTATION_RAD_S,
    MAX_POINTS,
    MAX_SPAN_SECONDS,
    orbit_summary,
    propagate_ecef,
    sample_times,
    satellite_trajectory,
)

__all__ = [name for name in globals() if not name.startswith("_")]
