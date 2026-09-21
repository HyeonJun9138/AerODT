"""The native engine: FastPhysics and SimpleFlight actually flying the plan.

`flight_simulation` integrates a plan kinematically — it walks the path at the
speeds the plan asked for. This runs the airborne part of the same plan through
the C++ stack instead: the tiltrotor's rigid-body dynamics and the SimpleFlight
cascade controller that flies the native UAM demo. What comes back is the same
`{states, summary}` every other layer already reads, so storage, the wire and
the display do not change when the engine does.

The two processes talk over a pipe in plain numbers. The runner works in the
local north-east-down frame the physics uses, anchored on the departure FATO,
and this module converts both ways. Nothing but numbers crosses, so the C++
needs no JSON library and the protocol reads in a terminal.

Three things are worth saying plainly about what this does and does not do.

*It flies the air, not the ground.* Taxiing to a stand and charging at it are
not flight dynamics — FastPhysics has no wheels and no charger — so those legs
stay kinematic. Every state says which engine produced it, so a run is honest
about being partly one and partly the other.

*The physics decides the motion; the browser resolves the height datum.* The controller
tracks the planned waypoints, and where it is along the leg at each instant is
its own result. The display adds the recorded physical height error to the
terrain-resolved design, preserving the actual climb and descent. The physics runs over flat ground
and cannot know a hill is there, so its own height is reported alongside
(`physics_altitude_m`) rather than being drawn as if it accounted for terrain.

*A flown leg takes as long as it takes.* The controller does not hit the plan's
durations exactly, so the plan is re-timed to what actually happened and that
re-timed plan is what gets stored with the run. Energy is then the plan's power
model over the real durations — the flight's own clock, not a nominal one.
"""
import copy
import math
import os
import shutil
import subprocess
from pathlib import Path

from digital_twin.simulation import flight_simulation
from digital_twin.model_library.flight_plan import HOVER_CAPTURE_M, ROUTE_CAPTURE_M, waypoint_capture_m

ENGINE = "native-fastphysics-simpleflight"
GROUND_ENGINE = flight_simulation.ENGINE
RUNNER_NAME = "aerodt_uam_flight_runner"
RUNNER_ENV = "AERODT_UAM_FLIGHT_RUNNER"
# Where a build leaves the runner, in the order they are looked for. A build
# collects its programs under `bin`, so this says nothing about which layer's
# source tree the runner happens to be built from.
RUNNER_PATHS = tuple(f"project_support/build/aerodt/{preset}/bin"
                     for preset in ("windows-release", "windows-debug",
                                    "linux-release", "linux-debug"))
METRES_PER_DEGREE = 111320.0
# The physics step, and how much simulated time a flight may take before it is
# called a failure rather than a slow flight.
DEFAULT_STEP_S = 0.004
TIMEOUT_MARGIN = 3.0
MINIMUM_TIMEOUT_S = 600.0
# How near a waypoint counts as reached. A hover point is arrived at closely; a
# route waypoint is a turn, so passing near it is passing it.
# Reverse-transition timing belongs to RoutePilot, before descent begins.
DEFAULT_RATE_HZ = flight_simulation.DEFAULT_RATE_HZ
RATE_RANGE_HZ = flight_simulation.RATE_RANGE_HZ


# ---------------------------------------------------------------- the binary

def runner_path(root=None, explicit=None):
    """Where the built runner is, or None when nothing has been built.

    Asked for explicitly, or named in the environment for a build that lives
    somewhere else, or found where a build of this tree leaves it."""
    named = explicit or os.environ.get(RUNNER_ENV)
    if named:
        found = Path(named)
        return found if found.exists() else None
    base = Path(root) if root else Path.cwd()
    for relative in RUNNER_PATHS:
        for name in (f"{RUNNER_NAME}_v2.exe", f"{RUNNER_NAME}_v2", f"{RUNNER_NAME}.exe", RUNNER_NAME):
            found = base / relative / name
            if found.exists():
                return found
    found = shutil.which(RUNNER_NAME)
    return Path(found) if found else None


def available(root=None, explicit=None):
    return runner_path(root, explicit) is not None


