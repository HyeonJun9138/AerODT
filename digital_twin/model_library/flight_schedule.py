"""Model Library: a day of flights as an operator was handed it.

A schedule is not a plan. The plan says how one aircraft gets from one deck to
another — the taxi, the lift, the corridor — and `flight_plan.py` builds that.
A schedule says *which* flights a day contains: who flies, from where to where,
with how many seats and passengers, and at what clock times each part of it was
supposed to happen. It is intent that somebody else produced, so this module
reads it, checks it against the vertiports we actually have, and refuses what it
cannot stand behind rather than inventing a value to fill a hole.

The times in the file are local wall clock on the scenario's date. They are kept
as seconds from that date's midnight so that arithmetic never depends on a time
zone being installed, and the date is kept beside them so a display can say what
day it was.

Nothing here runs anything. The engine that flies the day lives in
digital_twin/simulation; this only says what the day is.
"""
import csv
import hashlib
import io
import json
import math
from digital_twin.model_library.uam_energy import energy_profile

SCHEMA_VERSION = 1

# What the file must carry. Anything else in it is kept in `extra` on the flight
# so a column somebody adds later is not silently thrown away.
REQUIRED_COLUMNS = (
    "flight_plan_id", "aircraft_id", "seat_capacity", "passenger_count",
    "origin_vertiport_id", "destination_vertiport_id",
    "departure_stand_id", "departure_fato_id", "arrival_stand_id", "arrival_fato_id",
    "off_block_time", "flight_status",
)
OPTIONAL_COLUMNS = (
    "scenario_id", "scenario_date", "aircraft_type_id", "passenger_load_factor",
    "origin_vertiport_name", "destination_vertiport_name", "demand_hour",
    "departure_handoff_time", "touchdown_time", "in_block_time", "turnaround_complete_time",
    "lift_off_time", "airborne_time_sec", "block_time_sec",
    "off_block_to_departure_handoff_sec", "departure_handoff_to_touchdown_sec",
    "touchdown_to_in_block_sec", "departure_resource_wait_sec", "arrival_resource_wait_sec",
    "route_path", "route_waypoint_count",
)
# The clock columns, in the order a flight passes through them. Every one of
# them is optional except the first: a flight that never resolved an arrival has
# no touchdown time, and that is a fact about the day, not a broken row.
TIME_COLUMNS = ("off_block_time", "lift_off_time", "departure_handoff_time",
                "touchdown_time", "in_block_time", "turnaround_complete_time")

# A flight the file already knows will not work as written. It is carried, not
# dropped: the whole point of running the day is to see what happens to it.
UNRESOLVED_STATUS = "arrival_unresolved"
READY_STATUS = "ready"

# The fleet, by how many seats it sells. The file names a type (`a2`, `a4`) but
# the number of seats is what actually distinguishes the airframes we can draw,
# so seats are the key and the type id is kept for the record.
#
# Seat classes select different visual assets, not invented display dimensions.
# The display uses the same authored flight variant as single-flight mode.
# These are representative models, not manufacturer seating/performance claims.
SEAT_CLASSES = (
    {"seats": 2, "type_id": "a2", "label": "2인승", "asset_id": "joby_s4",
     "cruise_speed_mps": 50.0, "climb_speed_mps": 32.0, "descent_speed_mps": 30.0,
     "vertical_speed_mps": 3.5, "battery_capacity_kwh": energy_profile(2)["capacity_kwh"],
     "turnaround_seconds": 480.0, "note": "소형 · 2석"},
    {"seats": 4, "type_id": "a4", "label": "4인승", "asset_id": "projectairsim_airtaxi",
     "cruise_speed_mps": 45.0, "climb_speed_mps": 30.0, "descent_speed_mps": 28.0,
     "vertical_speed_mps": 3.0, "battery_capacity_kwh": energy_profile(4)["capacity_kwh"],
     "turnaround_seconds": 600.0, "note": "기준 기체 · 4석"},
    {"seats": 6, "type_id": "a6", "label": "6인승", "asset_id": "kp2a",
     "cruise_speed_mps": 43.0, "climb_speed_mps": 28.0, "descent_speed_mps": 26.0,
     "vertical_speed_mps": 2.8, "battery_capacity_kwh": energy_profile(6)["capacity_kwh"],
     "turnaround_seconds": 720.0, "note": "중형 · 6석"},
    {"seats": 8, "type_id": "a8", "label": "8인승", "asset_id": "amvlab_evtol",
     "cruise_speed_mps": 40.0, "climb_speed_mps": 26.0, "descent_speed_mps": 24.0,
     "vertical_speed_mps": 2.5, "battery_capacity_kwh": energy_profile(8)["capacity_kwh"],
     "turnaround_seconds": 900.0, "note": "대형 · 8석"},
)
SEAT_CLASS_BY_SEATS = {item["seats"]: item for item in SEAT_CLASSES}
# Anything larger than the biggest class we draw still has to be drawn. It gets
# the biggest airframe rather than none, and the schedule says it was widened.
LARGEST_SEAT_CLASS = SEAT_CLASSES[-1]

