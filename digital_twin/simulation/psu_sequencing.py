"""PSU: who lands next, and who has to wait.

A flight plan says a flight will touch down at 06:48. Two of them saying that
about the same pad is not a contradiction in a spreadsheet, but it is one in the
air. This is the part of the Provider of Services for UAM that resolves it: an
arriving pilot asks before starting the approach, the service answers with a
landing number and the time it may touch down, and if that time is later than
the aircraft would have arrived, the aircraft has to hold.

The rule is first come, first served — by when the request was made, not by who
is closest or who is fullest. It is the simplest rule that is defensible to the
operator whose flight was told to wait, and everything more clever (priority for
low battery, for a connection, for a medical flight) is a change to `_order`
alone.

What this owns is the sequence and the times. It does not know where an aircraft
is, cannot move one, and has no opinion about geometry: where a holding aircraft
actually goes is the engine's problem, because that depends on the airspace
around the deck. What this does own is the record of how long each hold lasted,
because that is the number the day is judged by.

Nothing here is a certified separation service. It is the sequencing behaviour a
rehearsal needs so that a schedule which cannot be flown as written shows that
it cannot, instead of aircraft landing through each other.
"""
import itertools
import math
from collections.abc import MutableMapping
from copy import deepcopy
from dataclasses import dataclass

from digital_twin.contracts.vertiport_resources import VertiportResourceReport
from .holding_queue import HoldingQueue

SCHEMA_VERSION = 1

# One landing per pad per this long. A vertical landing plus the roll-off to the
# taxiway is what the pad is busy for, and the next arrival cannot start its own
# descent onto it until that is done.
FATO_LANDING_SEPARATION_S = 90.0
# How far the computed approach time must move before it is reissued. See
# `Tuning.eat_revision_s`.
EAT_REVISION_S = 20.0
# A departure needs the pad for less time; it leaves on the vertical.
FATO_DEPARTURE_SEPARATION_S = 60.0
# A pad that takes both leaves this much between a landing and a departure.
FATO_MIXED_SEPARATION_S = 75.0
# A hold shorter than this is not worth leaving the corridor for: the aircraft
# simply flies the approach slower. Below it, no hold is recorded.
MINIMUM_HOLD_S = 20.0
# Nobody holds forever. Past this the flight is a diversion candidate, which the
# rehearsal reports rather than pretending it landed.
MAXIMUM_HOLD_S = 1800.0
# What an arrival waits when every stand on the deck is occupied. The service
# cannot know when one frees — that depends on a departure nobody has asked
# about yet — so it holds the aircraft for a look-again interval rather than
# inventing a time or clearing it onto a deck it cannot leave.
STAND_WAIT_S = 120.0

ARRIVAL, DEPARTURE = "arrival", "departure"
GRANTED, HOLDING, REFUSED = "granted", "holding", "refused"


class Tuning:
    """The numbers above, as a thing one sequencer owns rather than a module.

    They stay module constants because that is what they are - the values this
    service was written with - and this is a copy an operator may move without
    changing what the next rehearsal starts from. Nothing here validates: the
    ranges belong to the chart that offers them, and a sequencer handed a
    nonsense number should behave nonsensically rather than quietly correct it.
    """

    __slots__ = ("landing_separation_s", "departure_separation_s", "mixed_separation_s",
                 "minimum_hold_s", "maximum_hold_s", "stand_wait_s",
                 "reassign_stand", "manual_arrival_priority", "eat_revision_s")

    def __init__(self, **given):
        self.landing_separation_s = float(given.get("fato_landing_separation_s", FATO_LANDING_SEPARATION_S))
        self.departure_separation_s = float(given.get("fato_departure_separation_s", FATO_DEPARTURE_SEPARATION_S))
        self.mixed_separation_s = float(given.get("fato_mixed_separation_s", FATO_MIXED_SEPARATION_S))
        self.minimum_hold_s = float(given.get("minimum_hold_s", MINIMUM_HOLD_S))
        self.maximum_hold_s = float(given.get("maximum_hold_s", MAXIMUM_HOLD_S))
        self.stand_wait_s = float(given.get("stand_wait_s", STAND_WAIT_S))
        self.reassign_stand = bool(given.get("reassign_stand", True))
        # A hand-flown aircraft books its pad before the automatic ones that are
        # also still waiting. It never displaces an approach already committed,
        # and separation is unchanged -- the most it can cost anyone else is one
        # slot. There is only ever one of them, and a person practising an
        # approach is the one arrival with nothing to gain from waiting.
        self.manual_arrival_priority = bool(given.get("manual_arrival_priority", False))
        # How far the sequencer's own answer must move before the pilot is told
        # their approach time has changed. Below this the number they were given
        # simply stands: a time that slides a few seconds at a time is worse than
        # one that is occasionally revised out loud.
        self.eat_revision_s = float(given.get("eat_revision_s", EAT_REVISION_S))


class PadTimeline:
    """When one pad is busy, and the first moment after a given time that it is not."""

    def __init__(self, identifier, tuning=None):
        self.id = identifier
        self.tuning = tuning or Tuning()
        self.observed = []  # (actual operation start, flight_id, kind)
        self.slots = []  # (start_s, end_s, flight_id, kind), kept in order

    def separation(self, before, after):
        if before is None:
            return 0.0
        if before == after:
            return self.tuning.landing_separation_s if after == ARRIVAL else self.tuning.departure_separation_s
        return self.tuning.mixed_separation_s

    def earliest(self, wanted, kind, duration, exclude=None):
        """The first time at or after `wanted` this pad is free for `duration`.

        A slot already *is* the time the pad is busy for, so the next operation
        starts when it ends rather than a separation after that — counting both
        would put three minutes between two landings that need ninety seconds.
        The one case where the end is not enough is a different kind of
        operation following: a landing behind a departure needs longer than the
        departure occupied the pad for, so the gap is measured from the earlier
        operation's start as well.
        """
        moment = max([float(wanted)] + [start + self.separation(existing, kind)
                     for start, owner, existing in self.observed if owner != exclude])
        for start, end, owner, existing in self.slots:
            if owner == exclude:
                continue
            # The candidate is over before this slot needs the pad: it fits.
            if moment + max(duration, self.separation(kind, existing)) <= start:
                return moment
            moment = max(moment, end, start + self.separation(existing, kind))
        return moment

    def hold(self, start, duration, flight_id, kind):
        self.slots.append((float(start), float(start) + float(duration), flight_id, kind))
        self.slots.sort(key=lambda slot: slot[0])

    def release(self, flight_id):
        self.slots = [slot for slot in self.slots if slot[2] != flight_id]

    def busy_until(self, moment):
        ends = [end for start, end, _, _ in self.slots if end > moment and start <= moment]
        return max(ends) if ends else None


