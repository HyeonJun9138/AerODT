"""Immutable attitude observation for an isolated test entity, degrees, FRD."""
from dataclasses import dataclass


@dataclass(frozen=True)
class AccelerationObservation:
    observed_at_unix_ms: int
    x_mps2: float
    y_mps2: float
    z_mps2: float
    includes_gravity: bool
    frame: str


@dataclass(frozen=True)
class GpsObservation:
    observed_at_unix_ms: int
    latitude_deg: float
    longitude_deg: float
    altitude_m: float | None
    altitude_reference: str | None
    # Accuracy is what a phone's location service reports about itself. A
    # sender that is not a phone -- a simulator feeding a position -- has no
    # such figure, and inventing one would read as a measurement.
    horizontal_accuracy_m: float | None
    vertical_accuracy_m: float | None


@dataclass(frozen=True)
class TestAttitude:
    device_id: str
    seq: int
    sent_at_unix_ms: int
    roll_deg: float | None
    pitch_deg: float | None
    yaw_deg: float | None
    attitude_observed_at_unix_ms: int | None = None
    acceleration: AccelerationObservation | None = None
    gps: GpsObservation | None = None
    version: int = 1