MAX_FLIGHTS = 20000
MAX_BYTES = 32 * 1024 * 1024
DAY_SECONDS = 24 * 3600
# A step backwards bigger than this is midnight; anything smaller is a mistake
# in the file. Half a day is the only value that cannot be argued with: a
# genuine rollover is always a long way back, a typo never is.
ROLLOVER_SECONDS = DAY_SECONDS / 2


def seat_class(seats):
    """The airframe a cabin of this size flies in."""
    seats = int(seats)
    if seats in SEAT_CLASS_BY_SEATS:
        return SEAT_CLASS_BY_SEATS[seats]
    for item in SEAT_CLASSES:
        if seats <= item["seats"]:
            return item
    return LARGEST_SEAT_CLASS


def clock_seconds(text):
    """`HH:MM:SS` (or `HH:MM`) as seconds from midnight; None when it is blank.

    A blank is a real answer here — a flight whose arrival never resolved has no
    touchdown time — so it is distinguished from a malformed one, which raises.
    """
    text = (text or "").strip()
    if not text:
        return None
    parts = text.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(f"시각 형식이 올바르지 않습니다: {text!r}")
    try:
        numbers = [int(part) for part in parts]
    except ValueError:
        raise ValueError(f"시각 형식이 올바르지 않습니다: {text!r}") from None
    hours, minutes = numbers[0], numbers[1]
    seconds = numbers[2] if len(numbers) == 3 else 0
    if not (0 <= hours < 48 and 0 <= minutes < 60 and 0 <= seconds < 60):
        raise ValueError(f"시각 범위를 벗어났습니다: {text!r}")
    return hours * 3600 + minutes * 60 + seconds


def clock_text(seconds):
    """Seconds from midnight back as `HH:MM:SS`, past midnight included."""
    if seconds is None:
        return ""
    seconds = int(round(seconds))
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _number(value, default=None):
    text = (value or "").strip() if isinstance(value, str) else value
    if text is None or text == "":
        return default
    try:
        number = float(text)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _rising(row, flight_id, problems):
    """The clock times of one flight, in order, with the day's rollover applied.

    A schedule that runs past midnight writes 00:20 for twenty past midnight,
    which is *smaller* than the 23:50 it took off at, so a day is added and the
    sequence goes on rising.

    Only a *large* step backwards is a rollover. A flight whose lift-off is a
    minute before its off-block is a mistake in the file, and treating that as
    midnight would move the flight twenty-four hours and make a plausible day
    out of a typo. Below the threshold the time is held at the one before it and
    the disagreement is reported.
    """
    times, previous, day = {}, None, 0
    for column in TIME_COLUMNS:
        try:
            raw = clock_seconds(row.get(column))
        except ValueError as error:
            # Name the flight and the column: "06:6x" somewhere in 947 rows is
            # not something anybody can find from the value alone.
            raise ValueError(f"{flight_id}: {column} {error}") from None
        if raw is None:
            times[column] = None
            continue
        moment = raw + day * DAY_SECONDS
        if previous is not None and moment < previous:
            if previous - moment > ROLLOVER_SECONDS:
                day += 1
                moment += DAY_SECONDS
            else:
                problems.append(f"{flight_id}: {column}이(가) 앞 시각보다 이릅니다")
                moment = previous
        times[column] = moment
        previous = moment
    return times