class StandTimeline:
    """Observed occupants and future reservations, without conflating the two."""

    def __init__(self):
        self.by_stand = {}
        self.reserved = {}

    def occupant(self, vertiport, stand):
        return self.by_stand.get((vertiport, stand))

    def free(self, vertiport, stand, flight_id=None):
        held = self.by_stand.get((vertiport, stand))
        reserved = self.reservation(vertiport, stand)
        return held in (None, flight_id) and reserved in (None, flight_id)

    def reservation(self, vertiport, stand):
        return self.reserved.get((vertiport, stand))

    def reserve(self, vertiport, stand, flight_id):
        if not self.free(vertiport, stand, flight_id):
            raise ValueError(f"주기장 {vertiport}/{stand} 점유 또는 예약 중")
        self.reserved[(vertiport, stand)] = flight_id

    def reserve_future(self, vertiport, stand, flight_id, expected_departure):
        """A prevalidated successor does not remove the real gate occupant."""
        if (expected_departure is None or self.occupant(vertiport,stand) != expected_departure
                or self.reservation(vertiport,stand) not in (None,flight_id)):
            raise ValueError('출발편 또는 주기장 선예약이 변경되었습니다')
        self.reserved[(vertiport,stand)] = flight_id

    def unreserve(self, vertiport, stand, flight_id):
        if self.reservation(vertiport, stand) == flight_id:
            self.reserved.pop((vertiport, stand), None)

    def take(self, vertiport, stand, flight_id):
        if self.occupant(vertiport, stand) not in (None, flight_id):
            raise ValueError(f"주기장 {vertiport}/{stand} 실제 기체 점유 중")
        self.by_stand[(vertiport, stand)] = flight_id

    def occupy_reserved(self, vertiport, stand, flight_id, aircraft_id):
        if (self.occupant(vertiport,stand) not in (None,aircraft_id) or
                self.reservation(vertiport,stand) not in (None,flight_id)):
            raise ValueError(f'주기장 {vertiport}/{stand} 점유 또는 다른 비행 예약 중')
        self.take(vertiport,stand,aircraft_id)
        self.unreserve(vertiport,stand,flight_id)

    def release(self, vertiport, stand, flight_id=None):
        held = self.by_stand.get((vertiport, stand))
        if held is not None and (flight_id is None or held == flight_id):
            self.by_stand.pop((vertiport, stand), None)

    def free_stand(self, vertiport, stands, flight_id=None):
        for stand in stands:
            if self.free(vertiport, stand, flight_id):
                return stand
        return None


class VertiportResourceMonitor:
    """The PSU's read-only cache of reports sent by facility operators.

    Sequence and validity checks live here so every PSU decision sees the same
    interpretation of an ICD report.  The monitor does not ask the simulation
    where an aircraft is and cannot mutate a resource.
    """

    def __init__(self):
        self._reports = {}
        self.now_s = 0.0
        # `occupants`/`reservations` answers for one (kind, moment), kept only
        # while the reports they were read from stand. Every write to
        # `_reports` and every move of `now_s` empties them; the answers
        # handed out are copies, so a caller editing one edits nothing here.
        self._by_kind = {}

    def advance(self, now_s):
        moved = max(self.now_s, float(now_s))
        if moved != self.now_s:
            self.now_s = moved
            self._by_kind.clear()

    def ingest(self, report):
        if isinstance(report, dict):
            report = VertiportResourceReport.from_dict(report)
        if not isinstance(report, VertiportResourceReport):
            raise TypeError("a VertiportResourceReport is required")
        existing = self._reports.get(report.vertiport_id)
        if existing is not None and report.sequence <= existing.sequence:
            return False
        self._reports[report.vertiport_id] = report
        self._by_kind.clear()
        self.advance(report.observed_s)
        return True

    def report(self, vertiport, now_s=None):
        report = self._reports.get(str(vertiport))
        if report is None:
            return None
        effective_now = self.now_s if now_s is None else float(now_s)
        if effective_now > report.valid_until_s:
            return None
        return report

    def resource(self, vertiport, kind, identifier, now_s=None):
        report = self.report(vertiport, now_s)
        return report.resource(kind, str(identifier)) if report else None

    def resource_ids(self, vertiport, kind, now_s=None):
        report = self.report(vertiport, now_s)
        return tuple(item.resource_id for item in report.resources
                     if item.resource_type == kind) if report else ()

    def usable(self, vertiport, kind, identifier, owner=None, now_s=None):
        resource = self.resource(vertiport, kind, identifier, now_s)
        return bool(resource and resource.usable
                    and resource.occupant_id in (None, owner)
                    and resource.reservation_id in (None, owner))

    def occupants(self, kind, now_s=None):
        return dict(self._holders('occupant_id', kind, now_s))

    def reservations(self, kind, now_s=None):
        return dict(self._holders('reservation_id', kind, now_s))

    def _holders(self, field, kind, now_s):
        effective_now = self.now_s if now_s is None else float(now_s)
        key = (field, kind, effective_now)
        known = self._by_kind.get(key)
        if known is not None:
            return known
        result = {}
        for vertiport, report in self._reports.items():
            if effective_now > report.valid_until_s:
                continue
            for resource in report.resources:
                if resource.resource_type == kind and getattr(resource, field) is not None:
                    result[(vertiport, resource.resource_id)] = getattr(resource, field)
        if len(self._by_kind) >= 64:
            self._by_kind.clear()
        self._by_kind[key] = result
        return result

    def clear(self):
        self._reports.clear()
        self._by_kind.clear()
        self.now_s = 0.0


