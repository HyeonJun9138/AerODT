"""Immutable filter posterior and public diagnostics owned by the World entity."""
from dataclasses import dataclass

@dataclass(frozen=True)
class SensorPosterior:
    anchor: tuple
    axes: tuple
    position: tuple
    velocity: tuple
    covariance: tuple
    time: float
    seen_gnss: float
    attitude: tuple | None
    attitude_time: float
    seen_attitude: float
    gnss_outliers: int = 0
    attitude_outliers: int = 0
    candidate: tuple | None = None
    candidate_time: float = 0.
    candidate_count: int = 0
    barometer_used: bool = False
    alignment_skew_s: float = 0.
    innovation_m: float = 0.
    correction_m: float = 0.
    outcome: str = 'filtered'
    signature: tuple = ()
    stationary_since: float | None = None
    stationary_position: tuple | None = None
    stationary_attitude: tuple | None = None
    stationary_motion_count: int = 0
    stationary_motion_time: float = -1.
    clock_offset_s: float = 0.
    motion_time_s: float | None = None
    candidate_motion_time_s: float | None = None
    display_epoch: int = 0

@dataclass(frozen=True)
class SensorEstimation:
    mode: str
    horizontal_sigma_m: float
    vertical_sigma_m: float
    correction_m: float
    innovation_m: float
    observation_age_s: float
    raw_observation_age_s: float
    prediction_seconds: float
    gnss_outliers: int
    attitude_outliers: int
    barometer_used: bool
    alignment_skew_s: float
    attitude_age_s: float
    clock_uncertainty_s: float
    stationary: bool = False
    surface_constrained: bool = False
