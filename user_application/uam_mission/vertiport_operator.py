"""Per-facility resource authority and its PSU reporting boundary.

Each :class:`VertiportOperator` knows only its own facility.  The simulation
feeds it observed occupancy; operator actions feed it availability changes;
and every accepted change produces the same typed report that a remote ICD
adapter can serialize later.  It never reads aircraft geometry and never
sequences traffic.
"""
from dataclasses import dataclass

from digital_twin.contracts.vertiport_resources import (
    VertiportResourceReport, VertiportResourceState,
)


REPORT_TTL_S = 10.0
HEARTBEAT_S = 5.0


@dataclass
class _Resource:
    resource_id: str
    resource_type: str
    operational_state: str = "available"
    occupant_id: str | None = None
    reservation_id: str | None = None
    revision: int = 0

    def state(self):
        return VertiportResourceState(
            resource_id=self.resource_id,
            resource_type=self.resource_type,
            operational_state=self.operational_state,
            occupant_id=self.occupant_id,
            reservation_id=self.reservation_id,
            revision=self.revision,
        )


class VertiportOperator:
    """Resource authority for one and only one vertiport."""

    def __init__(self, vertiport_id, layout, *, operator_id=None, report_ttl_s=REPORT_TTL_S):
        if not vertiport_id:
            raise ValueError("vertiport_id is required")
        self.vertiport_id = str(vertiport_id)
        self.operator_id = operator_id or f"vertiport:{self.vertiport_id}"
        self.report_ttl_s = float(report_ttl_s)
        self._resources = {}
        self._listeners = []
        self._sequence = 0
        self._last_report_s = float("-inf")
        self._now_s = 0.0
        layout = layout or {}
        for kind, field in (("fato", "fatos"), ("stand", "gates"), ("charger", "chargers")):
            for value in layout.get(field) or ():
                identifier = value.get("id")
                if identifier:
                    self._resources[(kind, str(identifier))] = _Resource(str(identifier), kind)

    def subscribe(self, listener):
        if listener not in self._listeners:
            self._listeners.append(listener)

    def _resource(self, kind, identifier):
        key = (str(kind), str(identifier))
        resource = self._resources.get(key)
        if resource is None:
            raise KeyError(f"unknown {kind} resource {self.vertiport_id}/{identifier}")
        return resource

    def resource_ids(self, kind):
        return tuple(sorted(identifier for (found, identifier) in self._resources if found == kind))

    def _publish(self, now_s=None):
        if now_s is not None:
            self._now_s = float(now_s)
        self._sequence += 1
        self._last_report_s = self._now_s
        report = VertiportResourceReport(
            vertiport_id=self.vertiport_id,
            operator_id=self.operator_id,
            sequence=self._sequence,
            observed_s=self._now_s,
            valid_until_s=self._now_s + self.report_ttl_s,
            resources=tuple(resource.state() for _, resource in sorted(self._resources.items())),
        )
        for listener in tuple(self._listeners):
            listener(report)
        return report

    def report(self, now_s=None):
        return self._publish(now_s)

    def heartbeat(self, now_s):
        self._now_s = float(now_s)
        if self._now_s - self._last_report_s >= min(HEARTBEAT_S, self.report_ttl_s / 2):
            return self._publish()
        return None

    def set_operational_state(self, kind, identifier, state, *, now_s=None):
        resource = self._resource(kind, identifier)
        if resource.operational_state == state:
            return self._publish(now_s)
        # Contract validation is deliberately reused rather than duplicated.
        VertiportResourceState(identifier, kind, state)
        resource.operational_state = state
        resource.revision += 1
        return self._publish(now_s)

    def observe_occupancy(self, kind, identifier, occupant_id, *, now_s=None):
        resource = self._resource(kind, identifier)
        occupant_id = str(occupant_id) if occupant_id is not None else None
        if resource.occupant_id != occupant_id:
            resource.occupant_id = occupant_id
            resource.revision += 1
        return self._publish(now_s)

    def reserve(self, kind, identifier, flight_id, *, expected_occupant=None,
                expected_revision=None, now_s=None):
        resource = self._resource(kind, identifier)
        flight_id = str(flight_id)
        if expected_revision is not None and resource.revision != int(expected_revision):
            raise ValueError(f"{self.vertiport_id}/{identifier} 자원 revision 변경")
        if resource.operational_state != "available":
            raise ValueError(f"{self.vertiport_id}/{identifier} 사용 불가")
        if resource.reservation_id not in (None, flight_id):
            raise ValueError(f"{self.vertiport_id}/{identifier} 다른 비행 예약 중")
        if expected_occupant is None:
            if resource.occupant_id not in (None, flight_id):
                raise ValueError(f"{self.vertiport_id}/{identifier} 실제 기체 점유 중")
        elif resource.occupant_id != expected_occupant:
            raise ValueError("출발편 또는 자원 점유가 변경되었습니다")
        if resource.reservation_id != flight_id:
            resource.reservation_id = flight_id
            resource.revision += 1
        return self._publish(now_s)

    def release_reservation(self, kind, identifier, flight_id=None, *, now_s=None):
        resource = self._resource(kind, identifier)
        if resource.reservation_id is not None and (flight_id is None or resource.reservation_id == flight_id):
            resource.reservation_id = None
            resource.revision += 1
        return self._publish(now_s)

    def occupy_reserved(self, kind, identifier, flight_id, occupant_id, *,
                        expected_revision=None, now_s=None):
        resource = self._resource(kind, identifier)
        if expected_revision is not None and resource.revision != int(expected_revision):
            raise ValueError(f"{self.vertiport_id}/{identifier} 자원 revision 변경")
        if resource.operational_state != "available":
            raise ValueError(f"{self.vertiport_id}/{identifier} 사용 불가")
        if resource.occupant_id not in (None, occupant_id):
            raise ValueError(f"{self.vertiport_id}/{identifier} 실제 기체 점유 중")
        if resource.reservation_id not in (None, flight_id):
            raise ValueError(f"{self.vertiport_id}/{identifier} 다른 비행 예약 중")
        resource.occupant_id = str(occupant_id)
        resource.reservation_id = None
        resource.revision += 1
        return self._publish(now_s)

    def reset_observations(self, now_s=0.0):
        changed = False
        for resource in self._resources.values():
            if resource.occupant_id is not None or resource.reservation_id is not None:
                resource.occupant_id = resource.reservation_id = None
                resource.revision += 1
                changed = True
        self._now_s = float(now_s)
        return self._publish() if changed or self._sequence == 0 else self._publish()