class _ReportedMapping(MutableMapping):
    """Compatibility mapping whose reads are reports and writes are requests."""

    def __init__(self, stands, field):
        self._stands, self._field = stands, field

    def _data(self):
        return (self._stands.monitor.occupants("stand") if self._field == "occupant_id"
                else self._stands.monitor.reservations("stand"))

    def __getitem__(self, key):
        return self._data()[key]

    def __iter__(self):
        return iter(self._data())

    def __len__(self):
        return len(self._data())

    def __setitem__(self, key, value):
        vertiport, stand = key
        if self._field == "occupant_id":
            self._stands.commands.observe_occupancy(vertiport, "stand", stand, value)
        else:
            self._stands.reserve(vertiport, stand, value)

    def __delitem__(self, key):
        vertiport, stand = key
        if key not in self._data():
            raise KeyError(key)
        if self._field == "occupant_id":
            self._stands.commands.observe_occupancy(vertiport, "stand", stand, None)
        else:
            self._stands.commands.release_reservation(vertiport, "stand", stand)

    def clear(self):
        for key in tuple(self._data()):
            del self[key]

    def __deepcopy__(self, memo):
        return deepcopy(self._data(), memo)

    def __eq__(self, other):
        return self._data() == other

    def __repr__(self):
        return repr(self._data())


class ReportedStandResources:
    """Stand decisions made only from operator reports.

    Mutating methods are synchronous request/acknowledgement calls to the
    facility operator.  Their resulting report is delivered to ``monitor`` by
    the operator before the method returns.
    """

    def __init__(self, monitor, commands):
        self.monitor = monitor
        self.commands = commands
        self.by_stand = _ReportedMapping(self, "occupant_id")
        self.reserved = _ReportedMapping(self, "reservation_id")

    def occupant(self, vertiport, stand):
        resource = self.monitor.resource(vertiport, "stand", stand)
        return resource.occupant_id if resource else None

    def reservation(self, vertiport, stand):
        resource = self.monitor.resource(vertiport, "stand", stand)
        return resource.reservation_id if resource else None

    def free(self, vertiport, stand, flight_id=None):
        return self.monitor.usable(vertiport, "stand", stand, flight_id)

    def reserve(self, vertiport, stand, flight_id):
        resource = self.monitor.resource(vertiport, "stand", stand)
        if resource is None:
            raise ValueError(f"주기장 {vertiport}/{stand} 상태 미수신")
        self.commands.reserve(vertiport, "stand", stand, flight_id,
                              expected_revision=resource.revision)

    def reserve_future(self, vertiport, stand, flight_id, expected_departure):
        resource = self.monitor.resource(vertiport, "stand", stand)
        if resource is None:
            raise ValueError(f"주기장 {vertiport}/{stand} 상태 미수신")
        self.commands.reserve(vertiport, "stand", stand, flight_id,
                              expected_occupant=expected_departure,
                              expected_revision=resource.revision)

    def unreserve(self, vertiport, stand, flight_id):
        self.commands.release_reservation(vertiport, "stand", stand, flight_id)

    def take(self, vertiport, stand, flight_id):
        resource = self.monitor.resource(vertiport, "stand", stand)
        if resource is None or not resource.usable:
            raise ValueError(f"주기장 {vertiport}/{stand} 상태 미수신 또는 사용 불가")
        if resource.occupant_id not in (None, flight_id):
            raise ValueError(f"주기장 {vertiport}/{stand} 실제 기체 점유 중")
        self.commands.observe_occupancy(vertiport, "stand", stand, flight_id)

    def occupy_reserved(self, vertiport, stand, flight_id, aircraft_id):
        resource = self.monitor.resource(vertiport, "stand", stand)
        if resource is None:
            raise ValueError(f"주기장 {vertiport}/{stand} 상태 미수신")
        self.commands.occupy_reserved(vertiport, "stand", stand, flight_id, aircraft_id,
                                      expected_revision=resource.revision)

    def release(self, vertiport, stand, flight_id=None):
        resource = self.monitor.resource(vertiport, "stand", stand)
        if resource and resource.occupant_id is not None and (
                flight_id is None or resource.occupant_id == flight_id):
            self.commands.observe_occupancy(vertiport, "stand", stand, None)

    def free_stand(self, vertiport, stands, flight_id=None):
        return next((stand for stand in stands if self.free(vertiport, stand, flight_id)), None)


class Clearance:
    """One answer to one request, and the record of what it cost."""

    __slots__ = ("flight_id", "vertiport", "fato", "stand", "kind", "sequence", "state",
                 "requested_s", "wanted_s", "cleared_s", "hold_s", "reason", "released_s",
                 "eta_s", "approach_s", "approach_started_s", "prediction_s", "revision", "used_s",
                 "eat_s", "eat_revision", "eat_revised_s", "eat_moved_s",
                 "planned_stand", "gate_revision", "gate_reason",
                 "gate_release_aircraft_id", "gate_available_s", "landing_staging", "approach_mode", "holding_assignment",
                 "deferred_stand")

    def __init__(self, **fields):
        for name in self.__slots__:
            setattr(self, name, fields.get(name))

    @property
    def holding(self):
        return self.state == HOLDING

    def as_dict(self):
        return {name: getattr(self, name) for name in self.__slots__}


@dataclass(frozen=True)
class DepartureDecision:
    """PSU's answer for one departure decision point.

    Geometry and live pose remain Simulation observations.  The PSU owns the
    interpretation of those observations: whether they block the operation,
    which FATO plan wins, and whether a departure slot is granted.
    """

    state: str
    reason: str
    blockers: tuple = ()
    clearance: object = None

    @property
    def granted(self):
        return self.state == GRANTED


@dataclass(frozen=True)
class ArrivalCapacityDecision:
    """PSU judgment that one more landing preserves departure capacity.

    Simulation supplies the facility geometry, reported availability and
    imminent-departure identifiers.  The PSU owns the operational rule that
    interprets those facts.  ``available_before`` deliberately caps the target:
    an unrelated maintenance closure does not make a non-interfering arrival
    responsible for restoring capacity that did not exist before it arrived.
    """

    state: str
    reason: str
    required: int = 0
    available_before: int = 0
    available_after: int = 0
    pending_departures: tuple = ()
    blocked_fatos: tuple = ()

    @property
    def granted(self):
        return self.state == GRANTED


