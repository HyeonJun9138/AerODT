"""Immutable mission intent for a derived prediction, never a flight command.

Coordinates are (latitude degrees, longitude degrees, absolute altitude metres).
The application captures state and intent under the same session lock. Targets
start at the pilot's active index, not a nearest point on a possibly crossing route.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class PredictionWaypoint:
    start: tuple[float, float, float]
    end: tuple[float, float, float]
    speed_mps: float
    phase: str


@dataclass(frozen=True)
class UamPredictionIntent:
    entity_id: str
    state_time: float
    mission_id: str | None
    phase: str
    waypoints: tuple[PredictionWaypoint, ...] = ()
    target_index: int = 0
    holding: bool = False
    max_speed_mps: float = 60.0
    climb_rate_mps: float = 2.0
    descent_rate_mps: float = 2.54
    landing_rate_mps: float = 1.2
    approach_speed_mps: float = 10.0
    hold_speed_mps: float = 6.0
    brake_mps2: float = .7
    reverse_speed_mps: float = 8.0
    reverse_transition_s: float = 20.0
    reverse_margin_m: float = 100.0
    wing_recover_mps: float = 26.0