def read_schedule(text, *, vertiports=(), name="", schedule_id=None):
    """Parse a flight-plan file into the day it describes.

    `vertiports` is what the twin actually has. A flight to a deck we have not
    placed cannot be flown, so it is refused by name rather than half-drawn: the
    caller is told which ids are missing and can place them and load again.
    """
    if isinstance(text, bytes):
        if len(text) > MAX_BYTES:
            raise ValueError("파일이 너무 큽니다 (32 MB 한도)")
        text = text.decode("utf-8-sig", errors="replace")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("비어 있는 파일입니다")
    if len(text.encode("utf-8", errors="ignore")) > MAX_BYTES:
        raise ValueError("파일이 너무 큽니다 (32 MB 한도)")

    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    columns = [column.strip() for column in (reader.fieldnames or [])]
    missing = [column for column in REQUIRED_COLUMNS if column not in columns]
    if missing:
        raise ValueError("필요한 열이 없습니다: " + ", ".join(missing))

    known = {}
    for record in vertiports or ():
        identifier = record.get("id") if isinstance(record, dict) else getattr(record, "id", None)
        if identifier:
            known[str(identifier)] = record

    problems, flights, seen = [], [], set()
    for index, row in enumerate(reader, start=2):
        row = {key.strip(): value for key, value in row.items() if key}
        try:
            flight = _flight(row, index, known, seen, problems)
        except ValueError as error:
            problems.append(str(error))
            continue
        if flight is not None:
            flights.append(flight)
        if len(flights) > MAX_FLIGHTS:
            raise ValueError(f"비행 편수가 한도를 넘었습니다 ({MAX_FLIGHTS}편)")

    if not flights:
        raise ValueError("읽을 수 있는 비행이 없습니다" + (f" ({problems[0]})" if problems else ""))

    flights.sort(key=lambda flight: (flight["off_block_s"], flight["flight_id"]))
    date = next((row for row in (flight["date"] for flight in flights) if row), "")
    digest = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()
    return {
        "schema_version": SCHEMA_VERSION,
        "schedule_id": schedule_id or digest[:16],
        "name": name or "",
        "date": date,
        "scenario_id": next((flight["scenario_id"] for flight in flights if flight["scenario_id"]), ""),
        "content_sha256": digest,
        "flights": flights,
        "aircraft": fleet(flights),
        "vertiports": sorted({flight["origin"] for flight in flights} | {flight["destination"] for flight in flights}),
        "window": window(flights),
        "problems": problems[:200],
        "problem_count": len(problems),
    }