class PsuSequencer:
    """First come, first served, per vertiport.

    `stands` answers which stands a vertiport has, so an arrival can be given a
    different one when the planned stand is still occupied. Without it the
    service only sequences pads, which is still correct, just stricter.
    """

    def __init__(self, *, stands=None, now=0.0, tuning=None):
        self.tuning = tuning or Tuning()
        self.waiting = HoldingQueue()
        self._pads = {}
        self._stands = StandTimeline()
        self.resource_monitor = None
        self._vertiport_commands = None
        self._stand_list = stands or (lambda vertiport: ())
        self._numbers = {}
        self._order = itertools.count(1)
        self._clearances = {}
        self._arrival_stands = {}
        self._log = []
        self.now = float(now)

    def attach_vertiports(self, commands, *, now_s=0.0):
        """Connect facility reports and replace the PSU-owned stand table.

        ``commands`` is a directory of per-vertiport operators.  It emits a
        report after every accepted resource request, so subsequent reads are
        from the monitor rather than from the command endpoint itself.
        """
        monitor = VertiportResourceMonitor()
        commands.subscribe(monitor.ingest)
        commands.publish_all(now_s)
        self.resource_monitor = monitor
        self._vertiport_commands = commands
        self._stands = ReportedStandResources(monitor, commands)
        return self

    def fato_occupants(self, now_s=None):
        return (self.resource_monitor.occupants("fato", now_s)
                if self.resource_monitor is not None else {})

    def fato_usable(self, vertiport, fato, flight_id=None, now_s=None):
        if self.resource_monitor is None:
            return True
        return self.resource_monitor.usable(vertiport, "fato", fato, flight_id, now_s)

    def protect_departure_capacity(self, *, takeoff_fatos, dedicated_takeoff_fatos=(),
                                   unavailable_fatos=(), currently_blocked_fatos=(),
                                   candidate_blocked_fatos=(), pending_departures=(),
                                   reserve_ratio=.5, enabled=True,
                                   simultaneous_departure_capacity=None):
        """Keep a configured share of takeoff-capable FATOs usable.

        The rule is active only while a departure is due inside the caller's
        look-ahead.  Existing arrival/closure effects form the baseline; the
        candidate landing is rejected only when it would reduce that baseline
        below the configured reserve.  Thus four shared FATOs at 0.5 preserve
        two takeoff positions, while a pre-existing closure cannot deadlock a
        landing that does not consume any additional departure capacity.
        """
        dedicated = set(map(str, dedicated_takeoff_fatos))
        takeoff = tuple(dict.fromkeys(str(item) for item in takeoff_fatos if str(item) not in dedicated))
        pending = tuple(dict.fromkeys(str(item) for item in pending_departures))
        if not enabled or not pending or not takeoff:
            return ArrivalCapacityDecision(
                GRANTED, '겸용 FATO 보호 대상 없음' if not takeoff else '임박한 출발편 없음 · 착륙 FATO 사용 가능',
                pending_departures=pending)
        unavailable = set(map(str, unavailable_fatos))
        existing = set(map(str, currently_blocked_fatos))
        candidate = set(map(str, candidate_blocked_fatos))
        # Only the shared pool above is subject to a departure capacity quota.
        configured = int(math.ceil(len(takeoff) * max(0., min(1., float(reserve_ratio)))))
        # Some compact layouts cannot operate a landing and a departure at
        # the same time at all. A quota greater than their geometric capacity
        # would forbid every landing, even with an empty deck.
        if simultaneous_departure_capacity is not None:
            configured = min(configured, max(0, int(simultaneous_departure_capacity)))
        before = tuple(fato for fato in takeoff if fato not in unavailable and fato not in existing)
        after = tuple(fato for fato in before if fato not in candidate)
        required = min(configured, len(before))
        blocked = tuple(fato for fato in before if fato in candidate)
        if simultaneous_departure_capacity == 0 and existing & candidate & set(takeoff):
            return ArrivalCapacityDecision(HOLDING,
                '해당 FATO 선행 운항 종료 대기 · 순차 이착륙',
                required, len(before), len(after), pending, blocked)
        if len(after) < required:
            return ArrivalCapacityDecision(
                HOLDING,
                f'이륙 FATO 보호 대기 · {len(after)}/{required}개만 유지',
                required, len(before), len(after), pending, blocked)
        return ArrivalCapacityDecision(
            GRANTED,
            f'이륙 FATO {len(after)}/{required}개 보호',
            required, len(before), len(after), pending, blocked)

    # ---- departure authority ---------------------------------------------
    def departure_blockers(self, *, flight_id, origin, fato, now_s,
                           terminal_conflicts=(), pad_occupants=(), adjacent_fatos=(),
                           arrival_conflicts=(), predictive_arrivals=True,
                           terminal_enabled=True, distinct_fatos_separated=False):
        """Interpret factual resource, occupancy and traffic observations.

        Simulation may calculate that two terminal volumes overlap, but it does
        not decide what that means operationally.  This method is the single
        owner of the rules that turn those observations into PSU blockers.
        """
        blocked = [dict(item) for item in terminal_conflicts]
        if self.resource_monitor is not None:
            resource = self.resource_monitor.resource(origin, "fato", fato, now_s)
            if resource is None or not resource.usable:
                blocked.append({'flight_id': f"resource:{origin}:{fato}",
                                'reason': 'fato_unavailable',
                                'vertiport': origin, 'fato': fato})
        adjacent = set(adjacent_fatos)
        for (place, pad), owner in pad_occupants:
            if place == origin and owner != flight_id and pad in adjacent:
                blocked.append({'flight_id': owner, 'reason': 'pad_occupied',
                                'vertiport': place, 'fato': pad})
        if predictive_arrivals and terminal_enabled:
            minimum_hold = max(self.tuning.landing_separation_s,
                               self.tuning.mixed_separation_s)
            for observed in arrival_conflicts:
                window = observed.get('departure_window')
                if window is not None:
                    # An initial approach is a future conflict, not current
                    # ground occupancy. Only a proven complete gap can bypass
                    # arrival priority; actual pad/terminal blockers above stay.
                    if not window.get('fits'):
                        blocked.append(dict(observed.get('overlap') or {},
                            flight_id=observed['flight_id'], reason=window['reason'],
                            departure_clear_s=window.get('departure_clear_s'),
                            arrival_guard_s=window.get('arrival_guard_s')))
                    continue
                if (not observed.get('airborne') or observed.get('failed')
                        or observed.get('clearance_state') == REFUSED
                        or observed.get('clearance_released_s') is not None
                        or observed.get('stand') is None
                        or observed.get('approach_s') is None
                        or float(observed.get('hold_seconds') or 0) < minimum_hold):
                    continue
                assignment = observed.get('assignment')
                if observed.get('approach_started_s') is None and (
                        float(observed['approach_s']) > float(now_s) + .5
                        or assignment and (assignment.get('state') != 'holding'
                                           or not observed.get('queue_return_clear'))
                        or not assignment and observed.get('instruction_action') in ('yield', 'wait_clear')):
                    continue
                if (distinct_fatos_separated and origin == observed.get('vertiport')
                        and fato != observed.get('fato')):
                    continue
                overlap = dict(observed.get('overlap') or {})
                overlap.update(flight_id=observed['flight_id'], reason='waiting_arrival_priority',
                               vertiport=observed.get('vertiport'), fato=observed.get('fato'))
                blocked.append(overlap)
        return blocked

    def select_departure_plan(self, available, now_s, arrival_forecasts,
                              observe_blockers, *, entry_wait=None):
        """Choose the PSU-preferred executable FATO pair from feasible plans.

        Ground alternatives belong to the vertiport and airborne route
        geometry to the model side. Once those feasible alternatives and
        factual conflict observations are supplied, their ordering and
        operational selection belong here.
        """
        scored = []
        for flight, route in available:
            taxi = route.phases[0].duration_s if route.phases[0].stage == 'gate_out' else 0
            departure = self.pad(flight['origin'], flight['departure_fato'])
            departure_wait = max(0, departure.earliest(
                now_s + taxi, DEPARTURE, self.tuning.departure_separation_s) - (now_s + taxi))
            admission_wait = max(0, entry_wait(flight, route, now_s + departure_wait)) if entry_wait else 0
            eta = now_s + departure_wait + admission_wait + route.remaining_to_touchdown(0, 0)
            actual = self.pad(flight['destination'], flight['arrival_fato'])
            forecast = PadTimeline('candidate', self.tuning)
            forecast.slots, forecast.observed = list(actual.slots), list(actual.observed)
            booked = {row[2] for row in forecast.slots}
            for other in arrival_forecasts:
                if (other['flight_id'] not in booked and other['vertiport'] == flight['destination']
                        and other['fato'] == flight['arrival_fato']):
                    forecast.hold(max(now_s, other['eta_s']), self.tuning.landing_separation_s,
                                  other['flight_id'], ARRIVAL)
            landing = forecast.earliest(eta, ARRIVAL, self.tuning.landing_separation_s)
            blockers = observe_blockers(flight, route)
            ground = flight.get('_departure_ground_route') or {}
            ground_blockers = tuple(ground.get('blocked_by') or ())
            clear_distance = float(ground.get('clear_distance_m') or 0.0)
            # The vertiport proposes static alternatives and attaches its live
            # local occupancy facts. PSU compares them with the wider arrival,
            # FATO and terminal picture; it does not search the taxi graph.
            score = (bool(blockers), bool(ground_blockers), landing,
                     len(forecast.slots), departure_wait, -clear_distance,
                     int(ground.get('rank') or 1), flight['departure_fato'],
                     flight['arrival_fato'], ground.get('route_id') or '')
            scored.append((score, flight, route, {
                'departure_wait_s': round(departure_wait, 1),
                'entry_wait_s': round(admission_wait, 1),
                'arrival_wait_s': round(max(0, landing - eta), 1),
                'forecast_touchdown_s': round(landing, 1),
                'blockers': blockers,
                'ground_route_id': ground.get('route_id'),
                'ground_route_rank': ground.get('rank'),
                'ground_route_distance_m': ground.get('distance_m'),
                'ground_route_clear_distance_m': ground.get('clear_distance_m'),
                'ground_route_blocked_by': list(ground_blockers),
            }))
        _, flight, route, assessment = min(scored, key=lambda item: item[0])
        return flight, route, assessment

    def assess_departure(self, *, flight_id, blockers=()):
        """Give the PSU's pre-slot answer from the current observations."""
        blockers = tuple(dict(item) for item in blockers)
        if not blockers:
            return DepartureDecision(GRANTED, '출발 검토 통과')
        reasons = {item.get('reason') for item in blockers}
        if 'fato_unavailable' in reasons:
            reason = '버티포트 보고상 출발 FATO 사용 불가'
        elif 'arrival_window_too_short' in reasons:
            reason = '도착 전 지상이동·이륙 완료 시간 부족'
        elif 'departure_window_unproven' in reasons:
            reason = '도착 전 출발 완료 예측 확인 대기'
        elif 'waiting_arrival_priority' in reasons:
            reason = '대기 도착편 우선 · 지상 출발 순서 조정'
        else:
            reason = '이륙 경로 또는 패드 점유'
        return DepartureDecision(HOLDING, reason, blockers)

    def committed_arrival_conflict(self, *, vertiport, adjacent_fatos, needed_by_s):
        """Whether a committed arrival has priority over a proposed departure."""
        adjacent = set(adjacent_fatos)
        return any(clearance.vertiport == vertiport and clearance.fato in adjacent
                   and clearance.approach_started_s is not None
                   and (clearance.eta_s if clearance.eta_s is not None
                        else clearance.cleared_s) <= needed_by_s
                   for clearance in self.clearances(kind=ARRIVAL, active_only=True))

    def authorize_departure(self, *, flight_id, vertiport, fato, earliest_s,
                            now_s, blockers=(), committed_arrival_conflict=False):
        """Issue the final PSU departure slot decision; never move an aircraft."""
        review = self.assess_departure(flight_id=flight_id, blockers=blockers)
        if not review.granted:
            if any(item.get('reason') == 'waiting_arrival_priority' for item in review.blockers):
                self.pad(vertiport, fato).release(flight_id)
            return review
        if committed_arrival_conflict:
            return DepartureDecision(HOLDING, '진입한 도착편의 공용 패드 이탈 대기')
        clearance = self.request_departure(flight_id=flight_id, vertiport=vertiport,
                                           fato=fato, earliest_s=earliest_s, now_s=now_s)
        earliest = self.pad(vertiport, fato).earliest(
            earliest_s, DEPARTURE, self.tuning.departure_separation_s, exclude=flight_id)
        if earliest_s < max(clearance.cleared_s, earliest):
            return DepartureDecision(HOLDING, '공용 패드 운항 간격', clearance=clearance)
        return DepartureDecision(GRANTED, '이륙 경로 예약', clearance=clearance)

    # ---- pads --------------------------------------------------------------
    def pad(self, vertiport, fato):
        key = (vertiport, fato)
        timeline = self._pads.get(key)
        if timeline is None:
            timeline = self._pads[key] = PadTimeline(f"{vertiport}:{fato}", self.tuning)
        return timeline

    def landing_number(self, vertiport):
        """Landing numbers count up per vertiport and are never reused in a day."""
        self._numbers[vertiport] = self._numbers.get(vertiport, 0) + 1
        return self._numbers[vertiport]

    # ---- requests ----------------------------------------------------------
    def request_arrival(self, *, flight_id, vertiport, fato, stand, earliest_s, now_s,
                        stands=None, defer_stand=False):
        """Answer an approaching pilot: a landing number, and when they may land.

        `earliest_s` is when the aircraft would touch down if it flew straight
        in. The answer is at or after that; the difference is the hold.
        """
        existing = self._clearances.get((flight_id, ARRIVAL))
        if existing is not None:
            return existing
        now_s = float(now_s)
        self.now = max(self.now, now_s)
        pad = self.pad(vertiport, fato)
        cleared = pad.earliest(max(float(earliest_s), now_s), ARRIVAL, self.tuning.landing_separation_s)
        choices = list(stands if stands is not None else self._stand_list(vertiport) or ())
        if stands is not None:
            self._arrival_stands[flight_id] = tuple(choices)
        unknown_stands = stands is None and not choices
        wanted = stand if stand in choices or unknown_stands else None
        chosen = None if defer_stand else (
            wanted if wanted and self._stands.free(vertiport, wanted, flight_id) else None)
        if not defer_stand and chosen is None and self.tuning.reassign_stand:
            chosen = self._stands.free_stand(vertiport, choices, flight_id) if choices else (stand if unknown_stands else None)
        elif not defer_stand and chosen is None and unknown_stands:
            chosen = stand
        reason = ""
        if defer_stand:
            reason = "접지 후 GATE 배정"
        elif chosen is None:
            # Every stand is taken. The time one frees is not knowable here, so
            # the aircraft is held for a look-again interval past its own
            # arrival rather than cleared onto a deck with nowhere to park.
            cleared = max(cleared, float(earliest_s) + self.tuning.stand_wait_s)
            reason = "주기장 대기"
        elif chosen != stand:
            reason = f"주기장 변경 {stand} → {chosen}"
        hold = max(0.0, cleared - float(earliest_s))
        state = HOLDING if hold >= self.tuning.minimum_hold_s else GRANTED
        if hold > self.tuning.maximum_hold_s:
            state = REFUSED
            reason = reason or "대기 한도 초과"
        clearance = Clearance(flight_id=flight_id, vertiport=vertiport, fato=fato, stand=chosen,
                              kind=ARRIVAL, sequence=self.landing_number(vertiport), state=state,
                              requested_s=now_s, wanted_s=float(earliest_s), cleared_s=cleared,
                              hold_s=hold, reason=reason or ("대기 없음" if state == GRANTED else "선행 착륙 대기"),
                              released_s=None, planned_stand=stand, gate_revision=0,
                              gate_reason=reason or '계획 주기장 유지', deferred_stand=bool(defer_stand))
        if state != REFUSED:
            pad.hold(cleared, self.tuning.landing_separation_s, flight_id, ARRIVAL)
            if choices and chosen is not None:
                self._stands.reserve(vertiport, chosen, flight_id)
        self._clearances[(flight_id, ARRIVAL)] = clearance
        self._log.append(clearance)
        return clearance

    def assign_arrival_stand(self, flight_id, stand, now_s, reason, *, expected_departure=None):
        """Commit a prevalidated assignment, retaining its immutable plan."""
        c = self.clearance(flight_id)
        if c is None or c.state == REFUSED:
            raise ValueError('유효한 도착 허가가 없습니다')
        old = c.stand
        if expected_departure is None:
            self._stands.reserve(c.vertiport,stand,flight_id)  # Fail before mutation.
        else:
            self._stands.reserve_future(c.vertiport,stand,flight_id,expected_departure)
        if old != stand:
            if old: self._stands.unreserve(c.vertiport,old,flight_id)
            c.stand = stand
            c.gate_revision = (c.gate_revision or 0)+1
            c.gate_reason = str(reason)
        return c

    def reassign_arrival(self, flight_id, fato, stand, eta_s, now_s, apply_route):
        """Reserve the replacement bundle, commit intent, then release the old.

        apply_route is synchronous and must either accept atomically or leave
        native intent unchanged. No physics step runs inside this transaction.
        """
        c=self.clearance(flight_id)
        if (c is None or c.state==REFUSED or c.released_s is not None or c.used_s is not None
                or c.approach_started_s is not None or fato==c.fato):return False
        old_fato,old_stand=c.fato,c.stand
        had_reservation=self._stands.reservation(c.vertiport,stand)==flight_id
        self._stands.reserve(c.vertiport,stand,flight_id)
        pad=self.pad(c.vertiport,fato)
        old_slots=list(pad.slots)
        cleared=pad.earliest(max(now_s,eta_s),ARRIVAL,self.tuning.landing_separation_s,exclude=flight_id)
        pad.release(flight_id);pad.hold(cleared,self.tuning.landing_separation_s,flight_id,ARRIVAL)
        accepted=False
        try:
            accepted=bool(apply_route())
        finally:
            if not accepted:
                pad.slots=old_slots
                if not had_reservation:self._stands.unreserve(c.vertiport,stand,flight_id)
        if not accepted:return False
        self.pad(c.vertiport,old_fato).release(flight_id)
        if old_stand and old_stand!=stand:self._stands.unreserve(c.vertiport,old_stand,flight_id)
        c.fato,c.stand=fato,stand
        c.cleared_s,c.eta_s,c.prediction_s=cleared,float(eta_s),float(now_s)
        c.approach_s=None  # The normal prediction/approach checks must run again.
        c.hold_s=max(0.,cleared-c.wanted_s)
        c.state=HOLDING
        c.revision=(c.revision or 0)+1;c.gate_revision=(c.gate_revision or 0)+1
        c.gate_release_aircraft_id=c.gate_available_s=c.landing_staging=None
        c.reason=c.gate_reason=f'착륙 자원 재배정 {old_fato}/{old_stand or "-"} → {fato}/{stand}'
        self._arrival_stands[flight_id]=tuple(self._stand_list(c.vertiport) or (stand,))
        return True

    def reconsider_arrival(self, flight_id, now_s):
        """An occupied gate cannot be overwritten by a predicted arrival time."""
        clearance = self.clearance(flight_id)
        if clearance is None or clearance.stand is not None or clearance.state == REFUSED:
            return clearance
        choices = list(self._arrival_stands.get(flight_id,self._stand_list(clearance.vertiport) or ()))
        if not self.tuning.reassign_stand:
            choices = [s for s in choices if s == clearance.planned_stand]
        stand = self._stands.free_stand(clearance.vertiport, choices, flight_id)
        if stand is None:
            return clearance
        clearance.stand = stand
        self._stands.reserve(clearance.vertiport, stand, flight_id)
        clearance.cleared_s = max(float(now_s), clearance.cleared_s or now_s)
        clearance.reason = f"주기장 배정 {stand}"
        return clearance

    def release_uncommitted_stand(self, flight_id):
        """An unusable tentative gate must not exclude another ready arrival.

        Issued approach commitments keep their gate until lifecycle release.
        This changes resource intent only; the engine retains the flown route.
        """
        c = self.clearance(flight_id)
        if c is None or c.approach_started_s is not None or c.used_s is not None:
            return False
        if c.stand:
            self._stands.unreserve(c.vertiport, c.stand, flight_id)
        c.stand, c.approach_s = None, None
        c.gate_release_aircraft_id = c.gate_available_s = c.landing_staging = None
        self.pad(c.vertiport,c.fato).release(flight_id)
        return True

    def request_departure(self, *, flight_id, vertiport, fato, earliest_s, now_s):
        """A departure needs the pad too, and waits its turn on the same rule."""
        existing = self._clearances.get((flight_id, DEPARTURE))
        if existing is not None and (existing.used_s is not None or existing.released_s is not None):
            return existing
        now_s = float(now_s)
        self.now = max(self.now, now_s)
        pad = self.pad(vertiport, fato)
        cleared = pad.earliest(max(float(earliest_s), now_s), DEPARTURE,
                              self.tuning.departure_separation_s, exclude=flight_id)
        hold = max(0.0, cleared - float(earliest_s))
        minimum = self.tuning.minimum_hold_s
        if existing is not None:
            existing.cleared_s = cleared
            existing.hold_s = max(0., cleared-existing.wanted_s)
            existing.state = HOLDING if hold >= minimum else GRANTED
            existing.reason = '선행 출발 대기' if existing.state == HOLDING else '출발 슬롯 재확인'
            pad.release(flight_id)
            pad.hold(cleared, self.tuning.departure_separation_s, flight_id, DEPARTURE)
            return existing
        clearance = Clearance(flight_id=flight_id, vertiport=vertiport, fato=fato, stand=None,
                              kind=DEPARTURE, sequence=next(self._order), requested_s=now_s,
                              state=HOLDING if hold >= minimum else GRANTED,
                              wanted_s=float(earliest_s), cleared_s=cleared, hold_s=hold,
                              reason="대기 없음" if hold < minimum else "선행 출발 대기", released_s=None)
        pad.hold(cleared, self.tuning.departure_separation_s, flight_id, DEPARTURE)
        self._clearances[(flight_id, DEPARTURE)] = clearance
        self._log.append(clearance)
        return clearance

    def refresh_arrivals(self, observations, now_s, *, buffer_s=12.0):
        """Rebook uncompleted arrivals from observed ETA, retaining issued numbers.

        Observations contain intent/ETA, not physical state ownership. Departures
        remain booked; committed approaches retain precedence over waiting flights.
        A late predecessor therefore pushes the following slots back, while an
        early release closes the gap without a new request or landing number.
        """
        active = [c for c in self._clearances.values() if c.kind == ARRIVAL
                  and c.released_s is None and c.state != REFUSED
                  and c.flight_id in observations]
        for c in active:
            self.pad(c.vertiport, c.fato).release(c.flight_id)
        # An approach already committed keeps its precedence whatever else is
        # waiting: it is on final and nothing here is worth moving it for.
        committed = lambda c: (c.approach_started_s is None, c.approach_started_s or 0)
        manual = (lambda c: bool(observations.get(c.flight_id, {}).get('manual')))             if self.tuning.manual_arrival_priority else (lambda c: False)
        # The earliest moment an arrival could use a slot, which is the part of
        # `wanted` below that does not depend on the order chosen here.
        def soonest(c):
            o = observations[c.flight_id]
            return max(max(float(now_s), float(o['eta_s'])) + buffer_s,
                       float(o.get('pad_available_s', now_s)))
        by_hand = min((soonest(c) for c in active if manual(c)), default=None)
        if by_hand is None:
            active.sort(key=lambda c: (*committed(c), soonest(c), c.requested_s, c.sequence))
        else:
            # A hand-flown aircraft books before the ones it is competing with,
            # and only those. Anything that could be down and clear before the
            # pilot could even arrive stays in front: booking the whole calendar
            # to the person would leave the deck idle while an automatic arrival
            # a minute from the threshold orbited, which is a blockade rather
            # than a priority. Within each group the one that can be there first
            # goes first, so no order chosen here can idle the pad.
            ahead = lambda c: manual(c) or soonest(c) + self.tuning.landing_separation_s <= by_hand
            active.sort(key=lambda c: (*committed(c), 0 if ahead(c) else 1,
                                       soonest(c), c.requested_s, c.sequence))
        preceding_end = {}
        for c in active:
            observation = observations[c.flight_id]
            eta = max(float(now_s), float(observation['eta_s']))
            c.eta_s, c.prediction_s = eta, float(now_s)
            if observation.get('approach_ready') is False:
                # A blocked exit is not an executable predecessor. Keep its
                # number, but leave this capacity to an arrival that can use it.
                c.approach_s = None
                c.state = HOLDING
                c.reason = observation.get('approach_wait_reason') or c.gate_reason or '도착 지상 경로 확보 대기'
                continue
            if not c.deferred_stand:
                self.reconsider_arrival(c.flight_id, now_s)
            if c.stand is None and not c.deferred_stand:
                # No speculative pad booking when there is nowhere to taxi to.
                c.approach_s = None
                c.state, c.reason = HOLDING, '주기장 확보 대기'
                continue
            pad = self.pad(c.vertiport, c.fato)
            key = (c.vertiport, c.fato)
            wanted = max(eta + buffer_s, float(observation.get('pad_available_s', now_s)),
                         preceding_end.get(key, float(now_s)))
            cleared = pad.earliest(wanted, ARRIVAL, self.tuning.landing_separation_s)
            if c.cleared_s is None or abs(cleared - c.cleared_s) >= .5:
                c.revision = (c.revision or 0) + 1
            c.cleared_s = cleared
            c.hold_s = max(0.0, cleared - c.wanted_s)
            c.approach_s = cleared - max(0.0, float(observation['remaining_s'])) - buffer_s
            c.state = HOLDING if c.approach_s > now_s + .5 else GRANTED
            c.reason = '접근 진행 · 도착 예측 갱신' if c.approach_started_s is not None else (
                '예측 슬롯 대기' if c.state == HOLDING else '예측 접근 가능')
            self._issue_approach_time(c, float(now_s))
            pad.hold(cleared, self.tuning.landing_separation_s, c.flight_id, ARRIVAL)
            preceding_end[key] = cleared + self.tuning.landing_separation_s

    def _issue_approach_time(self, c, now_s):
        """Give the pilot a time and then stand by it.

        `approach_s` is recomputed every tick and moves whenever anyone ahead
        moves, which is correct as a forecast and useless as an instruction: a
        number that slides a few seconds at a time cannot be planned against and
        a pilot watching it has no idea whether anything has actually changed.

        So the first answer is issued as the approach time, and it stays issued
        until the sequencer's own answer has moved further than
        `eat_revision_s`. Then it is reissued -- once, out loud, with how far it
        moved -- and stands again. The forecast underneath is untouched; this is
        only what is said.
        """
        wanted = c.approach_s
        if wanted is None:
            c.eat_s = c.eat_moved_s = None
            return
        if c.eat_s is None:
            c.eat_s, c.eat_revision, c.eat_revised_s, c.eat_moved_s = wanted, 0, now_s, 0.0
            return
        moved = wanted - c.eat_s
        if abs(moved) < self.tuning.eat_revision_s:
            return
        c.eat_s = wanted
        c.eat_revision = (c.eat_revision or 0) + 1
        c.eat_revised_s = now_s
        c.eat_moved_s = moved

    def begin_approach(self, flight_id, now_s, *, headway_s=30.0, capacity=3):
        c = self.clearance(flight_id)
        if (c is None or c.state == REFUSED or
                c.stand is None and not c.deferred_stand or c.approach_s is None):
            return False
        if c.approach_started_s is not None:
            return True
        if c.approach_s is None or now_s + .5 < c.approach_s:
            return False
        preceding = [p for p in self._clearances.values()
                     if p.kind == ARRIVAL and p.vertiport == c.vertiport and p.fato == c.fato
                     and p.released_s is None and p.approach_started_s is not None]
        if len(preceding) >= int(capacity) or any(now_s - p.approach_started_s < headway_s for p in preceding):
            c.reason = '선행 접근 간격 대기'
            return False
        # Never jump ahead of a ready, earlier slot just because fleet iteration
        # happens to visit this aircraft first.
        if any(p is not c and p.kind == ARRIVAL and p.vertiport == c.vertiport and p.fato == c.fato
               and p.released_s is None and p.state != REFUSED
               and (p.stand is not None or p.deferred_stand)
               and p.approach_s is not None and p.approach_started_s is None and p.cleared_s < c.cleared_s
               for p in self._clearances.values()):
            c.reason = '선행편 접근 개시 대기'
            return False
        c.approach_started_s = float(now_s)
        c.reason = '접근 허가 · 최종 패드 재확인'
        return True

    # ---- what happened -----------------------------------------------------
    def mark_used(self, flight_id, kind, now_s):
        """Actual takeoff start/touchdown, retained beyond physical pad release."""
        c = self.clearance(flight_id, kind)
        if c is None or c.used_s is not None:
            return
        c.used_s = float(now_s)
        pad = self.pad(c.vertiport, c.fato)
        margin = max(self.tuning.landing_separation_s, self.tuning.departure_separation_s,
                     self.tuning.mixed_separation_s)
        pad.observed = [r for r in pad.observed if r[0] + margin > now_s]
        pad.observed.append((float(now_s), flight_id, kind))

    def complete(self, flight_id, kind, now_s):
        clearance = self._clearances.get((flight_id, kind))
        if clearance is None:
            return None
        if clearance.released_s is None:
            clearance.released_s = float(now_s)
        self.pad(clearance.vertiport, clearance.fato).release(flight_id)
        return clearance

    def leave_stand(self, vertiport, stand, flight_id=None):
        self._stands.release(vertiport, stand, flight_id)

    def take_stand(self, vertiport, stand, flight_id):
        self._stands.take(vertiport, stand, flight_id)

    def clearance(self, flight_id, kind=ARRIVAL):
        return self._clearances.get((flight_id, kind))

    def clearances(self, *, kind=None, active_only=False):
        """Read-only view for audit and factual timing observations."""
        values = tuple(self._clearances.values())
        if kind is not None:
            values = tuple(item for item in values if item.kind == kind)
        if active_only:
            values = tuple(item for item in values if item.released_s is None and item.state != REFUSED)
        return values

    def forget(self, flight_id):
        self._arrival_stands.pop(flight_id,None)
        for kind in (ARRIVAL, DEPARTURE):
            c = self._clearances.pop((flight_id, kind), None)
            if c and c.stand:
                self._stands.unreserve(c.vertiport, c.stand, flight_id)

    def holds(self):
        """Every hold the day has produced, for the record and, later, a chart."""
        return [clearance.as_dict() for clearance in self._log
                if (clearance.hold_s or 0) >= self.tuning.minimum_hold_s]

    def statistics(self):
        held = [clearance for clearance in self._log
                if (clearance.hold_s or 0) >= self.tuning.minimum_hold_s]
        arrivals = [clearance for clearance in held if clearance.kind == ARRIVAL]
        seconds = sorted(clearance.hold_s for clearance in held)
        total = sum(seconds)
        return {
            "requests": len(self._log),
            "held": len(held),
            "held_arrivals": len(arrivals),
            "refused": sum(1 for clearance in self._log if clearance.state == REFUSED),
            "hold_seconds_total": round(total, 1),
            "hold_seconds_mean": round(total / len(held), 1) if held else 0.0,
            "hold_seconds_median": round(seconds[len(seconds) // 2], 1) if seconds else 0.0,
            "hold_seconds_max": round(seconds[-1], 1) if seconds else 0.0,
        }

    def reset(self):
        self._pads.clear()
        # Report-backed resource state belongs to the vertiport operators and
        # is reset by the scenario composition before aircraft are placed.  A
        # standalone/legacy sequencer still owns its local test timeline.
        if self.resource_monitor is None:
            self._stands = StandTimeline()
        self._numbers.clear()
        self._clearances.clear()
        self._arrival_stands.clear()
        self._log.clear()
        self._order = itertools.count(1)
        self.now = 0.0
