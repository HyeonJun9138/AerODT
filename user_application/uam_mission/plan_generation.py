"""User/Application: turning the multi-flight setup into a day of flights.

The operator fills in five steps — which decks, how much demand between them,
when the day runs, which seed, what stands on the decks — and presses one
button. This is what happens next.

It is assembly, not arithmetic. The pieces all live in the Model Library and
each answers one question:

* `demand_profile` — when in the day the demand happens and who wants to go
  where, from the reference curve and the shares the operator set.
* `flight_plan.build_plan` — how long one leg takes, over the route network the
  operator drew and at the speeds the pilot set. **The plan that is scheduled is
  the plan that will be flown**: the rehearsal engine builds the same route the
  same way, so the times in the file are not an estimate of something else.
* `flight_scheduler` — which aircraft carries which load, and when.

What this adds is the joining: the route timings are worked out once per ordered
pair and reused, because a day of two thousand flights over three hundred pairs
must not build three hundred plans two thousand times.

It runs on a thread and reports how far along it is, because a day takes long
enough that a screen with nothing on it would look broken. One day is built at a
time: the twin flies one day, so there is nothing to be gained by building two.

Deliberately not done here: nothing is optimised, and no altitude is chosen. Where
a flight goes and how high is the route network's answer, and the pilot flies it.
"""
import math
import random
import re
import inspect
import threading
import time

from digital_twin.model_library import demand_profile, flight_plan, flight_scheduler, schedule_planning

SCHEMA_VERSION = 1

# What the bar has reached by the end of each phase. Building the routes is the
# long one — it is the only part that grows with the size of the network — so it
# owns most of the bar and the rest of the run does not crawl through the last
# few per cent.
PHASES = (
    ("demand", "수요를 만드는 중입니다", 6),
    ("routes", "항로를 계산하는 중입니다", 70),
    ("dispatch", "기체를 배정하는 중입니다", 94),
    ("file", "비행계획을 정리하는 중입니다", 100),
)
PHASE_END = {name: end for name, _label, end in PHASES}
PHASE_LABEL = {name: label for name, label, _end in PHASES}
# Every step a run goes through, in order, including the ones after the file
# is written - setting the day out on the decks, rehearsing each aircraft's
# first leg, handing the day to the twin. The status names them all so a screen
# can show the whole process, what has been done, what is being done now and
# how long each part took, rather than one bar and one sentence.
STAGES = (
    ("demand", "수요 생성"), ("routes", "항로 계산"), ("dispatch", "기체 배정"), ("file", "계획 정리"),
    ("initialize", "시뮬레이션 초기화"), ("forecast", "기체 예측 준비"), ("publish", "시뮬레이션 적용"),
)
STAGE_LABEL = dict(STAGES)
_COUNT = re.compile(r"(\d+)\s*/\s*(\d+)")
SEAT_CLASS_SEATS = {"seat2": 2, "seat4": 4, "seat6": 6, "seat8": 8}


class GenerationError(ValueError):
    """A request that cannot be built, naming the field that stopped it."""

    def __init__(self, message, field=""):
        super().__init__(message)
        self.field = field


def _clock_minutes(text, field):
    parts = str(text or "").strip().split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise GenerationError("운영 시각은 HH:MM 형식이어야 합니다", field)
    hours, minutes = int(parts[0]), int(parts[1])
    if hours > 23 or minutes > 59:
        raise GenerationError("운영 시각 범위를 벗어났습니다", field)
    return hours * 60 + minutes