# ---------------------------------------------------------------- the plan, as waypoints

def air_block(plan):
    """The run of legs the native engine flies: from the first airborne leg to
    the last. Everything before and after it is ground."""
    legs = (plan or {}).get("legs") or []
    airborne = [index for index, leg in enumerate(legs) if leg.get("kind") in ("air", "vertical")]
    return (airborne[0], airborne[-1]) if airborne else None


def waypoints_of(plan):
    """The airborne route as waypoints in metres north, east and down from the
    departure FATO, each carrying where in the plan it sits so a state flown
    near it can be put back on the right leg.

    Heights keep their numbers as designed. The datums differ -- a deck, a
    height over the ground -- and only the display holds the terrain that tells
    them apart, so to the physics they are all heights above the departure
    deck. That is exactly what flat-ground physics can represent, and the
    difference is what the display's own resolution puts back."""
    block = air_block(plan)
    if block is None:
        return [], None
    first, last = block
    legs = plan["legs"]
    origin_point = legs[first]["path"][0]
    base_lat, base_lon, base_alt = origin_point[1], origin_point[0], origin_point[2]
    cos_lat = math.cos(math.radians(base_lat)) or 1e-9

    def ned(point):
        return {"north_m": (point[1] - base_lat) * METRES_PER_DEGREE,
                "east_m": (point[0] - base_lon) * METRES_PER_DEGREE * cos_lat,
                "down_m": -(point[2] - base_alt)}

    points = []
    for index in range(first, last + 1):
        leg = legs[index]
        path = leg.get("path") or []
        speed = float(leg.get("speed_mps") or 10.0)
        # RoutePilot anticipates the descent from these goals and completes
        # reverse transition at the entry altitude. No descending winged leg.
        winged = leg["stage"] in ("climb", "cruise")
        span = max(1, len(path) - 1)
        # The first point of a leg is the last of the one before it, so it is
        # not flown to: the aircraft is already standing on it.
        for at in range(1, len(path)):
            here, from_f, to_f = ned(path[at]), (at - 1) / span, at / span
            shared = {"speed_mps": speed, "leg": index, "stage": leg["stage"],
                      "leg_kind": leg["kind"]}
            points.append({**shared, **here, "f": to_f, "from_f": from_f,
                           "fixed_wing": winged, "capture_m": _capture_for(leg, path, at)})
    origin = {"latitude": base_lat, "longitude": base_lon, "altitude_m": base_alt,
              "datum": origin_point[3] if len(origin_point) > 3 else "msl", "cos_lat": cos_lat}
    return points, origin


def _capture_for(leg, path, at):
    """How near this waypoint counts as reached. A route waypoint is a turn, so
    passing near it is passing it. A hover point is arrived at, and a lift-off
    is only tens of metres long — a fixed radius there would end the climb a
    quarter of the way up — so it is a share of the hop, never more."""
    rise = (path[at][2] - path[at - 1][2]) if at > 0 else 0.0
    return waypoint_capture_m(leg["kind"] == "vertical", rise)


def arrival_heading_of(plan):
    """Use the arrival taxi's first tangent, not a straight line to its gate."""
    block = air_block(plan)
    if block is None:
        return None
    for leg in plan['legs'][block[1] + 1:]:
        if leg.get('stage') != 'gate_in':
            continue
        headings = (leg.get('ground_motion') or {}).get('headings_deg') or []
        if headings and math.isfinite(headings[0]):
            return headings[0] % 360.0
        path = leg.get('path') or []
        for start, end in zip(path, path[1:]):
            segment = flight_simulation.along_leg({'path': [start, end]}, 0.0)
            if segment and segment['heading_deg'] is not None:
                return segment['heading_deg']
        return None
    return None