class VertiportOperators:
    """Directory that routes every command to the named facility operator."""

    def __init__(self, vertiports, *, report_ttl_s=REPORT_TTL_S):
        self._operators = {
            str(record["id"]): VertiportOperator(
                record["id"], record.get("layout") or {}, report_ttl_s=report_ttl_s)
            for record in vertiports if record.get("id")
        }

    def operator(self, vertiport_id):
        try:
            return self._operators[str(vertiport_id)]
        except KeyError as error:
            raise KeyError(f"unknown vertiport {vertiport_id}") from error

    def subscribe(self, listener):
        for operator in self._operators.values():
            operator.subscribe(listener)

    def publish_all(self, now_s=0.0):
        return tuple(operator.report(now_s) for operator in self._operators.values())

    def heartbeat(self, now_s):
        return tuple(report for operator in self._operators.values()
                     if (report := operator.heartbeat(now_s)) is not None)

    def reset_observations(self, now_s=0.0):
        return tuple(operator.reset_observations(now_s) for operator in self._operators.values())

    def resource_ids(self, vertiport_id, kind):
        return self.operator(vertiport_id).resource_ids(kind)

    def set_operational_state(self, vertiport_id, kind, identifier, state, *, now_s=None):
        return self.operator(vertiport_id).set_operational_state(kind, identifier, state, now_s=now_s)

    def observe_occupancy(self, vertiport_id, kind, identifier, occupant_id, *, now_s=None):
        return self.operator(vertiport_id).observe_occupancy(kind, identifier, occupant_id, now_s=now_s)

    def reserve(self, vertiport_id, kind, identifier, flight_id, *, expected_occupant=None,
                expected_revision=None, now_s=None):
        return self.operator(vertiport_id).reserve(
            kind, identifier, flight_id, expected_occupant=expected_occupant,
            expected_revision=expected_revision, now_s=now_s)

    def release_reservation(self, vertiport_id, kind, identifier, flight_id=None, *, now_s=None):
        return self.operator(vertiport_id).release_reservation(
            kind, identifier, flight_id, now_s=now_s)

    def occupy_reserved(self, vertiport_id, kind, identifier, flight_id, occupant_id, *,
                        expected_revision=None, now_s=None):
        return self.operator(vertiport_id).occupy_reserved(
            kind, identifier, flight_id, occupant_id,
            expected_revision=expected_revision, now_s=now_s)