def _fleet_rows(request, stands):
    """The request's per-deck aircraft counts as individual aircraft on stands.

    A deck says how many of each cabin size stand on it; this gives each one a
    number and a stand, in the order the stands are listed, so the same request
    always puts the same aircraft in the same place.
    """
    rows, index = [], 0
    for record in request.get("fleet") or ():
        deck = str(record.get("vertiport") or "")
        free = list(stands.get(deck) or ())
        mix = record.get("aircraft_by_class") or {}
        wanted = []
        for name in sorted(mix, key=lambda key: SEAT_CLASS_SEATS.get(key, 0)):
            seats = SEAT_CLASS_SEATS.get(name)
            if not seats:
                continue
            wanted.extend([seats] * max(0, int(mix.get(name) or 0)))
        for seats in wanted:
            if not free:
                break  # A deck cannot hold more aircraft than it has stands.
            index += 1
            rows.append({"aircraft_id": f"UAM{index:04d}", "vertiport": deck,
                         "stand": free.pop(0), "seats": seats})
    return rows


def validate_request(raw):
    """The request as the generator needs it, or `GenerationError` naming why not."""
    if not isinstance(raw, dict):
        raise GenerationError("요청 본문이 올바르지 않습니다", "request")
    scope = [str(item) for item in (raw.get("vertiports") or [])]
    if len(scope) < 2:
        raise GenerationError("버티포트를 2곳 이상 선택하세요", "vertiports")
    pairs = [{"from": str(pair.get("from")), "to": str(pair.get("to"))}
             for pair in (raw.get("pairs") or []) if isinstance(pair, dict)]
    if not pairs:
        raise GenerationError("연결된 버티포트 쌍이 없습니다", "pairs")
    demand = raw.get("demand") if isinstance(raw.get("demand"), dict) else {}
    trips = int(demand.get("daily_trips") or 0)
    if trips <= 0:
        raise GenerationError("하루 수요가 0입니다", "demand.daily_trips")
    distribution = (demand.get("distribution") or {}).get("vertiports") or []
    weights = [{"vertiport": str(row.get("vertiport")),
                "departure_share": float(row.get("departure_share") or 0.0),
                "arrival_share": float(row.get("arrival_share") or 0.0)}
               for row in distribution if isinstance(row, dict)]
    if not weights:
        raise GenerationError("수요 분배 비율이 없습니다", "demand.distribution")
    operating = raw.get("operating") if isinstance(raw.get("operating"), dict) else {}
    start = _clock_minutes(operating.get("start"), "operating.start")
    end = _clock_minutes(operating.get("end"), "operating.end")
    if start == end:
        raise GenerationError("운영 시작과 종료 시각이 같습니다", "operating.end")
    seed = raw.get("seed") if isinstance(raw.get("seed"), dict) else {}
    value = seed.get("value")
    if str(seed.get("mode")) == "fixed":
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise GenerationError("시드는 1 이상의 정수여야 합니다", "seed.value")
        drawn = int(value)
    else:
        drawn = random.SystemRandom().randint(1, 2 ** 31 - 1)
    fleet = [row for row in (raw.get("fleet") or []) if isinstance(row, dict)]
    if not fleet:
        raise GenerationError("배치된 기체가 없습니다", "fleet")
    try:
        planning = schedule_planning.validate(raw.get("planning"))
    except ValueError as error:
        raise GenerationError(str(error), "planning") from error
    manual = raw.get("manual") or {}
    if not isinstance(manual, dict):
        raise GenerationError("수동 배정 조건이 올바르지 않습니다", "manual")
    preference = None
    if manual.get("want") is True:
        seats = manual.get("seats")
        if seats not in (None, "", 4, 6, 8, "4", "6", "8") or isinstance(seats, bool):
            raise GenerationError("수동 기체는 4·6·8인승을 선택하세요", "manual.seats")
        origin = manual.get("vertiport") or None
        if origin is not None and origin not in scope:
            raise GenerationError("수동 출발지를 선택한 범위에 포함하세요", "manual.vertiport")
        preference = {"seats": int(seats) if seats else None, "vertiport": origin}
    return {"vertiports": scope, "pairs": pairs, "daily_trips": trips, "weights": weights,
            "start_minutes": start, "end_minutes": end, "seed": drawn, "fleet": fleet,
            "scenario_date": str(raw.get("scenario_date") or ""), "planning": planning,
            "manual_preference": preference}