def render_input(points, *, step_s=DEFAULT_STEP_S, emit_s=0.2, timeout_s=MINIMUM_TIMEOUT_S,
                 initial_yaw_deg=0.0, landing_yaw_deg=None):
    """The runner's stdin: its settings, then the waypoints, then `run`."""
    lines = [f"step {step_s:g}", f"emit {emit_s:g}", f"capture {ROUTE_CAPTURE_M:g}",
             f"timeout {timeout_s:g}"]
    if not math.isfinite(initial_yaw_deg):
        raise ValueError("initial_yaw: finite angle required")
    lines.append(f"initial_yaw {initial_yaw_deg:g}")
    lines.append("smooth_flight 1")
    if landing_yaw_deg is not None:
        if not math.isfinite(landing_yaw_deg):
            raise ValueError("landing_yaw: finite angle required")
        lines.append(f"landing_yaw {landing_yaw_deg:g}")
    for point in points:
        lines.append("waypoint {north:.3f} {east:.3f} {down:.3f} {speed:.3f} {wing:d} {capture:.3f}".format(
            north=point["north_m"], east=point["east_m"], down=point["down_m"],
            speed=point["speed_mps"], wing=int(point["fixed_wing"]), capture=point["capture_m"]))
    lines.append("run")
    return "\n".join(lines) + "\n"


def parse_output(text):
    """The runner's stdout as flown states, plus how the flight ended."""
    flown, ending, problem = [], None, None
    for line in (text or "").splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "state" and len(fields) >= 16:
            try:
                values = [float(item) for item in fields[1:17]]
            except ValueError:
                continue
            flown.append({
                "t": values[0], "north_m": values[1], "east_m": values[2], "down_m": values[3],
                "yaw_deg": values[7], "pitch_deg": values[8], "roll_deg": values[9],
                "tilt_deg": values[10], "blend": values[11], "speed_mps": values[12],
                "grounded": values[13] >= 0.5, "waypoint": int(values[14]),
                # The rotor speed came later than the rest of the line, so a
                # runner built before it simply does not report one.
                "rotor_radps": values[15] if len(values) > 15 else None,
                "control_surface_deg": tuple(float(v) for v in fields[17:21]) if len(fields)>=21 else None,
            })
        elif fields[0] == "done" and len(fields) >= 4:
            ending = {"reached": int(fields[1]), "total": int(fields[2]), "elapsed_s": float(fields[3])}
        elif fields[0] == "error":
            problem = " ".join(fields[1:]) or "the flight runner reported a failure"
    return flown, ending, problem


# ---------------------------------------------------------------- flown states, back on the plan

def _progress(before, target, flown):
    """How far a flown state is from one waypoint to the next, 0 to 1.

    Along the ground where there is ground to cover, and up the climb where
    there is not — a vertical leg covers no distance, so projecting it onto a
    horizontal line would leave it stuck at its start."""
    north, east = target["north_m"] - before["north_m"], target["east_m"] - before["east_m"]
    flat = north * north + east * east
    if flat > 1.0:
        along = ((flown["north_m"] - before["north_m"]) * north
                 + (flown["east_m"] - before["east_m"]) * east) / flat
    else:
        drop = target["down_m"] - before["down_m"]
        along = ((flown["down_m"] - before["down_m"]) / drop) if abs(drop) > 0.5 else 1.0
    return min(1.0, max(0.0, along))


START = {"north_m": 0.0, "east_m": 0.0, "down_m": 0.0}


def _segment(points, index, flown):
    """Which stretch of the planned path a flown state is on, and how far along
    it — the waypoint it is aiming at, unless it has not yet passed the one
    before, which is what a capture radius leaves it doing.

    A waypoint counts as reached from tens of metres away, so the moment the
    aircraft starts aiming at the next one it is still short of the last. Read
    from the new target alone it would jump forward by the capture radius at
    every waypoint; read from the stretch it is actually on, it does not."""
    target = points[index]
    along = _progress(points[index - 1] if index > 0 else START, target, flown)
    if along > 0.0 or index == 0:
        return target, along
    behind = points[index - 1]
    return behind, _progress(points[index - 2] if index > 1 else START, behind, flown)


