"""Immutable live-state contracts; no transport, rendering or file dependencies."""
from dataclasses import dataclass
from .sensor_estimation import SensorPosterior,SensorEstimation


@dataclass(frozen=True)
class SurfaceReference:
    """The simulation's deck datum, in ellipsoidal metres, not a new position."""
    vertiport_id: str
    altitude_m: float


@dataclass(frozen=True)
class DisplayObservation:
    """Accepted past navigation observation for bounded, display-only playout."""
    time: float
    observation_time: float
    context: str
    clock: str
    position_ecef_m: tuple
    velocity_ecef_mps: tuple
    heading_deg: float | None
    pitch_deg: float | None
    roll_deg: float | None
    tilt_deg: float | None
    rotor_radps: float | None
    surface_reference: SurfaceReference | None = None


@dataclass(frozen=True)
class ChargingConnection:
    """Cabinet socket location and representative aircraft-side port offset."""
    charger_id: str
    vertiport_id: str
    longitude_deg: float
    latitude_deg: float
    altitude_m: float
    port_right_m: float
    port_height_m: float
    state: str = 'charging'


@dataclass(frozen=True)
class TwinEntity:
    entity_id: str
    name: str
    kind: str
    position_ecef_m: tuple[float, float, float]
    velocity_ecef_mps: tuple[float, float, float] | None
    latitude_deg: float
    longitude_deg: float
    altitude_m: float
    heading_deg: float | None
    state_time: float
    observation_time: float | None
    received_time: float
    orbit_epoch: float | None
    derivation: str
    quality: str
    source: str
    model_id: str
    visual_asset_id: str
    provenance: str = "live"
    orientation_source: str = "unavailable"
    # How the shipped 3D model was assigned: exact, series, representative, none.
    visual_match: str = "representative"
    valid_until: float | None = None
    discontinuity: bool = False
    continuity_id: int = 0
    pitch_deg: float | None = None
    roll_deg: float | None = None
    tilt_deg: float | None = None
    control_surface_deg: tuple[float, float, float, float] | None = None
    rotor_radps: float | None = None
    flight_phase: str | None = None
    ground_waiting: bool = False
    ground_action: str | None = None
    # Optional display registration against the active terrain provider. The
    # authoritative ECEF position and altitude above remain unchanged.
    surface_reference: SurfaceReference | None = None
    estimation: SensorEstimation | None = None
    # Last accepted observation posterior, not an additional current-state owner.
    estimation_state: SensorPosterior | None = None
    display_observation: DisplayObservation | None = None
    charging_connection: ChargingConnection | None = None
    # The battery as the day's energy model has it: a representative estimate,
    # recorded and never enforced. Absent for anything the twin does not fly.
    battery_pct: float | None = None
    charge_state: str | None = None


@dataclass(frozen=True)
class SourceStatus:
    id: str
    status: str
    updated_at: float | None = None
    message: str = ""


@dataclass(frozen=True)
class ExtensionOutcome:
    enabled: bool = False
    result: object = None
    reason: str = "not_implemented"


@dataclass(frozen=True)
class Snapshot:
    schema_version: int
    sequence: int
    state_time: float
    entities: tuple[TwinEntity, ...]
    sources: tuple[SourceStatus, ...]
    # Which run of the twin's clock this belongs to. State time only ever rises
    # *within* an epoch: that is what stops a late source or a corrected estimate
    # from making the twin appear to go backwards. Looking at another instant on
    # purpose — replaying a scheduled day, and coming back from it — is a new
    # epoch, and everything downstream re-anchors instead of trying to
    # interpolate across the change.
    epoch: int = 0


CAPABILITIES = {
    "perception_track_fusion": False, "situation_assessment": False,
    "mission_resources": False, "environment": False, "airspace_assessment": False,
}