def _first_fato(layout, role, network=None, vertiport_id=None):
    """The pad a flight of this deck uses for `role`: the first one the network
    joins in that direction, else the first that takes the role at all. A
    shared pad the drawing only ever leaves from is not where a day lands."""
    connected = flight_plan.linked_fatos(network, vertiport_id, role) if network and vertiport_id else None
    pad = flight_plan._fato_for(layout or {}, role, connected=connected)
    return str(pad) if pad else None


def _first_gate(layout):
    gates = (layout or {}).get("gates") or ()
    return str(gates[0]["id"]) if gates else None


def _fato_options(layout, role, network, vertiport_id):
    connected = flight_plan.linked_fatos(network, vertiport_id, role)
    allowed = {"both", role}
    return [str(item["id"]) for item in (layout or {}).get("fatos") or ()
            if str(item.get("role") or "both").lower() in allowed and str(item.get("id")) in connected]


def _leg_seconds(plan, planning=None):
    """One built plan as the seconds the scheduler needs.

    The air is everything between the lift and the touchdown, whatever the route
    was split into; the turnaround is the stand phase the plan ends with.
    """
    by_stage = {}
    for leg in plan.get("legs") or ():
        by_stage.setdefault(leg["stage"], 0.0)
        by_stage[leg["stage"]] += float(leg.get("duration_s") or 0.0)
    air = sum(value for stage, value in by_stage.items()
              if stage in ("climb", "cruise", "descent"))
    raw = {"gate_out_s": by_stage.get("gate_out", 0.0), "takeoff_s": by_stage.get("takeoff", 0.0),
           "climb_s": by_stage.get("climb", 0.0), "cruise_s": by_stage.get("cruise", 0.0),
           "descent_s": by_stage.get("descent", 0.0), "air_s": air,
           "landing_s": by_stage.get("landing", 0.0), "gate_in_s": by_stage.get("gate_in", 0.0),
           "turnaround_s": by_stage.get("charge", 0.0)}
    return schedule_planning.apply_phase_floors(raw, planning)


def build_timings(pairs, records, network, profile, *, on_step=None, all_options=False,
                  planning=None):
    """One flight plan per ordered pair, as the seconds each leg takes.

    Built once and reused: the route between two decks does not change because a
    different aircraft flies it. The stands are each deck's first, so a flight
    from another stand taxis for the same time — a deck is tens of metres across
    and the difference is seconds.

    Returns `(timings, notes, blocked_pairs)`. Disconnected pairs are not
    dispatched: a missing corridor must never become an invented straight line.
    """
    index = {str(record["id"]): record for record in records}
    ordered = []
    for pair in pairs:
        for origin, destination in ((pair["from"], pair["to"]), (pair["to"], pair["from"])):
            if origin != destination:
                ordered.append((origin, destination))
    ordered = sorted(set(ordered))
    timings, notes, blocked = {}, [], set()
    for step, (origin, destination) in enumerate(ordered, start=1):
        if on_step:
            on_step(step, len(ordered))
        start_record, end_record = index.get(origin), index.get(destination)
        if start_record is None or end_record is None:
            notes.append(f"{origin} → {destination}: 버티포트를 찾지 못했습니다")
            blocked.add((origin, destination))
            continue
        from_fatos = _fato_options(start_record.get("layout"), "takeoff", network, origin)
        to_fatos = _fato_options(end_record.get("layout"), "landing", network, destination)
        from_gate = _first_gate(start_record.get("layout"))
        to_gate = _first_gate(end_record.get("layout"))
        if not (from_fatos and to_fatos and from_gate and to_gate):
            notes.append(f"{origin} → {destination}: 주기장 또는 FATO가 없습니다")
            blocked.add((origin, destination))
            continue
        options, errors = [], []
        fato_pairs = ((from_fato, to_fato) for from_fato in from_fatos for to_fato in to_fatos)
        for from_fato, to_fato in fato_pairs:
            request = {"from_vertiport": origin, "to_vertiport": destination,
                       "from_gate": from_gate, "to_gate": to_gate,
                       "from_fato": from_fato, "to_fato": to_fato,
                       "seat_capacity": 4, "passengers": 4,
                       "battery_start_pct": flight_plan.DEFAULT_BATTERY_START_PCT,
                       "charge_target_pct": flight_plan.DEFAULT_CHARGE_TARGET_PCT}
            try:
                plan = flight_plan.build_plan(request, records, network, profile=profile)
            except (ValueError, KeyError) as error:
                errors.append(str(error))
                continue
            legs = _leg_seconds(plan, planning)
            route = []
            for leg in plan["legs"]:
                for waypoint in leg.get("waypoints", ()):
                    if not route or route[-1] != waypoint:
                        route.append(waypoint)
            legs.update(from_fato=from_fato, to_fato=to_fato, route_path=route)
            options.append(legs)
            if not all_options:
                break
        if not options:
            detail = errors[0] if errors else "연결된 항로 없음"
            notes.append(f"{origin} → {destination}: 연결된 항로 없음 또는 계획 오류 ({detail}). 직항으로 대체하지 않습니다")
            blocked.add((origin, destination))
            continue
        timings[(origin, destination)] = options if all_options else options[0]
    return timings, notes, blocked


