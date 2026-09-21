"""One airframe of a scheduled day, flown by a person instead of the model.

The day already knows how to fly itself: the engine walks each aircraft along
its route and the PSU sequences who uses which pad and when. Handing one over
changes exactly two things. Its position stops coming from the route and starts
coming from whoever is holding the stick, and its clearances stop being taken
automatically and start being asked for.

Everything else is deliberately left alone. The aircraft keeps its flight, its
stand and its place in the sequence; other aircraft see it where it actually is,
wait for the pad it is actually on, and are held behind it when it is late. That
is the whole point of flying inside the day rather than beside it.

A person can also do what the model never does -- leave without a clearance, or
fly through a hold. The service is a sequencer, not a controller: it cannot stop
an aircraft, so neither does this. What it does is say so, and write it down.
"""
import math
from digital_twin.contracts.pilot_psu import (
    PILOT_REPORT_KINDS, PilotPsuReport, PilotPsuRequest, new_message_id,
)
from digital_twin.simulation import psu_sequencing, manual_procedure

# Airborne, and not walking a route. It is not in GROUND_PHASES, so everything
# that asks whether this aircraft is flying gets the right answer, and it is in
# no phase list the route walker uses, so nothing tries to advance it.
PHASE_MANUAL = "manual"
# On the deck under a person's control: taxiing out, or holding at the stand.
PHASE_MANUAL_GROUND = "gate_out"
# How far ahead of its off-block time a flight is worth offering. Shorter and
# there is nothing on the list at a quiet hour; longer and the list fills with
# flights that will not be ready for an hour.
OFFER_WINDOW_S = 2700.0
INITIAL_DEPARTURE_PRIORITY_S = 120.0


def _flight_of(engine, aircraft):
    if aircraft.external and aircraft.external.get("completed"):
        return engine.flights.get(aircraft.external["flight_id"])
    if aircraft.flight is not None:
        return aircraft.flight
    if aircraft.next_flight >= len(aircraft.flights):
        return None
    identifier = aircraft.flights[aircraft.next_flight]
    assigned = engine._assigned_plans.get(identifier)
    return assigned[0] if assigned else engine.flights.get(identifier)


def next_flight(engine, aircraft, *, now=None):
    """The next scheduled use of this airframe after a reported arrival.

    This is advice about the existing day, not a generated flight.  It stays
    absent until the current flight has actually been reported at the gate, so
    a cockpit never mistakes a later roster row for its present assignment.
    """
    ext = aircraft.external or {}
    if not ext.get("completed") or aircraft.next_flight >= len(aircraft.flights):
        return None
    identifier = aircraft.flights[aircraft.next_flight]
    assigned = engine._assigned_plans.get(identifier)
    flight = assigned[0] if assigned else engine.flights.get(identifier)
    if flight is None:
        return None
    when = engine.time_s if now is None else float(now)
    ready_s = max(float(flight.get("off_block_s") or 0), float(aircraft.ready_s or 0))
    return {
        "flight_id": flight["flight_id"], "origin": flight["origin"],
        "destination": flight["destination"], "off_block_s": flight.get("off_block_s"),
        "ready_s": ready_s, "wait_s": max(0.0, ready_s-when),
        "ready": when >= ready_s,
        "departure_fato": flight.get("departure_fato"),
        "arrival_fato": flight.get("arrival_fato"),
        "arrival_stand": flight.get("arrival_stand"),
        "passengers": flight.get("passengers", 0),
        "target_soc_pct": aircraft.energy.profile.get("charge_target_pct", 90.0),
        "same_location": aircraft.vertiport == flight["origin"],
    }


