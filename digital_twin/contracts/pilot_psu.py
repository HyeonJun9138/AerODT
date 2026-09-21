"""Direction-specific operational messages between a Pilot and a PSU.

Requests and reports travel Pilot -> PSU.  Responses, clearances and
directives travel PSU -> Pilot.  These messages authorize or describe an
operation; none of them is a vehicle control command.
"""
from dataclasses import dataclass
import math
import uuid


SCHEMA_VERSION = 1

PILOT_REQUEST_KINDS = frozenset((
    "departure", "takeoff", "arrival", "hold", "approach", "landing",
))
PILOT_REPORT_KINDS = frozenset((
    "report_airborne", "report_landed", "report_gate", "acknowledgement", "unable",
))
PSU_MESSAGE_KINDS = frozenset((
    "departure_response", "takeoff_clearance", "arrival_sequence", "hold_directive",
    "resume_directive", "approach_clearance", "landing_clearance",
    "report_acknowledgement", "request_refused", "clearance_amendment",
    "clearance_cancellation", "traffic_information",
))
PSU_OUTCOMES = frozenset(("granted", "holding", "hold", "refused", "accepted", "information"))


def new_message_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex}"


def _time(value, name):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


def _sequence(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("sequence must be a positive integer")
    return value


def _identity(message_id, flight_id, aircraft_id, pilot_id, psu_id):
    if not all((message_id, flight_id, aircraft_id, pilot_id, psu_id)):
        raise ValueError("message, flight, aircraft, pilot and PSU identifiers are required")


def _wire(payload, message_type, direction):
    """Validate the fixed envelope before constructing a typed message."""
    data = dict(payload)
    if data.pop("message_type", message_type) != message_type:
        raise ValueError(f"expected message_type {message_type}")
    if data.pop("direction", direction) != direction:
        raise ValueError(f"expected direction {direction}")
    return data


@dataclass(frozen=True)
class PilotPsuRequest:
    """Pilot -> PSU request.  Sending it never grants authority by itself."""

    message_id: str
    flight_id: str
    aircraft_id: str
    pilot_id: str
    psu_id: str
    kind: str
    issued_at_s: float
    sequence: int
    eta_s: float | None = None
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if self.schema_version != SCHEMA_VERSION:
            raise ValueError("unsupported Pilot -> PSU request schema")
        _identity(self.message_id, self.flight_id, self.aircraft_id, self.pilot_id, self.psu_id)
        if self.kind not in PILOT_REQUEST_KINDS:
            raise ValueError(f"unsupported Pilot -> PSU request: {self.kind}")
        object.__setattr__(self, "issued_at_s", _time(self.issued_at_s, "issued_at_s"))
        object.__setattr__(self, "sequence", _sequence(self.sequence))
        if self.eta_s is not None:
            object.__setattr__(self, "eta_s", _time(self.eta_s, "eta_s"))

    def as_dict(self):
        return {
            "schema_version": self.schema_version, "message_type": "pilot_psu_request",
            "direction": "pilot_to_psu", "message_id": self.message_id,
            "flight_id": self.flight_id, "aircraft_id": self.aircraft_id,
            "pilot_id": self.pilot_id, "psu_id": self.psu_id, "kind": self.kind,
            "issued_at_s": self.issued_at_s, "sequence": self.sequence, "eta_s": self.eta_s,
        }

    @classmethod
    def from_dict(cls, payload):
        return cls(**_wire(payload, "pilot_psu_request", "pilot_to_psu"))


@dataclass(frozen=True)
class PilotPsuReport:
    """Pilot -> PSU report of an observed fact, acknowledgement or inability."""

    message_id: str
    flight_id: str
    aircraft_id: str
    pilot_id: str
    psu_id: str
    kind: str
    issued_at_s: float
    sequence: int
    reference_message_id: str | None = None
    reason: str = ""
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if self.schema_version != SCHEMA_VERSION:
            raise ValueError("unsupported Pilot -> PSU report schema")
        _identity(self.message_id, self.flight_id, self.aircraft_id, self.pilot_id, self.psu_id)
        if self.kind not in PILOT_REPORT_KINDS:
            raise ValueError(f"unsupported Pilot -> PSU report: {self.kind}")
        object.__setattr__(self, "issued_at_s", _time(self.issued_at_s, "issued_at_s"))
        object.__setattr__(self, "sequence", _sequence(self.sequence))

    def as_dict(self):
        return {
            "schema_version": self.schema_version, "message_type": "pilot_psu_report",
            "direction": "pilot_to_psu", "message_id": self.message_id,
            "flight_id": self.flight_id, "aircraft_id": self.aircraft_id,
            "pilot_id": self.pilot_id, "psu_id": self.psu_id, "kind": self.kind,
            "issued_at_s": self.issued_at_s, "sequence": self.sequence,
            "reference_message_id": self.reference_message_id, "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, payload):
        return cls(**_wire(payload, "pilot_psu_report", "pilot_to_psu"))


@dataclass(frozen=True)
class PsuPilotMessage:
    """PSU -> Pilot response, clearance, directive or information message."""

    message_id: str
    request_message_id: str
    flight_id: str
    aircraft_id: str
    psu_id: str
    pilot_id: str
    kind: str
    outcome: str
    reason: str
    issued_at_s: float
    expires_at_s: float
    sequence: int
    vertiport_id: str | None = None
    fato_id: str | None = None
    stand_id: str | None = None
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if self.schema_version != SCHEMA_VERSION:
            raise ValueError("unsupported PSU -> Pilot message schema")
        _identity(self.message_id, self.flight_id, self.aircraft_id, self.pilot_id, self.psu_id)
        if not self.request_message_id:
            raise ValueError("request_message_id is required")
        if self.kind not in PSU_MESSAGE_KINDS:
            raise ValueError(f"unsupported PSU -> Pilot message: {self.kind}")
        if self.outcome not in PSU_OUTCOMES:
            raise ValueError(f"unsupported PSU outcome: {self.outcome}")
        issued = _time(self.issued_at_s, "issued_at_s")
        expires = _time(self.expires_at_s, "expires_at_s")
        if expires < issued:
            raise ValueError("expires_at_s cannot precede issued_at_s")
        object.__setattr__(self, "issued_at_s", issued)
        object.__setattr__(self, "expires_at_s", expires)
        object.__setattr__(self, "sequence", _sequence(self.sequence))

    def as_dict(self):
        return {
            "schema_version": self.schema_version, "message_type": "psu_pilot_message",
            "direction": "psu_to_pilot", "message_id": self.message_id,
            "request_message_id": self.request_message_id, "flight_id": self.flight_id,
            "aircraft_id": self.aircraft_id, "psu_id": self.psu_id,
            "pilot_id": self.pilot_id, "kind": self.kind, "outcome": self.outcome,
            "reason": self.reason, "issued_at_s": self.issued_at_s,
            "expires_at_s": self.expires_at_s, "sequence": self.sequence,
            "vertiport_id": self.vertiport_id, "fato_id": self.fato_id,
            "stand_id": self.stand_id,
        }

    @classmethod
    def from_dict(cls, payload):
        return cls(**_wire(payload, "psu_pilot_message", "psu_to_pilot"))


def psu_message_kind(pilot_kind, outcome):
    """Map a request/report result to the PSU message function it represents."""
    if pilot_kind in PILOT_REPORT_KINDS:
        return "report_acknowledgement" if outcome == "accepted" else "request_refused"
    if outcome == "refused":
        return "request_refused"
    if outcome in ("hold", "holding"):
        return "hold_directive"
    return {
        "departure": "departure_response", "takeoff": "takeoff_clearance",
        "arrival": "arrival_sequence", "hold": "resume_directive",
        "approach": "approach_clearance", "landing": "landing_clearance",
    }[pilot_kind]