def _flight(row, line, known, seen, problems):
    flight_id = (row.get("flight_plan_id") or "").strip()
    if not flight_id:
        raise ValueError(f"{line}행: flight_plan_id가 비어 있습니다")
    if flight_id in seen:
        raise ValueError(f"{flight_id}: 같은 비행 번호가 두 번 나옵니다")
    seen.add(flight_id)

    aircraft_id = (row.get("aircraft_id") or "").strip()
    if not aircraft_id:
        raise ValueError(f"{flight_id}: aircraft_id가 비어 있습니다")

    origin = (row.get("origin_vertiport_id") or "").strip()
    destination = (row.get("destination_vertiport_id") or "").strip()
    for identifier in (origin, destination):
        if not identifier:
            raise ValueError(f"{flight_id}: 출발/도착 버티포트가 비어 있습니다")
        if known and identifier not in known:
            raise ValueError(f"{flight_id}: 버티포트 {identifier}이(가) 배치되어 있지 않습니다")
    if origin == destination:
        raise ValueError(f"{flight_id}: 출발과 도착 버티포트가 같습니다")

    seats = int(_number(row.get("seat_capacity"), 0) or 0)
    if seats <= 0:
        raise ValueError(f"{flight_id}: seat_capacity가 올바르지 않습니다")
    cabin = seat_class(seats)
    passengers = int(_number(row.get("passenger_count"), 0) or 0)
    if passengers < 0:
        passengers = 0
    if passengers > seats:
        problems.append(f"{flight_id}: 탑승객이 좌석보다 많아 좌석 수로 맞췄습니다")
        passengers = seats

    times = _rising(row, flight_id, problems)
    off_block = times["off_block_time"]
    if off_block is None:
        raise ValueError(f"{flight_id}: off_block_time이 비어 있습니다")

    status = (row.get("flight_status") or READY_STATUS).strip() or READY_STATUS
    # A flight with no touchdown time in the file is one the generator could not
    # place at the far end. Say so rather than letting it read as ready.
    resolved = times["touchdown_time"] is not None
    if status == READY_STATUS and not resolved:
        status = UNRESOLVED_STATUS

    route_text = (row.get("route_path") or "").strip()
    route, route_error = None, None
    if route_text:
        try:
            route = json.loads(route_text)
            if not isinstance(route, list) or not 2 <= len(route) <= 4096 or not all(isinstance(n, str) and n.strip() for n in route):
                raise ValueError("2~4096개의 경유점 이름 배열이 필요합니다")
            route = [n.strip() for n in route]
            count = _number(row.get("route_waypoint_count"))
            if count is not None and count != len(route):
                raise ValueError("route_waypoint_count와 route_path 길이가 다릅니다")
        except (ValueError, TypeError) as error:
            route_error = f"{flight_id}: route_path 오류 ({error})"
            problems.append(route_error)
            route = []  # Explicit invalid intent must not fall back to a direct route.

    extra = {key: value for key, value in row.items()
             if key not in REQUIRED_COLUMNS and key not in OPTIONAL_COLUMNS and (value or "").strip()}
    return {
        "flight_id": flight_id,
        "aircraft_id": aircraft_id,
        "scenario_id": (row.get("scenario_id") or "").strip(),
        "date": (row.get("scenario_date") or "").strip(),
        "type_id": (row.get("aircraft_type_id") or cabin["type_id"]).strip(),
        "seats": seats,
        "seat_class": cabin["seats"],
        "asset_id": cabin["asset_id"],
        "passengers": passengers,
        "load_factor": round(passengers / seats, 4) if seats else 0.0,
        "origin": origin,
        "destination": destination,
        "origin_name": (row.get("origin_vertiport_name") or "").strip(),
        "destination_name": (row.get("destination_vertiport_name") or "").strip(),
        "departure_stand": (row.get("departure_stand_id") or "").strip(),
        "departure_fato": (row.get("departure_fato_id") or "").strip(),
        "arrival_stand": (row.get("arrival_stand_id") or "").strip(),
        "arrival_fato": (row.get("arrival_fato_id") or "").strip(),
        "off_block_s": off_block,
        "lift_off_s": times["lift_off_time"],
        "handoff_s": times["departure_handoff_time"],
        "touchdown_s": times["touchdown_time"],
        "in_block_s": times["in_block_time"],
        "turnaround_s": times["turnaround_complete_time"],
        "airborne_seconds": _number(row.get("airborne_time_sec")),
        "block_seconds": _number(row.get("block_time_sec")),
        "planned_departure_wait_s": _number(row.get("departure_resource_wait_sec"), 0.0) or 0.0,
        "planned_arrival_wait_s": _number(row.get("arrival_resource_wait_sec"), 0.0) or 0.0,
        "demand_hour": int(_number(row.get("demand_hour"), -1) or -1),
        "status": status,
        "resolved": resolved,
        "route_path": route, "route_error": route_error,
        "extra": extra,
    }


def fleet(flights):
    """Every aircraft in the day, with where it starts and what it flies.

    An aircraft's first flight of the day says where it must already be parked
    when the day opens, and on which stand: the schedule gives a departure stand
    for that flight, so the fleet starts the day standing on it.
    """
    by_aircraft = {}
    for flight in sorted(flights, key=lambda flight: (flight["off_block_s"], flight["flight_id"])):
        record = by_aircraft.get(flight["aircraft_id"])
        if record is None:
            cabin = seat_class(flight["seats"])
            by_aircraft[flight["aircraft_id"]] = {
                "aircraft_id": flight["aircraft_id"],
                "type_id": flight["type_id"],
                "seats": flight["seats"],
                "seat_class": cabin["seats"],
                "asset_id": cabin["asset_id"],
                "label": cabin["label"],
                "home": flight["origin"],
                "stand": flight["departure_stand"],
                "first_off_block_s": flight["off_block_s"],
                "flights": [flight["flight_id"]],
            }
            continue
        record["flights"].append(flight["flight_id"])
        # A day that flies one aircraft in two sizes is a fault in the file, not
        # something to average: the first flight's cabin stands and it is said.
        if flight["seats"] != record["seats"]:
            record.setdefault("size_changes", []).append(flight["flight_id"])
    return [by_aircraft[key] for key in sorted(by_aircraft)]