def continue_flight(engine, aircraft_id, *, battery_pct=None, now=None):
    """Turn a completed manual assignment into this airframe's next roster row.

    Pose and runtime stay with the cockpit.  Only the day-owned assignment is
    advanced here; departure still needs its normal explicit PSU request.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        raise ValueError("수동 배정된 기체가 아닙니다")
    upcoming = next_flight(engine, aircraft, now=now)
    if upcoming is None:
        raise ValueError("이 기체에 남은 예정 비행편이 없습니다")
    if aircraft.airborne or aircraft.phase != "parked":
        raise ValueError("도착 GATE에 정차한 상태에서만 다음 비행을 준비할 수 있습니다")
    if not upcoming["same_location"]:
        raise ValueError("다음 비행 출발지와 현재 기체 위치가 다릅니다 · 재배치 운항이 필요합니다")
    if isinstance(battery_pct, bool) or not isinstance(battery_pct, (int, float)) or not math.isfinite(battery_pct):
        raise ValueError("다음 비행 준비에 배터리 잔량이 필요합니다")
    target = float(upcoming["target_soc_pct"])
    if battery_pct + 1e-6 < target:
        raise ValueError(f"배터리 {target:.0f}%까지 충전한 뒤 다음 비행을 준비하세요")

    previous = _flight_of(engine, aircraft)
    before = aircraft.energy.soc_pct
    aircraft.battery_pct = battery_pct
    if previous is not None:
        added = max(0.0, aircraft.energy.soc_pct-before)/100*aircraft.energy.profile["capacity_kwh"]
        aircraft.energy.charged_kwh += added
        engine._record(engine.time_s if now is None else float(now), "manual_turnaround_complete", previous,
                       next_flight_id=upcoming["flight_id"], battery_pct=round(aircraft.energy.soc_pct, 3))

    when = engine.time_s if now is None else float(now)
    aircraft.external = {"since_s": when, "flight_id": upcoming["flight_id"],
                         "departed": False, "violations": []}
    aircraft.instruction = {}
    aircraft.passengers = int(upcoming.get("passengers") or 0)
    aircraft.clearance, aircraft.hold = None, None
    return assignment(engine, aircraft_id)


def candidates(engine, *, asset_id=None, vertiport=None, seats=None, within_s=OFFER_WINDOW_S, now=None):
    """Flights that could be handed to a person right now.

    A flight qualifies while its aircraft is still standing: once it has rolled
    it belongs to the model that started it, and taking it over mid-taxi would
    put the pilot somewhere they never agreed to be. Late flights stay on the
    list -- being overdue is the most likely reason to want one.
    """
    when = engine.time_s if now is None else float(now)
    answer = []
    for aircraft in engine.aircraft.values():
        if aircraft.external or aircraft.failed or aircraft.finished:
            continue
        if aircraft.phase != "parked" or aircraft.flight is not None:
            continue
        flight = _flight_of(engine, aircraft)
        if flight is None:
            continue
        if asset_id and aircraft.asset_id != asset_id:
            continue
        # The plan is made before any aircraft exists, so what an operator can
        # ask for there is a cabin size, not an asset nobody has assigned yet.
        if seats and int(aircraft.seats) != int(seats):
            continue
        if vertiport and flight["origin"] != vertiport:
            continue
        off_block = float(flight.get("off_block_s", 0.0))
        if off_block - when > float(within_s):
            continue
        answer.append({
            "flight_id": flight["flight_id"], "aircraft_id": aircraft.aircraft_id,
            "asset_id": aircraft.asset_id, "type_id": aircraft.type_id, "label": aircraft.label,
            "seats": aircraft.seats, "passengers": flight.get("passengers", 0),
            "origin": flight["origin"], "destination": flight["destination"],
            "stand": aircraft.stand, "off_block_s": off_block,
            "due_in_s": off_block - when,
            "ready": off_block <= when and aircraft.ready_s <= when,
        })
    answer.sort(key=lambda row: row["off_block_s"])
    return answer


def models(engine, *, vertiport=None, within_s=OFFER_WINDOW_S, now=None):
    """Which airframes have a flight to offer, so the picker can only offer those."""
    counts = {}
    for row in candidates(engine, vertiport=vertiport, within_s=within_s, now=now):
        entry = counts.setdefault(row["asset_id"], {"asset_id": row["asset_id"], "label": row["label"],
                                                    "seats": row["seats"], "flights": 0, "vertiports": set()})
        entry["flights"] += 1
        entry["vertiports"].add(row["origin"])
    return [{**entry, "vertiports": sorted(entry["vertiports"])} for entry in
            sorted(counts.values(), key=lambda entry: (-entry["flights"], entry["asset_id"]))]


def hand_over(engine, aircraft_id, *, now=None):
    """Give one airframe to an outside pilot, and answer what they have taken on."""
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None:
        raise ValueError(f"{aircraft_id}: 시나리오에 없는 기체입니다")
    if aircraft.external:
        raise ValueError(f"{aircraft_id}: 이미 수동 조종 중입니다")
    if aircraft.failed:
        raise ValueError(f"{aircraft_id}: 고장 처리된 기체입니다")
    if aircraft.finished:
        raise ValueError(f"{aircraft_id}: 오늘 남은 비행이 없습니다")
    if aircraft.phase != "parked" or aircraft.flight is not None:
        raise ValueError(f"{aircraft_id}: 이미 출발한 기체는 넘겨받을 수 없습니다")
    flight = _flight_of(engine, aircraft)
    if flight is None:
        raise ValueError(f"{aircraft_id}: 배정할 비행편이 없습니다")
    when = engine.time_s if now is None else float(now)
    aircraft.external = {"since_s": when, "flight_id": flight["flight_id"],
                         "departed": False, "violations": []}
    # Before the day starts, reserve the person's first arrival opportunity
    # before any automatic flight can consume it. This is not taxi permission.
    if not any(a.flight or a.next_flight or a.completed for a in engine.aircraft.values()):
        start=max(when,flight.get('off_block_s',when),aircraft.ready_s)
        aircraft.external['initial_priority_from_s']=start
        aircraft.external['initial_priority_until_s']=start+INITIAL_DEPARTURE_PRIORITY_S
        prepare_initial_departure(engine,aircraft,when)
    return assignment(engine, aircraft_id)


def prepare_initial_departure(engine, aircraft, now):
    ext=aircraft.external
    if ext and 'initial_priority_until_s' in ext and now>=ext['initial_priority_until_s']:
        ext.pop('initial_priority_until_s')
        if not ext.get('departure_pending') and not ext.get('departed'):
            engine._entry_forecasts.pop(ext['flight_id'],None)
            engine._assigned_plans.pop(ext['flight_id'],None)
    if (not ext or ext.get('departed') or now>=ext.get('initial_priority_until_s',-1)
            or now<ext.get('initial_prepare_s',-1)):
        return
    ext['initial_prepare_s']=now+1.
    flight=_flight_of(engine,aircraft)
    if not flight or flight['flight_id'] in engine._entry_forecasts:
        return
    when=max(now,ext['initial_priority_from_s'])
    try:
        selected,route=engine._select_fatos(dict(flight,departure_stand=aircraft.stand),when)
        engine._assigned_plans[flight['flight_id']]=(selected,route)
        engine._meter_arrival_entry(aircraft,selected,route,when)
    except ValueError as problem:
        aircraft.instruction={'action':'departure_wait','reason':str(problem)}


def initial_departure_owner(engine, origin, now, *, destination=None, arrival_fato=None):
    """A bounded opening opportunity, never an override of occupied resources."""
    for a in engine.aircraft.values():
        ext=a.external
        if (ext and not ext.get('departed') and not a.failed
                and ext.get('initial_priority_from_s',float('inf'))<=now
                and now<ext.get('initial_priority_until_s',-1)):
            flight=_flight_of(engine,a)
            if flight and (flight['origin']==origin or
                    (flight['destination']==destination and flight.get('arrival_fato')==arrival_fato
                     and flight['flight_id'] not in engine._entry_forecasts)):
                return a.aircraft_id
    return None


def release(engine, aircraft_id):
    """Hand it back. What the person did to it stands: the day does not rewind."""
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return False
    aircraft.external = None
    return True


def assignment(engine, aircraft_id):
    """What this pilot has been given: the aircraft, the flight and where it goes."""
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return None
    flight = _flight_of(engine, aircraft)
    return {
        "aircraft_id": aircraft.aircraft_id, "asset_id": aircraft.asset_id,
        "type_id": aircraft.type_id, "label": aircraft.label, "seats": aircraft.seats,
        "stand": aircraft.stand, "vertiport": aircraft.vertiport,
        # Where it is standing, so the page can resolve the deck height under it
        # and work out which decks it could touch before the socket opens.
        "latitude": aircraft.latitude, "longitude": aircraft.longitude,
        "altitude_m": aircraft.altitude,
        "since_s": aircraft.external["since_s"], "departed": aircraft.external["departed"],
        "flight": None if flight is None else {
            "flight_id": flight["flight_id"], "origin": flight["origin"],
            "destination": flight["destination"], "off_block_s": flight.get("off_block_s"),
            "departure_fato": flight.get("departure_fato"), "arrival_fato": flight.get("arrival_fato"),
            "arrival_stand": flight.get("arrival_stand"), "passengers": flight.get("passengers", 0)},
        "violations": list(aircraft.external["violations"]),
    }


def place(engine, aircraft_id, *, latitude, longitude, altitude, heading=None,
          step=None, airborne=None, speed_mps=None, telemetry=None):
    """Where the pilot has actually put it, which is now where everyone sees it.

    The phase moves with the wheels, because that is what the rest of the day
    reads to decide whether this aircraft is in the air: pad occupancy, approach
    separation and the ground checks all ask `airborne`, never the route.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return False
    for value in (latitude, longitude, altitude):
        if value is None or value != value:      # NaN never reaches the fleet
            return False
    # Copy only finite measured channels; a human-controlled aircraft has no
    # automatic pilot left to refresh its attitude or velocity for prediction.
    for key, value in (telemetry or {}).items():
        if key in ('pitch_deg', 'roll_deg', 'tilt_deg', 'rotor_radps'):
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                aircraft.telemetry[key] = float(value)
        elif key in ('control_surface_deg', 'velocity_ned_mps'):
            size = 3 if key == 'velocity_ned_mps' else 4
            if isinstance(value, (list, tuple)) and len(value) == size and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
                aircraft.telemetry[key] = tuple(value)
    was_airborne = aircraft.airborne
    aircraft.place(float(latitude), float(longitude), float(altitude), heading, step)
    if speed_mps is not None and speed_mps == speed_mps:
        aircraft.speed_mps = max(0.0, float(speed_mps))
    if airborne is not None:
        aircraft.phase = PHASE_MANUAL if airborne else (
            PHASE_MANUAL_GROUND if aircraft.external["departed"] and not aircraft.external.get("completed") else "parked")
    manual_procedure.observe(engine, aircraft, _flight_of(engine,aircraft), was_airborne, engine.time_s)
    aircraft.remember(engine.time_s)
    return True


