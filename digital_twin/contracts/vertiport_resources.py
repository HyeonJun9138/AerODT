"""Versioned vertiport resource reports shared with a PSU.

The report is an observation, not a second world state.  A vertiport operator
builds it from the authoritative runtime observation plus its own operational
availability decisions.  A PSU may sequence traffic from the report, but may
not infer that an unreported or stale resource is free.
"""
from dataclasses import dataclass
import math


SCHEMA_VERSION = 1
RESOURCE_TYPES = frozenset(("fato", "stand", "charger"))
OPERATIONAL_STATES = frozenset(("available", "closed", "maintenance", "unknown"))


def _finite(value, name):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


@dataclass(frozen=True)
class VertiportResourceState:
    """One resource as reported by the operator that owns the facility."""

    resource_id: str
    resource_type: str
    operational_state: str = "available"
    occupant_id: str | None = None
    reservation_id: str | None = None
    revision: int = 0

    def __post_init__(self):
        if not self.resource_id:
            raise ValueError("resource_id is required")
        if self.resource_type not in RESOURCE_TYPES:
            raise ValueError(f"unsupported resource_type: {self.resource_type}")
        if self.operational_state not in OPERATIONAL_STATES:
            raise ValueError(f"unsupported operational_state: {self.operational_state}")
        if isinstance(self.revision, bool) or int(self.revision) < 0:
            raise ValueError("resource revision must be a non-negative integer")

    @property
    def usable(self):
        return self.operational_state == "available"

    def as_dict(self):
        return {
            "resource_id": self.resource_id,
            "resource_type": self.resource_type,
            "operational_state": self.operational_state,
            "occupant_id": self.occupant_id,
            "reservation_id": self.reservation_id,
            "revision": int(self.revision),
        }

    @classmethod
    def from_dict(cls, value):
        return cls(**{name: value.get(name) for name in (
            "resource_id", "resource_type", "operational_state", "occupant_id",
            "reservation_id", "revision")})


@dataclass(frozen=True)
class VertiportResourceReport:
    """Immutable ICD payload emitted by exactly one vertiport operator."""

    vertiport_id: str
    sequence: int
    observed_s: float
    valid_until_s: float
    resources: tuple[VertiportResourceState, ...]
    operator_id: str
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if int(self.schema_version) != SCHEMA_VERSION:
            raise ValueError(f"unsupported vertiport resource schema: {self.schema_version}")
        if not self.vertiport_id or not self.operator_id:
            raise ValueError("vertiport_id and operator_id are required")
        if isinstance(self.sequence, bool) or int(self.sequence) <= 0:
            raise ValueError("report sequence must be a positive integer")
        observed = _finite(self.observed_s, "observed_s")
        valid_until = _finite(self.valid_until_s, "valid_until_s")
        if valid_until < observed:
            raise ValueError("valid_until_s cannot precede observed_s")
        resources = tuple(self.resources)
        keys = [(item.resource_type, item.resource_id) for item in resources]
        if len(keys) != len(set(keys)):
            raise ValueError("a resource may appear only once in a report")
        object.__setattr__(self, "observed_s", observed)
        object.__setattr__(self, "valid_until_s", valid_until)
        object.__setattr__(self, "resources", resources)

    def resource(self, resource_type, resource_id):
        return next((item for item in self.resources
                     if item.resource_type == resource_type and item.resource_id == resource_id), None)

    def as_dict(self):
        return {
            "schema_version": int(self.schema_version),
            "message_type": "vertiport_resource_report",
            "vertiport_id": self.vertiport_id,
            "operator_id": self.operator_id,
            "sequence": int(self.sequence),
            "observed_s": self.observed_s,
            "valid_until_s": self.valid_until_s,
            "resources": [item.as_dict() for item in self.resources],
        }

    @classmethod
    def from_dict(cls, value):
        if value.get("message_type", "vertiport_resource_report") != "vertiport_resource_report":
            raise ValueError("not a vertiport resource report")
        return cls(
            schema_version=value.get("schema_version"),
            vertiport_id=value.get("vertiport_id"),
            operator_id=value.get("operator_id"),
            sequence=value.get("sequence"),
            observed_s=value.get("observed_s"),
            valid_until_s=value.get("valid_until_s"),
            resources=tuple(VertiportResourceState.from_dict(item)
                            for item in value.get("resources", ())),
        )