def _place(flown, points, origin, start_s, minimum_leg=0):
    """One flown state, put back on the plan: where it is in degrees, which leg
    it is on and how far through, and what the physics had it doing."""
    index = min(max(flown["waypoint"], 0), len(points) - 1)
    target, along = _segment(points, index, flown)
    if target["leg"] < minimum_leg:
        # A hover alignment may drift across the projection origin. Once the
        # next leg has begun its metadata must not switch back to takeoff.
        target = points[index]
        along = _progress(points[index - 1] if index else START, target, flown)
    # Each waypoint knows where its own leg was when it was last left behind,
    # so a stretch that spans two legs still meets at the point they share.
    fraction = target["from_f"] + (target["f"] - target["from_f"]) * along
    return {
        "t": round(start_s + flown["t"], 3),
        "leg": target["leg"], "f": round(fraction, 6),
        "stage": target["stage"], "kind": target["leg_kind"],
        "mode": flight_simulation.mode_of(flown["tilt_deg"]),
        "latitude": round(origin["latitude"] + flown["north_m"] / METRES_PER_DEGREE, 7),
        "longitude": round(origin["longitude"]
                           + flown["east_m"] / (METRES_PER_DEGREE * origin["cos_lat"]), 7),
        # The designed height at this point on the leg, filled in once the plan
        # is re-timed; the display stands it on the terrain. What the physics
        # itself reached over flat ground rides alongside it.
        "altitude_m": 0.0, "datum": origin["datum"],
        "physics_altitude_m": round(origin["altitude_m"] - flown["down_m"], 2),
        "heading_deg": round(flown["yaw_deg"] % 360.0, 2),
        "pitch_deg": round(flown["pitch_deg"], 2),
        "roll_deg": round(flown["roll_deg"], 2),
        "tilt_deg": round(flown["tilt_deg"], 2),
        "fixed_wing_blend": round(flown["blend"], 4),
        # What the rotor actuators were actually turning at, so a display can
        # turn the propellers at that rate instead of at a made-up one.
        **({"rotor_radps": round(flown["rotor_radps"], 2)}
           if flown.get("rotor_radps") is not None else {}),
        "control_surface_deg": flown.get("control_surface_deg"),
        "speed_mps": round(flown["speed_mps"], 2),
        "grounded": flown["grounded"],
        "battery_pct": 0.0, "distance_done_m": 0.0,   # filled in once the plan is re-timed
        "engine": "native",
    }


def _thin(states, rate_hz):
    """No more states a second than were asked for, and always the last one,
    so a flight ends where it ended. The runner already reports at this rate;
    this is what holds when it was run with different settings."""
    if not states:
        return []
    step = 1.0 / float(rate_hz)
    kept, due = [], -1.0
    for state in states:
        if state["t"] >= due:
            kept.append(state)
            due = state["t"] + step - 1e-9
    if kept[-1] is not states[-1]:
        kept.append(states[-1])
    return kept


# ---------------------------------------------------------------- the plan, re-timed to the flight