# ---------------------------------------------------------------------------
# Asking the service, as a person rather than as a model
# ---------------------------------------------------------------------------
def _pad_of(engine, flight, route=None):
    fato = (route.departure.get("fato") if route else None) or flight.get("departure_fato")
    return flight["origin"], fato


def request_departure(engine, aircraft_id, *, now=None):
    """Submit one persistent request; repeated clicks retain the same place."""
    answer = _request_departure(engine, aircraft_id, now=now)
    aircraft = engine.aircraft[aircraft_id]
    when = engine.time_s if now is None else float(now)
    if answer['state'] == 'hold':
        aircraft.external.setdefault('departure_requested_s', when)
        aircraft.external['departure_pending'] = True
    else:
        aircraft.external.pop('departure_pending', None)
    return answer


def advance_request(engine, aircraft, now):
    """Service a submitted request, without issuing pilot input or moving pose."""
    ext = aircraft.external
    prepare_initial_departure(engine,aircraft,now)
    if not ext or not ext.get('departure_pending') or ext.get('departed'):
        return
    if now < ext.get('departure_check_s', -float('inf')):
        return
    ext['departure_check_s'] = now + 1.
    flight = _flight_of(engine, aircraft)
    if flight is None:
        ext.pop('departure_pending', None)
        return
    if not manual_procedure.fresh(aircraft):
        answer = {'state':'hold','reason':'출발 요청 유지 · 기체 위치 수신 대기'}
    else:
        try:
            answer = request_departure(engine, aircraft.aircraft_id, now=now)
        except ValueError as problem:
            ext.pop('departure_pending', None)
            answer = {'state':'refused','reason':str(problem)}
    last = ext.get('last_answer') or {}
    # Automatic decisions are PSU responses, never fabricated pilot requests.
    changed = any(answer.get(k) != last.get(k) for k in ('state','reason','blocked_by'))
    manual_procedure.response(engine, aircraft, _flight_of(engine, aircraft),
                              'departure', answer, now, record=changed)


