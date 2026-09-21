"""Pilot -> Vehicle Runtime command contract.

Manual controls, automatic guidance and pilot-assist output use the same
envelope.  The command contains pilot intent only; the Runtime and simulation
still own controller execution, actuators and physical state.
"""
from dataclasses import dataclass
import math


SCHEMA_VERSION = 1
SOURCES = frozenset(("manual", "automatic", "assisted"))
FLIGHT_MODES = frozenset(("multirotor", "fixed_wing"))


def _finite(value, name):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


@dataclass(frozen=True)
class PilotGuidanceGoal:
    heading_deg: float
    down_m: float
    speed_mps: float

    def __post_init__(self):
        object.__setattr__(self, "heading_deg", _finite(self.heading_deg, "heading_deg") % 360)
        object.__setattr__(self, "down_m", _finite(self.down_m, "down_m"))
        speed = _finite(self.speed_mps, "speed_mps")
        if speed < 0:
            raise ValueError("speed_mps cannot be negative")
        object.__setattr__(self, "speed_mps", speed)

    def as_dict(self):
        return {"heading_deg": self.heading_deg, "down_m": self.down_m,
                "speed_mps": self.speed_mps}

    @classmethod
    def from_dict(cls, payload):
        return cls(**dict(payload))


@dataclass(frozen=True)
class PilotVehicleCommand:
    command_id: str
    pilot_id: str
    vehicle_id: str
    source: str
    sequence: int
    issued_at_s: float
    expires_at_s: float
    throttle: float
    roll: float
    pitch: float
    yaw: float
    flight_mode: str
    flight_id: str | None = None
    guidance: PilotGuidanceGoal | None = None
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if self.schema_version != SCHEMA_VERSION:
            raise ValueError("unsupported Pilot -> Runtime command schema")
        if not self.command_id or not self.pilot_id or not self.vehicle_id:
            raise ValueError("command, pilot and vehicle identifiers are required")
        if self.source not in SOURCES:
            raise ValueError(f"unsupported pilot source: {self.source}")
        if self.flight_mode not in FLIGHT_MODES:
            raise ValueError(f"unsupported flight mode: {self.flight_mode}")
        if (isinstance(self.sequence, bool) or not isinstance(self.sequence, int)
                or self.sequence <= 0):
            raise ValueError("sequence must be a positive integer")
        issued = _finite(self.issued_at_s, "issued_at_s")
        expires = _finite(self.expires_at_s, "expires_at_s")
        if expires < issued:
            raise ValueError("expires_at_s cannot precede issued_at_s")
        object.__setattr__(self, "issued_at_s", issued)
        object.__setattr__(self, "expires_at_s", expires)
        throttle = _finite(self.throttle, "throttle")
        if not 0 <= throttle <= 1:
            raise ValueError("throttle must be within 0..1")
        object.__setattr__(self, "throttle", throttle)
        for name in ("roll", "pitch", "yaw"):
            value = _finite(getattr(self, name), name)
            if not -1 <= value <= 1:
                raise ValueError(f"{name} must be within -1..1")
            object.__setattr__(self, name, value)

    def as_dict(self):
        return {
            "schema_version": self.schema_version, "message_type": "pilot_vehicle_command",
            "direction": "pilot_to_runtime", "command_id": self.command_id,
            "pilot_id": self.pilot_id, "vehicle_id": self.vehicle_id,
            "flight_id": self.flight_id, "source": self.source,
            "sequence": self.sequence, "issued_at_s": self.issued_at_s,
            "expires_at_s": self.expires_at_s, "throttle": self.throttle,
            "roll": self.roll, "pitch": self.pitch, "yaw": self.yaw,
            "flight_mode": self.flight_mode,
            "guidance": self.guidance.as_dict() if self.guidance else None,
        }

    @classmethod
    def from_dict(cls, payload):
        data = dict(payload)
        if data.pop("message_type", "pilot_vehicle_command") != "pilot_vehicle_command":
            raise ValueError("expected message_type pilot_vehicle_command")
        if data.pop("direction", "pilot_to_runtime") != "pilot_to_runtime":
            raise ValueError("expected direction pilot_to_runtime")
        guidance = data.get("guidance")
        if guidance is not None and not isinstance(guidance, PilotGuidanceGoal):
            data["guidance"] = PilotGuidanceGoal.from_dict(guidance)
        return cls(**data)