def retime(plan, flown_durations, charge_target_pct=None):
    """The plan as the flight actually went: the airborne legs take the time
    the physics took, and time, energy and battery run through from there.

    The charge at the end is recomputed rather than kept, because how long a
    charger is plugged in depends on what the flight actually spent."""
    retimed = copy.deepcopy(plan)
    aircraft = retimed.get("aircraft") or {}
    capacity = float(aircraft.get("battery_capacity_kwh") or 0.0)
    powers = aircraft.get("power_kw") or {}
    target = float(charge_target_pct if charge_target_pct is not None
                   else (retimed.get("request") or {}).get("charge_target_pct")
                   or (retimed.get("legs") or [{}])[-1].get("battery_end_pct") or 100.0)
    battery = float((retimed.get("totals") or {}).get("battery_start_pct") or 100.0)
    elapsed, flight_end = 0.0, 0.0
    for index, leg in enumerate(retimed.get("legs") or []):
        if index in flown_durations:
            leg["duration_s"] = round(flown_durations[index], 1)
        if leg["stage"] == "charge":
            needed_kwh = max(0.0, (target - battery) / 100.0 * capacity)
            power = float(aircraft.get("charge_power_kw") or 0.0)
            leg["duration_s"] = round(needed_kwh / power * 3600.0 if power else 0.0, 1)
            leg["duration_s"] = max(leg["duration_s"], float(leg.get('passenger_hold_s') or 0))
            leg["charge_kwh"] = round(needed_kwh, 2)
            leg["start_s"] = round(elapsed, 1)
            elapsed += leg["duration_s"]
            leg["end_s"] = round(elapsed, 1)
            leg["energy_kwh"] = -leg["charge_kwh"]
            leg["battery_start_pct"] = round(battery, 2)
            battery = max(battery, target)
            leg["battery_end_pct"] = round(battery, 2)
            continue
        used = float(powers.get(leg["stage"], 0.0)) * leg["duration_s"] / 3600.0
        leg["start_s"] = round(elapsed, 1)
        elapsed += leg["duration_s"]
        leg["end_s"] = round(elapsed, 1)
        flight_end = elapsed
        leg["energy_kwh"] = round(used, 3)
        leg["battery_start_pct"] = round(battery, 2)
        battery = max(0.0, battery - (used / capacity * 100.0 if capacity else 0.0))
        leg["battery_end_pct"] = round(battery, 2)
    legs = retimed.get("legs") or []
    totals = retimed.setdefault("totals", {})
    totals["duration_s"] = round(elapsed, 1)
    totals["flight_duration_s"] = round(flight_end, 1)
    totals["energy_kwh"] = round(sum(leg["energy_kwh"] for leg in legs if leg["energy_kwh"] > 0), 3)
    totals["battery_landing_pct"] = legs[-1]["battery_start_pct"] if legs else None
    totals["battery_end_pct"] = legs[-1]["battery_end_pct"] if legs else None
    retimed["timing"] = {"source": ENGINE, "planned_duration_s": round(
        float((plan.get("totals") or {}).get("duration_s") or 0.0), 1)}
    return retimed


def _account(state, plan):
    """The battery and the distance covered at a state, read off the re-timed
    plan — the same accounting the kinematic engine does, so a native run and a
    kinematic one of the same flight can be read side by side."""
    legs = plan.get("legs") or []
    index = min(max(state["leg"], 0), len(legs) - 1)
    leg = legs[index]
    fraction = state["f"]
    energy_fraction = min(1.0,max(0.0,(state['t']-leg['start_s'])/max(.001,leg['duration_s']))) if leg.get('ground_motion') else fraction
    state["battery_pct"] = round(leg["battery_start_pct"]
                                 + (leg["battery_end_pct"] - leg["battery_start_pct"]) * energy_fraction, 3)
    state["distance_done_m"] = round(
        sum(item["distance_m"] for item in legs[:index]) + leg["distance_m"] * fraction, 1)
    # The designed height at this point on the leg, with the datum it was
    # measured from, so the display resolves it against the terrain exactly as
    # it resolves the route's own.
    placed = flight_simulation.along_leg(leg, fraction)
    if placed:
        state["altitude_m"] = round(placed["altitude_m"], 2)
        state["datum"] = placed["datum"]
        if state.get("engine") == "native":
            # Preserve actual vertical motion; the browser adds only its terrain/deck datum.
            state["height_error_m"] = round(state["physics_altitude_m"] - placed["altitude_m"], 3)
            state["planned_altitude_m"] = state["altitude_m"]
            state["altitude_m"] = state["physics_altitude_m"]
    return state


def _ground_states(plan, first_s, last_s, rate_hz, shift_s=0.0, include_last=True):
    """The taxi and the charge, walked kinematically. FastPhysics has no wheels
    and no charger; pretending otherwise would be inventing a result.

    The block that hands over to the physics stops short of the instant it
    hands over on, because the physics reports that instant itself."""
    if last_s <= first_s:
        return []
    step = 1.0 / float(rate_hz)
    states, time, heading = [], first_s, 0.0
    while time < last_s - 1e-9:
        state = flight_simulation.state_at(plan, time, heading)
        heading = state["heading_deg"]
        state["t"] = round(time + shift_s, 3)
        state["engine"] = "kinematic"
        states.append(state)
        time += step
    final = flight_simulation.state_at(plan, last_s, heading) if include_last else None
    if final is not None:
        final["t"] = round(last_s + shift_s, 3)
        final["engine"] = "kinematic"
        states.append(final)
    return states