def _request_departure(engine, aircraft_id, *, now=None):
    """The pilot asks to leave. The same gates the model passes through.

    The answer is never a refusal to move -- the service sequences, it does not
    control. It is a slot, or a reason and who to wait for.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        raise ValueError("수동 조종 중인 기체가 아닙니다")
    if aircraft.external["departed"]:
        return {"state": "granted", "reason": "이미 출발 허가를 사용했습니다"}
    when = engine.time_s if now is None else float(now)
    flight = _flight_of(engine, aircraft)
    if flight is None:
        raise ValueError("배정된 비행편이 없습니다")
    ready_s = manual_procedure.earliest_departure(engine,aircraft,flight)
    if when < ready_s:
        return {"state":"hold","reason":"계획 출발·회항 준비·도착 진입 순서 시각 대기",
                "ready_s":ready_s,"wait_s":ready_s-when}
    if aircraft.vertiport != flight["origin"]:
        return {"state": "refused", "reason": "기체의 현재 버티포트와 출발지가 다릅니다"}
    try:
        prepared, route = engine._select_fatos(dict(flight, departure_stand=aircraft.stand), when)
    except ValueError as problem:
        return {"state": "refused", "reason": str(problem)}
    pad = _pad_of(engine, prepared, route)
    if engine.pilots and not engine._meter_arrival_entry(aircraft,prepared,route,when):
        return {"state":"hold","reason":aircraft.instruction.get("reason","도착 진입 순서 대기"),
                "ready_s":aircraft.instruction.get('ready_s')}
    blockers = engine._departure_blockers(prepared, route)
    if blockers:
        owners = sorted({engine.flights.get(b['flight_id'], {}).get('aircraft_id', b['flight_id'])
                         for b in blockers})
        return {"state": "hold", "reason": f"{pad[0]} {pad[1]} 출발 경로 확보 대기 · 선행 기체 {', '.join(owners)}",
                "vertiport": pad[0], "fato": pad[1], "blocked_by": owners}
    taxi_s = route.phases[0].duration_s if route.phases and route.phases[0].stage == "gate_out" else 0.0
    permit = engine.psu.request_departure(flight_id=prepared["flight_id"], vertiport=pad[0],
                                          fato=pad[1], earliest_s=when + taxi_s, now_s=when)
    earliest = engine.psu.pad(*pad).earliest(when + taxi_s, psu_sequencing.DEPARTURE,
                                             engine.psu.tuning.departure_separation_s,
                                             exclude=prepared["flight_id"])
    slot_s = max(permit.cleared_s, earliest)
    if when + taxi_s < slot_s:
        return {"state": "hold", "reason": "공용 패드 운항 간격", "vertiport": pad[0], "fato": pad[1],
                "cleared_s": slot_s, "wait_s": slot_s - (when + taxi_s)}
    # Granted: the flight becomes this aircraft's, exactly as a model start
    # would make it, and the pad is taken. From here the person is flying it.
    engine._terminal.acquire(prepared, route, "departure")
    engine._active_pads[pad] = prepared["flight_id"]
    engine._assigned_plans.pop(prepared["flight_id"], None)
    aircraft.flight, aircraft.route = prepared, route
    aircraft.index, aircraft.elapsed = 0, 0.0
    aircraft.clearance, aircraft.hold = None, None
    aircraft.instruction = {}
    aircraft.passengers = prepared.get("passengers", 0)
    aircraft.trail, aircraft.trail_flight = [], prepared["flight_id"]
    aircraft.unloading, aircraft.departed_s = None, None
    aircraft.phase = PHASE_MANUAL_GROUND
    aircraft.next_flight += 1
    aircraft.external["departed"] = True
    aircraft.remember(when)
    engine._record(when, "taxi_requested", prepared, direct=route.direct)
    return {"state": "granted", "vertiport": pad[0], "fato": pad[1],
            "cleared_s": permit.cleared_s, "reason": "지상 이동 허가 · 배정 FATO 정차 후 이륙 허가를 요청하세요"}


def request_arrival(engine, aircraft_id, *, eta_s=None, now=None):
    """The pilot asks for a landing number. `eta_s` is their own estimate."""
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        raise ValueError("수동 조종 중인 기체가 아닙니다")
    flight = aircraft.flight
    if flight is None:
        return {"state": "refused", "reason": "출발 허가를 먼저 받으세요"}
    when = engine.time_s if now is None else float(now)
    earliest = when + (120.0 if eta_s is None else max(0.0, float(eta_s)))
    clearance = engine.psu.request_arrival(
        flight_id=flight["flight_id"], vertiport=flight["destination"],
        fato=flight.get("arrival_fato"), stand=flight.get("arrival_stand"),
        earliest_s=earliest, now_s=when)
    aircraft.clearance = clearance
    return {"state": "holding" if clearance.holding else "granted", **clearance.as_dict()}


def request_hold(engine, aircraft_id, *, now=None):
    """The pilot says they cannot continue and asks the service where to wait.

    This asks the sequencer the same question a held approach asks: given where
    everyone else is, is there room now? The answer is either "no, and here is
    your place in the queue" or "yes, keep coming" -- both are useful, and both
    are the service's own answer rather than this module's opinion.

    The answer now names a place as well as a number. It used to say only that
    no bay had been assigned, on the grounds that bays are placed along a walked
    route and a hand-flown aircraft has none -- but the bays are laid out around
    the arrival's approach entry, which this aircraft has in its own plan. What
    it still does not do is fly anyone there: the bay is reserved and reported,
    and the pilot takes it.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        raise ValueError("수동 조종 중인 기체가 아닙니다")
    if not aircraft.external['departed'] and aircraft.external.get('departure_pending'):
        flight = _flight_of(engine, aircraft)
        aircraft.external.pop('departure_pending', None)
        aircraft.external.pop('departure_requested_s', None)
        aircraft.external.pop('initial_priority_until_s', None)
        if flight:
            engine._entry_forecasts.pop(flight['flight_id'], None)
            engine._assigned_plans.pop(flight['flight_id'], None)
            engine.psu.forget(flight['flight_id'])
        aircraft.instruction = {}
        return {'state':'accepted','reason':'출발 요청 취소 · GATE 대기 유지'}
    flight = aircraft.flight
    if flight is None:
        return {"state": "refused", "reason": "출발 허가를 먼저 받으세요"}
    when = engine.time_s if now is None else float(now)
    held = engine.psu.clearance(flight["flight_id"], psu_sequencing.ARRIVAL)
    # Asking from where they are now: a pilot who cannot continue is not the
    # pilot who gave an optimistic estimate a few minutes ago.
    clearance = engine.psu.request_arrival(
        flight_id=flight["flight_id"], vertiport=flight["destination"],
        fato=flight.get("arrival_fato"), stand=flight.get("arrival_stand"),
        earliest_s=when, now_s=when)
    aircraft.clearance = clearance
    assigned = _ensure_bay(engine, aircraft, clearance, when)
    if clearance.holding:
        # The clearance is spread first: what it says about the queue is its own
        # to say, and putting it last overwrote everything set here -- which is
        # why the bay line never reached a pilot even before there was a bay.
        queue = clearance.as_dict().get("reason") or ""
        return {**clearance.as_dict(), "state": "holding",
                "reason": f"지정 대기점 배정 · {queue}".rstrip(" ·") if assigned
                          else (queue or "대기 순번 유지 · 배정 가능한 대기점 없음"),
                "hold": dict(aircraft.hold) if aircraft.hold else None}
    return {"state": "granted", "reason": "대기 불필요 · 접근을 계속하세요",
            "was_holding": bool(held and held.holding), **clearance.as_dict()}