def generate(request, *, vertiports, network, profile=None, on_progress=None):
    """The whole run: demand, routes, dispatch, file.

    `on_progress(percent, phase, message)` is called as it goes. Returns the
    scheduler's answer with the CSV text and a summary beside it.
    """
    def say(phase, percent=None, message=None):
        if on_progress:
            on_progress(int(round(percent if percent is not None else PHASE_END[phase])),
                        phase, message or PHASE_LABEL[phase])

    say("demand", 0)
    records = [record for record in vertiports() if str(record.get("id")) in set(request["vertiports"])]
    if len(records) < 2:
        raise GenerationError("선택한 버티포트를 찾지 못했습니다", "vertiports")
    names = {str(record["id"]): str(record.get("name") or record["id"]) for record in records}
    stands = {str(record["id"]): [str(gate["id"]) for gate in (record.get("layout") or {}).get("gates") or ()]
              for record in records}
    fatos = {str(record["id"]): (record.get("layout") or {}).get("fatos") or [] for record in records}
    say("demand")

    span = PHASE_END["routes"] - PHASE_END["demand"]
    def route_step(step, total):
        say("routes", PHASE_END["demand"] + span * step / max(1, total),
            f"항로를 계산하는 중입니다 · {step}/{total}")
    timings, notes, blocked = build_timings(
        request["pairs"], records, network(), profile,
        on_step=route_step, all_options=True, planning=request["planning"])
    if not timings:
        raise GenerationError("연결된 운항 항로가 없습니다. 이륙(C), 순항(F), 착륙(G) 연결을 확인하세요. 직항으로 대체하지 않습니다", "pairs")
    allocation = demand_profile.demand_plan(
        daily_trips=request["daily_trips"], weights=request["weights"], pairs=request["pairs"],
        start_minutes=request["start_minutes"], end_minutes=request["end_minutes"],
        available_legs=timings)
    demand = allocation["rows"]
    say("routes")

    fleet = _fleet_rows(request, stands)
    if not fleet:
        raise GenerationError("배치된 기체가 없습니다", "fleet")

    def timing(origin, destination, _from_gate, _to_gate):
        options = timings.get((origin, destination))
        if options is None:
            raise ValueError("항로를 계산하지 못했습니다")
        return options

    dispatch_span = PHASE_END["dispatch"] - PHASE_END["routes"]
    def dispatch_step(done, total):
        say("dispatch", PHASE_END["routes"] + dispatch_span * done / max(1, total))
    answer = flight_scheduler.schedule(
        demand=demand, fleet=fleet, stands=stands, timing=timing,
        start_minutes=request["start_minutes"], end_minutes=request["end_minutes"],
        seed=request["seed"], names=names, fatos=fatos,
        scenario_date=request["scenario_date"], on_progress=dispatch_step,
        planning=request["planning"], manual_preference=request.get("manual_preference"))
    say("dispatch")

    say("file", PHASE_END["dispatch"] + 3)
    text = flight_scheduler.to_csv(answer)
    answer["notes"] = sorted(set(list(answer.get("notes") or []) + notes))
    in_window = int(allocation["summary"]["operating_window_demand_passengers"])
    full_day = int(request["daily_trips"])
    answer["summary"].update(
        allocation["summary"],
        full_day_demand_passengers=full_day,
        out_of_window_demand_passengers=max(0, full_day - in_window),
        operating_window_demand_pct=round(in_window / full_day * 100, 2) if full_day else 0.0,
    )
    if allocation["summary"]["network_lost_demand_passengers"]:
        answer["notes"].append(
            f"연결되지 않은 OD 수요 {allocation['summary']['disconnected_od_demand_passengers']}명 중 "
            f"{allocation['summary']['redistributed_demand_passengers']}명은 대체 항로로 분산하고 "
            f"{allocation['summary']['network_lost_demand_passengers']}명은 UAM 수요에서 이탈했습니다")
    answer["summary"]["seed"] = request["seed"]
    answer["summary"]["pairs"] = len(request["pairs"])
    answer["summary"]["vertiports"] = len(records)
    # Keep the old summary key for clients, but never silently invent a route.
    answer["summary"]["direct_pairs"] = 0
    answer["summary"]["routed_pairs"] = len(timings)
    answer["summary"]["blocked_pairs"] = len(blocked)
    answer["summary"]["planning_parameters"] = request["planning"]
    say("file")
    return {"answer": answer, "csv": text, "summary": answer["summary"], "notes": answer["notes"]}