def _ground_motor_lifecycle(states, plan, touchdown):
    """Visual ground motor indication, explicitly not native actuator telemetry.

    Keep idle through taxi-in, shut down over the final six seconds at the gate.
    Charge means motors off. Native airborne rotor_radps is never modified.
    """
    idle = max(0.0, float(touchdown.get("rotor_radps") or 0.0))
    for state in states:
        leg = plan["legs"][state["leg"]]
        remaining = max(0.0, leg["end_s"] - state["t"])
        share = min(1.0, remaining / 6.0) if state["stage"] == "gate_in" else 0.0
        state["rotor_visual_radps"] = round(idle * share * share * (3.0 - 2.0 * share), 2)
        state["motor_state"] = "off" if share <= 0 else "shutdown" if share < 1 else "idle"
        state["rotor_source"] = "ground-visual-indication"


# ---------------------------------------------------------------- the run

def run(plan, rate_hz=DEFAULT_RATE_HZ, *, root=None, runner=None, step_s=DEFAULT_STEP_S):
    """Fly `plan` with the native stack.

    Returns `{schema_version, states, summary, plan}` — the plan re-timed to
    the flight, because it is the one the states belong to. Raises
    ValueError('field: reason') for anything it cannot fly."""
    try:
        rate = float(rate_hz)
    except (TypeError, ValueError):
        raise ValueError("rate_hz: number expected") from None
    if not RATE_RANGE_HZ[0] <= rate <= RATE_RANGE_HZ[1]:
        raise ValueError(f"rate_hz: {RATE_RANGE_HZ[0]} to {RATE_RANGE_HZ[1]}")
    block = air_block(plan)
    if block is None:
        raise ValueError("plan: no airborne legs to fly")
    first_air, last_air = block
    points, origin = waypoints_of(plan)
    if not points:
        raise ValueError("plan: the airborne legs have no waypoints")
    binary = runner_path(root, runner)
    if binary is None:
        raise ValueError("engine: the native flight runner is not built")

    legs = plan["legs"]
    planned_air_s = legs[last_air]["end_s"] - legs[first_air]["start_s"]
    # A steep/long arrival now flies at bounded multirotor descent speed,
    # not the plan's nominal fixed-wing speed. Budget it without removing
    # the timeout that detects a pilot which cannot capture its route.
    guidance_s = 0.0
    previous = {"north_m": 0.0, "east_m": 0.0, "down_m": 0.0}
    for point in points:
        horizontal = math.hypot(point["north_m"] - previous["north_m"],
                                point["east_m"] - previous["east_m"])
        vertical = abs(point["down_m"] - previous["down_m"])
        guidance_s += max(horizontal / max(1.0, min(8.0, point["speed_mps"])),
                          vertical / 1.2) + 30.0
        previous = point
    timeout_s = max(MINIMUM_TIMEOUT_S, planned_air_s * TIMEOUT_MARGIN,
                    guidance_s * TIMEOUT_MARGIN)
    initial_yaw = 0.0
    for leg in reversed(legs[:first_air]):
        endpoint = flight_simulation.along_leg(leg, 1.0)
        if endpoint and endpoint['heading_deg'] is not None:
            initial_yaw = endpoint['heading_deg']
            break
    stdin = render_input(points, step_s=step_s, emit_s=1.0 / rate, timeout_s=timeout_s,
                         initial_yaw_deg=initial_yaw, landing_yaw_deg=arrival_heading_of(plan))
    try:
        finished = subprocess.run([str(binary)], input=stdin, capture_output=True, text=True,
                                  timeout=max(120.0, timeout_s))
    except subprocess.TimeoutExpired:
        raise ValueError("engine: the native flight runner did not finish in time") from None
    except OSError as error:
        raise ValueError(f"engine: the native flight runner could not be started ({error.strerror})") from None
    flown, ending, problem = parse_output(finished.stdout)
    if problem:
        raise ValueError(f"engine: {problem}")
    if not flown or ending is None:
        raise ValueError("engine: the native flight runner produced no states")
    if ending["reached"] < ending["total"]:
        raise ValueError(f"engine: the flight reached only {ending['reached']} of "
                         f"{ending['total']} waypoints")

    air = []
    for state in _thin(flown, rate):
        air.append(_place(state, points, origin, legs[first_air]["start_s"],
                          minimum_leg=air[-1]["leg"] if air else first_air))
    # The runner only stops once the last waypoint is reached, so the flight
    # ends on the deck it was flying to, not a capture radius short of it.
    if not air[-1]["grounded"]:
        raise ValueError("engine: final waypoint reported without touchdown")
    air[-1]["leg"], air[-1]["f"] = points[-1]["leg"], 1.0
    flown_s = air[-1]["t"] - air[0]["t"] if len(air) > 1 else ending["elapsed_s"]
    # Each airborne leg took as long as the physics spent on it.
    durations, seen = {}, {}
    for state in air:
        seen.setdefault(state["leg"], [state["t"], state["t"]])[1] = state["t"]
    entry = legs[first_air]["start_s"]
    for index in range(first_air, last_air + 1):
        span = seen.get(index)
        end = span[1] if span else entry
        durations[index] = max(0.1, end - entry)
        entry = end
    ground_plan = copy.deepcopy(plan)
    for leg in ground_plan["legs"]:
        if leg["stage"] == "gate_in" and leg.get("ground_motion"):
            from digital_twin.model_library.ground_motion import align_start
            align_start(leg, air[-1]['heading_deg'])
            leg["duration_s"] = max(leg["duration_s"], leg["ground_motion"]["times_s"][-1] + 6.0)
            leg["shutdown_hold_s"] = 6.0
    retimed = retime(ground_plan, durations)

    # Ground before the flight keeps the plan's clock; ground after it starts
    # when the aircraft actually got down.
    before = _ground_states(retimed, 0.0, retimed["legs"][first_air]["start_s"], rate,
                            include_last=False)
    # Rounding the flown durations to a tenth can leave the plan's clock a few
    # hundredths off the last state the physics reported; the ground that
    # follows starts on that state, so the run's time never steps backwards.
    after_from = retimed["legs"][last_air]["end_s"]
    after = _ground_states(retimed, after_from, retimed["totals"]["duration_s"], rate,
                           shift_s=air[-1]["t"] - after_from)
    # The terminal native state owns touchdown; do not duplicate its timestamp.
    after = [state for state in after if state["t"] > air[-1]["t"]]
    _ground_motor_lifecycle(after, retimed, air[-1])
    states = [_account(state, retimed) for state in before + air + after]
    # The plan a run is stored with says how long that run was, so a display
    # reading 'how much is left' from the plan agrees with the states.
    retimed["totals"]["duration_s"] = round(states[-1]["t"], 1)

    stages = {}
    for state in states:
        stages[state["stage"]] = stages.get(state["stage"], 0) + 1
    summary = {
        "engine": ENGINE, "ground_engine": GROUND_ENGINE, "rate_hz": rate,
        "physics_step_s": step_s, "physics_elapsed_s": round(ending["elapsed_s"], 2),
        "waypoints": ending["total"], "states": len(states),
        "duration_s": round(states[-1]["t"], 1),
        "flight_duration_s": round(flown_s, 1),
        "planned_flight_duration_s": round(planned_air_s, 1),
        "native_states": len(air), "kinematic_states": len(before) + len(after),
        "battery_start_pct": states[0]["battery_pct"], "battery_end_pct": states[-1]["battery_pct"],
        "battery_min_pct": round(min(state["battery_pct"] for state in states), 3),
        "max_altitude_m": round(max(state["altitude_m"] for state in states), 2),
        "max_physics_altitude_m": round(max(state.get("physics_altitude_m", 0.0) for state in air), 2),
        "max_speed_mps": round(max(state["speed_mps"] for state in states), 2),
        "max_tilt_deg": round(max(state["tilt_deg"] for state in states), 2),
        "max_rotor_radps": round(max((state.get("rotor_radps") or 0.0) for state in air), 2),
        "max_bank_deg": round(max(abs(state.get("roll_deg", 0.0)) for state in air), 2),
        "distance_m": states[-1]["distance_done_m"],
        "stage_states": stages,
    }
    return {"schema_version": flight_simulation.SCHEMA_VERSION, "states": states,
            "summary": summary, "plan": retimed}