def _ensure_bay(engine, aircraft, clearance, when):
    """A place to wait, given as soon as the pilot is told to wait.

    An automatic arrival is sent to its bay without asking; a pilot used to have
    to ask, and was then told no bay existed. Being held is the moment the place
    is needed, so it is issued then -- and reserved, so the service does not
    send anyone else to the same spot while this one flies to it.
    """
    if clearance is None or not clearance.holding or not aircraft.airborne:
        return clearance.holding_assignment if clearance is not None else None
    if clearance.holding_assignment is None:
        engine.reserve_manual_bay(aircraft, when)
    return clearance.holding_assignment


def advisory(engine, aircraft_id, *, now=None):
    """Everything the service is currently saying to this pilot.

    One place, because a cockpit reads one thing: the clearance it holds, the
    instruction it is under, and what is in its way.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return None
    when = engine.time_s if now is None else float(now)
    flight = _flight_of(engine, aircraft)
    identifier = None if flight is None else flight["flight_id"]
    departure = engine.psu.clearance(identifier, psu_sequencing.DEPARTURE) if identifier else None
    arrival = engine.psu.clearance(identifier, psu_sequencing.ARRIVAL) if identifier else None
    if arrival is not None and arrival.stand is None and not aircraft.external.get("completed"):
        engine.psu.reconsider_arrival(identifier,when)
    if arrival is not None and not aircraft.external.get("completed"):
        _ensure_bay(engine, aircraft, arrival, when)
    upcoming = next_flight(engine, aircraft, now=when)
    return {
        "time_s": when,
        "procedure": manual_procedure.guidance(engine,aircraft,flight,when) if flight else None,
        "flight_id": identifier,
        "departed": aircraft.external["departed"],
        "completed": bool(aircraft.external.get("completed")),
        "airborne": aircraft.airborne,
        "instruction": dict(aircraft.instruction or {}),
        "departure": None if departure is None else departure.as_dict(),
        "arrival": None if arrival is None else arrival.as_dict(),
        "hold": None if aircraft.hold is None else dict(aircraft.hold),
        "violations": list(aircraft.external["violations"]),
        "next_flight": upcoming,
        "remaining_flights": max(0, len(aircraft.flights)-aircraft.next_flight),
    }


def note_violation(engine, aircraft_id, kind, reason, *, now=None):
    """Write down what the pilot did anyway.

    Nothing is prevented. The service has no authority to stop an aircraft and
    pretending otherwise would teach the wrong thing; what it can do is be
    unambiguous that this happened, and leave it in the day's record.
    """
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return None
    when = engine.time_s if now is None else float(now)
    flight = _flight_of(engine, aircraft)
    entry = {"kind": kind, "reason": reason, "time_s": when,
             "flight_id": None if flight is None else flight["flight_id"]}
    already = [v for v in aircraft.external["violations"] if v["kind"] == kind]
    # One of a kind per flight: a pilot flying through a hold does it for
    # minutes, and a log line per frame is not a record, it is noise.
    if already and already[-1].get("flight_id") == entry["flight_id"]:
        already[-1]["time_s"] = when
        return already[-1]
    aircraft.external["violations"].append(entry)
    # Through the day's own recorder, so it carries the same fields as every
    # other event and reaches the same places.
    if flight is not None:
        engine._record(when, "manual_violation", flight, violation=kind, detail=reason)
    return entry


def check(engine, aircraft_id, *, now=None):
    """What the pilot is doing that the service did not clear, if anything."""
    aircraft = engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:
        return []
    found = []
    if aircraft.airborne and not aircraft.external["departed"]:
        found.append(note_violation(engine, aircraft_id, "departure_unauthorised",
                                    "출발 허가 없이 이륙했습니다", now=now))
    if aircraft.airborne and aircraft.external["departed"] and aircraft.external.get('takeoff_cleared_s') is None:
        found.append(note_violation(engine, aircraft_id, "takeoff_unauthorised",
                                    "지상 이동 허가만으로 이륙했습니다. 이륙 허가가 별도로 필요합니다", now=now))
    clearance = aircraft.clearance
    if (aircraft.airborne and clearance is not None and clearance.holding
            and clearance.released_s is None and aircraft.flight
            and (point := manual_procedure.pad_point(engine,aircraft.flight,"arrival"))
            and manual_procedure.distance(aircraft,point) < 50 and aircraft.altitude < point[2]+30):
        found.append(note_violation(engine, aircraft_id, "hold_ignored",
                                    "대기 지시 중 접근을 계속하고 있습니다", now=now))
    return [entry for entry in found if entry]


def _pilot_psu_message(aircraft, flight, kind, now, detail):
    ext=aircraft.external
    sequence=detail.get('sequence')
    if sequence is None:
        sequence=int(ext.get('pilot_message_sequence',0))+1
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
        raise ValueError('조종사 메시지 순서는 양의 정수여야 합니다')
    message_id=str(detail.get('message_id') or new_message_id('pilot'))
    pilot_id=str(ext.get('pilot_id') or f"pilot:{aircraft.aircraft_id}")
    common=dict(message_id=message_id,flight_id=flight['flight_id'],aircraft_id=aircraft.aircraft_id,
                pilot_id=pilot_id,psu_id='psu:scenario',kind=kind,issued_at_s=now,sequence=sequence)
    if kind in PILOT_REPORT_KINDS:
        message=PilotPsuReport(**common,reference_message_id=detail.get('reference_message_id'),
                               reason=str(detail.get('reason') or ''))
    else:
        message=PilotPsuRequest(**common,eta_s=detail.get('eta_s'))
    ext['pilot_message_sequence']=max(int(ext.get('pilot_message_sequence',0)),sequence)
    return message


def request(engine, aircraft_id, kind, **detail):
    if kind not in {'departure','arrival','hold','takeoff','approach','landing','report_airborne','report_landed','report_gate'}:
        raise ValueError(f'{kind}: 알 수 없는 요청입니다')
    aircraft=engine.aircraft.get(aircraft_id)
    if aircraft is None or not aircraft.external:raise ValueError("수동 배정된 기체가 아닙니다")
    flight=_flight_of(engine,aircraft)
    if flight is None:raise ValueError("배정 비행편이 없습니다")
    when=engine.time_s
    supplied_id=detail.get('message_id')
    cache=aircraft.external.setdefault('pilot_message_results',{})
    fingerprints=aircraft.external.setdefault('pilot_message_inputs',{})
    fingerprint=(kind,detail.get('sequence'),detail.get('eta_s'),
                 detail.get('reference_message_id'),str(detail.get('reason') or ''))
    if supplied_id and supplied_id in cache:
        if fingerprints.get(supplied_id)!=fingerprint:
            raise ValueError('같은 메시지 ID를 다른 내용에 다시 사용할 수 없습니다')
        return dict(cache[supplied_id])
    supplied_sequence=detail.get('sequence')
    if supplied_sequence is not None:
        if (isinstance(supplied_sequence, bool)
                or not isinstance(supplied_sequence, int) or supplied_sequence <= 0):
            raise ValueError('조종사 메시지 순서는 양의 정수여야 합니다')
        if supplied_sequence<=int(aircraft.external.get('pilot_message_sequence',0)):
            raise ValueError('이미 처리했거나 순서가 지난 조종사 메시지입니다')
    pilot_message=_pilot_psu_message(aircraft,flight,kind,when,detail)
    if aircraft.external.get('completed'):
        answer={'state':'accepted','reason':'운항 보고가 완료되었습니다'}
    elif kind=='departure':answer=request_departure(engine,aircraft_id)
    elif kind=='arrival':answer=request_arrival(engine,aircraft_id,eta_s=detail.get('eta_s'))
    elif kind=='hold':
        aircraft.external.pop('landing_cleared_s',None)
        aircraft.external.pop('approach_cleared_s',None)
        if aircraft.airborne and aircraft.clearance:
            aircraft.clearance.approach_started_s=None
            engine._terminal.release(flight['flight_id'],'arrival')
            for pad,owner in list(engine._active_pads.items()):
                if pad[0]==flight['destination'] and owner==flight['flight_id']:
                    engine._active_pads.pop(pad)
        answer=request_hold(engine,aircraft_id)
    else:answer=manual_procedure.act(engine,aircraft,flight,kind,when)
    result=manual_procedure.exchange(engine,aircraft,flight,kind,answer,when,pilot_message)
    if supplied_id:
        cache[supplied_id]=dict(result)
        fingerprints[supplied_id]=fingerprint
        while len(cache)>64:
            expired=next(iter(cache));cache.pop(expired);fingerprints.pop(expired,None)
    return result