class PlanGenerator:
    """One run at a time, on a thread, with something to show while it runs."""

    def __init__(self, *, vertiports, network, profile=None, apply=None, clock=time.monotonic):
        self._vertiports, self._network = vertiports, network
        self._profile, self._apply, self._clock = profile, apply, clock
        self._lock = threading.Lock()
        self._thread = None
        self._state = {"state": "idle", "percent": 0, "phase": "", "message": "",
                       "summary": None, "error": "", "field": "", "applied": None}

    def status(self):
        with self._lock:
            result = dict(self._state)
            if "started_at" in result:
                end = result.get("finished_at", self._clock())
                result["elapsed_s"] = max(0, end - result["started_at"])
                result["phase_elapsed_s"] = max(0, end - self._phase_started)
                durations = dict(self._phase_seconds)
                durations[result["phase"]] = durations.get(result["phase"], 0) + result["phase_elapsed_s"]
                result["phase_seconds"] = durations
                result["stages"] = self._stages(result, durations)
            return result

    def _stages(self, state, durations):
        """The whole process as a list: done, running or still to come."""
        current, finished = state.get("phase"), state.get("state") in ("done", "error")
        ids = [name for name, _label in STAGES]
        at = ids.index(current) if current in ids else (len(ids) if state.get("state") == "done" else -1)
        stages = []
        for index, (name, label) in enumerate(STAGES):
            if finished and state.get("state") == "done":
                stage_state = "done"
            elif index < at:
                stage_state = "done"
            elif index == at:
                stage_state = "error" if state.get("state") == "error" else "running"
            else:
                stage_state = "pending"
            entry = {"id": name, "label": label, "state": stage_state,
                     "seconds": round(durations.get(name, 0.0), 1) if name in durations else None}
            if stage_state == "running" and state.get("count"):
                entry["count"] = dict(state["count"])
            stages.append(entry)
        return stages

    @property
    def running(self):
        with self._lock:
            return self._state["state"] == "running"

    def start(self, raw):
        """Validate and begin. Raises `GenerationError` if the request is not one."""
        request = validate_request(raw)
        with self._lock:
            if self._state["state"] == "running":
                raise GenerationError("이미 비행계획을 생성하고 있습니다", "state")
            self._state = {"state": "running", "percent": 0, "phase": "demand",
                           "message": PHASE_LABEL["demand"], "summary": None, "error": "",
                           "field": "", "applied": None, "started_at": self._clock()}
            self._phase_started = self._state["started_at"]
            self._phase_seconds = {}
        self._thread = threading.Thread(target=self._run, args=(request,), daemon=True,
                                        name="plan-generation")
        self._thread.start()
        return self.status()

    def _set_progress(self, percent, phase, message):
        with self._lock:
            if self._state["state"] != "running":
                return
            if phase != self._state["phase"]:
                now = self._clock()
                previous = self._state["phase"]
                self._phase_seconds[previous] = self._phase_seconds.get(previous, 0) + max(0, now - self._phase_started)
                self._phase_started = now
                self._state.pop("count", None)
            # "24/306" in a message is how far along the stage is: kept as
            # numbers, so a screen can draw it rather than re-read the sentence.
            found = _COUNT.search(message or "")
            if found:
                self._state["count"] = {"done": int(found.group(1)), "total": int(found.group(2))}
            self._state.update(percent=max(self._state["percent"], min(99, percent)), phase=phase, message=message)

    def _progress(self, percent, phase, message):
        self._set_progress(percent * .7 if self._apply is not None else percent, phase, message)

    def _preparation(self, phase, completed=0, total=0):
        fraction = max(0, min(1, completed / total)) if total else 0
        if phase == "forecast":
            self._set_progress(80 + 18 * fraction, phase,
                f"기체 예측 경로를 처리하는 중입니다 · {completed}/{total}개")
        elif phase == "publish":
            self._set_progress(99, phase, "시뮬레이션에 적용하는 중입니다")
        else:
            self._set_progress(70 + 10 * fraction, "initialize", "시뮬레이션을 초기화하는 중입니다")

    def _run(self, request):
        try:
            built = generate(request, vertiports=self._vertiports, network=self._network,
                             profile=self._profile() if callable(self._profile) else self._profile,
                             on_progress=self._progress)
        except GenerationError as error:
            with self._lock:
                self._state.update(finished_at=self._clock(), state="error", error=str(error), field=error.field, percent=0)
            return
        except Exception as error:  # noqa: BLE001 - a failed run must report, never vanish
            with self._lock:
                self._state.update(finished_at=self._clock(), state="error", error=str(error) or error.__class__.__name__,
                                   field="", percent=0)
            return
        # The file exists before anybody is told the run is done, so a client
        # that reads the status and asks for it cannot miss it.
        self._csv = built["csv"]
        applied = None
        if self._apply is not None:
            try:
                self._preparation("initialize")
                with self._lock:
                    self._state["summary"] = built["summary"]
                # Opt in without retrying a callback that may already have side effects.
                try:
                    parameters = inspect.signature(self._apply).parameters.values()
                    accepts_progress = any(p.name == "on_progress" and p.kind != p.POSITIONAL_ONLY
                        or p.kind == p.VAR_KEYWORD for p in parameters)
                except (TypeError, ValueError):
                    accepts_progress = False
                kwargs = {"on_progress": self._preparation} if accepts_progress else {}
                applied = self._apply(built["csv"], built["summary"], **kwargs)
            except Exception as error:  # noqa: BLE001
                with self._lock:
                    self._state.update(finished_at=self._clock(), state="error", error=f"비행계획을 적용하지 못했습니다: {error}",
                                       field="", summary=built["summary"])
                return
        self._set_progress(99, "done", "")
        with self._lock:
            self._state.update(finished_at=self._clock(), state="done", percent=100, phase="done",
                               message="비행계획을 적용했습니다" if applied else "비행계획을 만들었습니다",
                               summary=built["summary"], applied=applied,
                               notes=built["notes"][:20])

    def csv(self):
        return getattr(self, "_csv", "")