def window(flights):
    """When the day opens and closes, in seconds from the date's midnight."""
    starts = [flight["off_block_s"] for flight in flights]
    ends = [value for flight in flights
            for value in (flight["turnaround_s"], flight["in_block_s"], flight["touchdown_s"], flight["off_block_s"])
            if value is not None]
    start, end = min(starts), max(ends)
    return {"start_s": start, "end_s": end, "seconds": max(0.0, end - start),
            "start": clock_text(start), "end": clock_text(end)}


def summary(schedule):
    """What a panel says about a loaded day before anything is flown."""
    flights = schedule["flights"]
    by_class, by_origin = {}, {}
    passengers = 0
    for flight in flights:
        by_class[flight["seat_class"]] = by_class.get(flight["seat_class"], 0) + 1
        by_origin[flight["origin"]] = by_origin.get(flight["origin"], 0) + 1
        passengers += flight["passengers"]
    unresolved = [flight["flight_id"] for flight in flights if not flight["resolved"]]
    return {
        "schedule_id": schedule["schedule_id"],
        "date": schedule["date"],
        "flights": len(flights),
        "aircraft": len(schedule["aircraft"]),
        "vertiports": len(schedule["vertiports"]),
        "passengers": passengers,
        "seats": sum(flight["seats"] for flight in flights),
        "by_seat_class": [{"seats": seats, "label": seat_class(seats)["label"],
                           "asset_id": seat_class(seats)["asset_id"],
                           "note": seat_class(seats)["note"], "flights": count}
                          for seats, count in sorted(by_class.items())],
        "model_spans": {},  # Clears older clients' seat-based scale overrides.
        "visual_policy": "single_flight_asset",
        "busiest_origin": max(by_origin.items(), key=lambda item: item[1])[0] if by_origin else "",
        "unresolved": len(unresolved),
        "unresolved_flights": unresolved[:50],
        "window": schedule["window"],
        "problem_count": schedule.get("problem_count", 0),
        "supplied_routes": sum(f.get("route_path") is not None for f in flights),
        "invalid_routes": sum(bool(f.get("route_error")) for f in flights),
        "provisional_routes": sum(bool(f.get("provisional_waypoints")) for f in flights),
    }


def initial_state(schedule, inventory=None):
    """Where every aircraft stands when the day opens.

    One entry per aircraft, on the stand its first flight departs from. Two
    aircraft cannot share a stand, so a clash is moved to a free one at the same
    vertiport and reported; the schedule is somebody else's document and we do
    not get to edit it, but we do have to place them somewhere real.
    """
    placements, taken, moved = [], {}, []
    for record in sorted(schedule["aircraft"], key=lambda item: (item["home"], item["first_off_block_s"])):
        home = record["home"]
        stands = taken.setdefault(home, set())
        stand = record["stand"] or ""
        available = None if inventory is None else list(inventory.get(home, ()))
        if not stand or stand in stands or (available is not None and stand not in available):
            stand = (_free_stand(stands, stand) if available is None else
                     next((item for item in available if item not in stands), None))
            if stand is None:
                raise ValueError(f"{home}: 실제 Gate 수보다 초기 기체가 많습니다 ({record['aircraft_id']})")
            moved.append(record["aircraft_id"])
        stands.add(stand)
        placements.append({
            "aircraft_id": record["aircraft_id"],
            "vertiport_id": home,
            "stand_id": stand,
            "seats": record["seats"],
            "seat_class": record["seat_class"],
            "asset_id": record["asset_id"],
            "type_id": record["type_id"],
            "first_flight_s": record["first_off_block_s"],
            "flights": len(record["flights"]),
        })
    return {"schema_version": SCHEMA_VERSION, "schedule_id": schedule["schedule_id"],
            "opens_s": schedule["window"]["start_s"], "opens": schedule["window"]["start"],
            "placements": placements, "reassigned": moved}


def _free_stand(taken, wanted):
    """The first `G<n>` nobody is standing on, starting from the one asked for."""
    prefix = "".join(character for character in (wanted or "G") if character.isalpha()) or "G"
    for number in range(1, 200):
        candidate = f"{prefix}{number}"
        if candidate not in taken:
            return candidate
    return f"{prefix}{len(taken) + 1}"
