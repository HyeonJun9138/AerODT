"""Simulation Engine: a whole day of flights, flown as the clock reaches them.

A schedule says 947 flights will happen. This flies them. Not by working the day
out in advance and playing the answer back — that would make the holds a
foregone conclusion — but by stepping a clock and asking, at each step, what
every aircraft is doing now. A flight that has to wait finds that out the way a
real one does: it asks the service, and the answer comes back late.

What one aircraft does between two decks is already known: `flight_plan.py`
builds the taxi, the lift, the corridor and the descent, and the geometry does
not depend on which day it is flown. So a route is built once per
origin-destination-stand combination, resolved to absolute heights, and shared
by every flight that uses it. What is *not* shared is the timing, because that
is what the day is about.

The engine owns positions and phases. It does not own the sequence: who lands
next is `psu_sequencing.py`, and this asks it. It does not own the schedule
either: that is `flight_schedule.py`, and this reads it. Keeping the three apart
is what lets the interesting question — what happens to a day whose plan cannot
be flown as written — be answered by changing one of them.

Heights are resolved here, once per route, into metres above the ellipsoid, so
the display places thousands of aircraft without resolving anything itself. A
deck's height comes from the vertiport that was placed; ground-relative
waypoints come from the elevation source if there is one, and from the decks at
either end if there is not.
"""
import math
import hashlib
import json
from collections.abc import MutableMapping
from copy import deepcopy

from digital_twin.contracts.ground_operations import GroundObservation, GroundRequest
from digital_twin.model_library.ground_routes import route_geometry
from digital_twin.model_library import (flight_mode, flight_plan, flight_schedule,
                                        scheduled_route, ground_motion, terminal_paths)
from digital_twin.simulation import decision_policy, psu_sequencing, fato_assignment, arrival_allocation
from digital_twin.simulation.holding_queue import positions as holding_positions, relative as holding_relative
from digital_twin.simulation.terminal_reservations import TerminalReservations
from digital_twin.model_library.uam_energy import energy_profile
from digital_twin.simulation.uam_energy import BatteryState
from digital_twin.simulation import scenario_energy, manual_takeover

SCHEMA_VERSION = 1

# How often the world is stepped. Fine enough that a 45 m/s cruise moves under
# ten metres between steps, coarse enough that a whole day is cheap.
STEP_SECONDS = 0.2
# Positions are only recomputed for aircraft that are doing something. A parked
# one keeps the position it was parked at. There is no "finished" phase: an
# aircraft that has flown its last flight of the day is standing on a deck, the
# same as one whose next flight is an hour away, and a deck that empties itself
# as the day ends would be the model showing through rather than the day.
PHASE_PARKED = "parked"
# The airborne phases a flight passes through, in order. `hold_*` are inserted
# at runtime when the service says to wait; the rest come from the plan.
HOLD_EXIT, HOLD, HOLD_RETURN = "hold_exit", "hold", "hold_return"
HOLD_PHASES = (HOLD_EXIT, HOLD, HOLD_RETURN)
GROUND_PHASES = ("gate_out", "gate_in", "charge", PHASE_PARKED)
# Where a holding aircraft goes: a ring around the deck it is waiting for, far
# enough out to be clear of the corridor, with a floor under the lowest tier.
HOLD_RADIUS_M = 600.0
# How near the deck a hold may be set up. Avoid a long trip for a short
# wait: choose the closest available point within the configured region.
# The pattern is drawn to fit the wait and this is
# the floor it stops shrinking at, far enough to still be out of the corridor.
HOLD_MIN_RADIUS_M = 400.0
# Whatever the wait, an aircraft that leaves the corridor stops for at least
# this long. A transition to multirotor and straight back is not a hold.
HOLD_MIN_STATION_S = 10.0
HOLD_TIER_M = 120.0
HOLD_BASE_M = 300.0
HOLD_TIERS = 6
HOLD_SLOTS = 12
# A corridor bearing this close to a candidate holding bearing is too close: the
# aircraft would be sitting in the way of the traffic it is waiting behind.
CORRIDOR_CLEARANCE_DEG = 35.0
# The speed a multirotor moves at once it has transitioned back out of cruise.
HOLD_SPEED_MPS = 15.0
# Routes are built lazily and kept. One is a handful of points, so a day that
# uses a thousand of them costs a few megabytes; the cap is here so a stranger
# file cannot grow without bound, not to save memory on this one.
ROUTE_CACHE = 4096

# The track an aircraft has flown, kept so it can be drawn when somebody asks
# for it. One flight's worth: it is cleared when the next one starts, because
# what the panel is asked for is the path of the flight being watched. A point
# is kept when the aircraft has moved far enough or enough time has passed, so a
# hold does not fill the buffer with the same position.
TRAIL_POINTS = 900
TRAIL_STEP_M = 40.0
TRAIL_STEP_S = 4.0
# How long people take to get off after the aircraft is on its stand. The plan
# carries the walk itself; this is the floor for a flight whose plan could not
# build one, so an arrival is never instantaneous.
ALIGHTING_MIN_S = 8.0

EARTH_RADIUS_M = 6371000.0


class _ActivePadView(MutableMapping):
    """Compatibility view over operator-reported FATO occupancy."""

    def __init__(self, engine):
        self.engine = engine

    def __getitem__(self, key):
        owner = self.engine._active_pad_owner(key)
        if owner is None:
            raise KeyError(key)
        return owner

    def __iter__(self):
        return iter(dict(self.engine._active_pad_items()))

    def __len__(self):
        return len(self.engine._active_pad_items())

    def __setitem__(self, key, value):
        self.engine._observe_pad_occupied(key, value, self.engine.time_s)

    def __delitem__(self, key):
        if not self.engine._release_pad_observation(key, now_s=self.engine.time_s):
            raise KeyError(key)


def _bearing(a, b):
    """Degrees clockwise from north, from (lat, lon) `a` to `b`."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    delta = math.radians(b[1] - a[1])
    y = math.sin(delta) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(delta)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _offset(point, bearing_deg, distance_m):
    """The (lat, lon) `distance_m` from `point` along `bearing_deg`."""
    angular = distance_m / EARTH_RADIUS_M
    bearing = math.radians(bearing_deg)
    lat1, lon1 = math.radians(point[0]), math.radians(point[1])
    lat2 = math.asin(math.sin(lat1) * math.cos(angular) + math.cos(lat1) * math.sin(angular) * math.cos(bearing))
    lon2 = lon1 + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(lat1),
                             math.cos(angular) - math.sin(lat1) * math.sin(lat2))
    return (math.degrees(lat2), (math.degrees(lon2) + 540.0) % 360.0 - 180.0)


def _angle_between(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


class Phase:
    """One stretch of a flight: a path in absolute metres, and how long it takes.

    The path is `[(lat, lon, altitude_m), ...]` with the altitude already
    resolved, plus the running distance to each point so a position at a moment
    is a lookup rather than a walk from the start.
    """

    __slots__ = ("stage", "label", "points", "marks", "distance_m", "duration_s", "speed_mps", "detail")

    def __init__(self, stage, label, points, duration_s, speed_mps=0.0, detail=None):
        self.stage, self.label, self.detail = stage, label, detail or {}
        self.points = points
        self.marks = [0.0]
        total = 0.0
        for first, second in zip(points, points[1:]):
            total += flight_plan.haversine_m((first[0], first[1]), (second[0], second[1]))
            self.marks.append(total)
        self.distance_m = total
        self.duration_s = max(0.0, float(duration_s))
        self.speed_mps = float(speed_mps)

    def at(self, elapsed):
        """(lat, lon, altitude_m, heading_deg) this far into the phase."""
        points = self.points
        if len(points) == 1:
            point = points[0]
            return point[0], point[1], point[2], None
        fraction = 0.0 if self.duration_s <= 0 else min(1.0, max(0.0, elapsed / self.duration_s))
        profile = self.detail.get("ground_motion")
        if profile:
            fraction, _ = ground_motion.at(profile, elapsed)
        return self.at_fraction(fraction, elapsed)

    def at_fraction(self, fraction, elapsed=0.0):
        points = self.points
        profile = self.detail.get('ground_motion')
        if len(points) == 1:
            return (*points[0], None)
        wanted = self.distance_m * fraction
        # A vertical or hovering phase covers no ground: the height moves instead.
        if self.distance_m <= 0.0:
            first, last = points[0], points[-1]
            altitude = first[2] + (last[2] - first[2]) * fraction
            return first[0], first[1], altitude, None
        index = 1
        while index < len(self.marks) - 1 and self.marks[index] < wanted:
            index += 1
        start, end = points[index - 1], points[index]
        span = self.marks[index] - self.marks[index - 1]
        share = 0.0 if span <= 0 else (wanted - self.marks[index - 1]) / span
        return (start[0] + (end[0] - start[0]) * share,
                start[1] + (end[1] - start[1]) * share,
                start[2] + (end[2] - start[2]) * share,
                ground_motion.heading_at(profile, fraction, elapsed) if profile else
                _bearing((start[0], start[1]), (end[0], end[1])))


class Route:
    """A flight's geometry, built once and shared by everything that flies it."""

    __slots__ = ("key", "phases", "descent_index", "landing_index", "arrival", "departure",
                 "distance_m", "duration_s", "direct", "boarding", "alighting")

    def __init__(self, key, phases, arrival, departure):
        self.key, self.phases, self.arrival, self.departure = key, phases, arrival, departure
        # The walk to and from the aircraft, as the plan drew it. Geometry and
        # timing both, so the day can replay it without building anything.
        self.boarding = self.alighting = None
        self.landing_index = next((index for index, phase in enumerate(phases) if phase.stage == "landing"), None)
        # The corridor the aircraft would leave to hold: the last airborne phase
        # before the vertical landing.
        self.descent_index = next((index for index in range(len(phases) - 1, -1, -1)
                                   if phases[index].stage in ("descent", "cruise", "climb")), None)
        self.distance_m = sum(phase.distance_m for phase in phases)
        self.duration_s = sum(phase.duration_s for phase in phases)
        # Set by the builder: a corridor made up because nothing joined the decks.
        self.direct = False

    def elapsed_at(self, index, elapsed):
        """Seconds into the flight, counting the phases already flown.

        A hold is inserted into the route as it is granted, so this counts the
        wait as part of the flight — which is what it is. The share it gives is
        against the route as it now stands, not as it was first built.
        """
        index = max(0, min(index, len(self.phases)))
        return sum(phase.duration_s for phase in self.phases[:index]) + max(0.0, float(elapsed))

    def share_at(self, index, elapsed):
        """How far through the flight, 0 at the stand and 1 on the far stand."""
        if self.duration_s <= 0:
            return 1.0 if index >= len(self.phases) else 0.0
        return min(1.0, max(0.0, self.elapsed_at(index, elapsed) / self.duration_s))

    def remaining_to_touchdown(self, index, elapsed):
        """Seconds from here to the wheels being on the pad."""
        if self.landing_index is None or index > self.landing_index:
            return 0.0
        total = max(0.0, self.phases[index].duration_s - elapsed)
        for phase in self.phases[index + 1:self.landing_index + 1]:
            total += phase.duration_s
        return total


class Aircraft:
    """One airframe through the day: where it is and what it is doing."""

    __slots__ = ("aircraft_id", "seats", "seat_class", "asset_id", "type_id", "label",
                 "vertiport", "stand", "latitude", "longitude", "altitude", "heading",
                 "phase", "flight", "route", "index", "elapsed", "ready_s", "flights",
                 "next_flight", "clearance", "hold", "hold_seconds", "completed", "cancelled",
                 "energy", "passengers", "speed_mps", "climb_mps", "placed_altitude",
                 "hold_slot", "telemetry", "pilot_active", "external",
                 "failed", "trail", "trail_flight", "unloading", "departed_s", "instruction", "ground",
                 "gate_revision")

    def __init__(self, record):
        cabin = flight_schedule.seat_class(record["seats"])
        self.telemetry, self.pilot_active, self.failed = {}, False, False
        # Set while a person is flying this airframe instead of the model. See
        # `manual_takeover`: position comes from them, clearances are asked for.
        self.external = None
        self.instruction = {}
        self.ground, self.gate_revision = None, 0
        # Where it has been on the flight it is flying, and the people still
        # getting off the one it just finished.
        self.trail, self.trail_flight, self.unloading, self.departed_s = [], None, None, None
        self.aircraft_id = record["aircraft_id"]
        self.seats, self.seat_class = record["seats"], cabin["seats"]
        self.asset_id, self.type_id, self.label = cabin["asset_id"], record["type_id"], cabin["label"]
        self.vertiport, self.stand = record["home"], record["stand"]
        self.latitude = self.longitude = self.altitude = 0.0
        self.heading, self.speed_mps = None, 0.0
        # How fast it is going up or down, and the height it was last placed at.
        # Without this an extrapolation of the aircraft is level by construction:
        # a climb or a descent is in the path the engine walks, not in anything
        # the aircraft carries, so nothing downstream can see one coming.
        self.climb_mps = 0.0
        self.placed_altitude = None
        self.phase, self.flight, self.route = PHASE_PARKED, None, None
        self.index, self.elapsed, self.ready_s = 0, 0.0, 0.0
        self.flights, self.next_flight = list(record["flights"]), 0
        self.clearance, self.hold, self.hold_seconds = None, None, 0.0
        self.hold_slot = None
        self.completed, self.cancelled = 0, 0
        self.energy, self.passengers = BatteryState(energy_profile(self.seats)), 0

    @property
    def battery_pct(self):
        return self.energy.soc_pct

    @battery_pct.setter
    def battery_pct(self, value):
        self.energy.soc_pct = max(0.0, min(100.0, float(value)))

    @property
    def airborne(self):
        return self.phase not in GROUND_PHASES

    @property
    def finished(self):
        """Every flight this airframe had for the day has been flown."""
        return self.next_flight >= len(self.flights) and self.flight is None

    def place(self, latitude, longitude, altitude, heading=None, step=None):
        # A step says how long it took to get here, which is what turns two
        # heights into a rate. A placement with no step -- a reset, a stand --
        # is not motion and leaves the rate alone.
        if step and step > 0 and self.placed_altitude is not None:
            self.climb_mps = (altitude - self.placed_altitude) / step
        self.latitude, self.longitude, self.altitude = latitude, longitude, altitude
        self.placed_altitude = altitude
        if heading is not None:
            self.heading = heading

    def remember(self, now):
        """Keep this position on the track of the flight being flown.

        A point earns its place by distance or by time, so a hold adds a handful
        of points rather than one per step, and a cruise keeps enough of them to
        draw a line. The oldest go first if a flight somehow outruns the buffer.
        """
        if self.flight is None:
            return
        trail = self.trail
        if trail:
            last = trail[-1]
            moved = flight_plan.haversine_m((last[1], last[2]), (self.latitude, self.longitude))
            if moved < TRAIL_STEP_M and (now - last[0]) < TRAIL_STEP_S:
                return
        trail.append((round(float(now), 1), self.latitude, self.longitude, self.altitude))
        if len(trail) > TRAIL_POINTS:
            del trail[:len(trail) - TRAIL_POINTS]


class ScenarioEngine:
    """The day, and the clock that walks through it.

    `vertiports` and `network` are what the twin has placed; `elevation` answers
    metres above the ellipsoid under a point when the workspace has a terrain
    package, and is optional. Nothing here reads a file or a socket.
    """

    def __init__(self, schedule, *, vertiports, network, elevation=None, sequencer=None, pilots=None, policy=None,
                 provisional_names=(), profile=None, ground_control=None, on_prepare=None,
                 vertiport_operators=None):
        self.pilots = pilots
        self.ground_control = ground_control
        # How fast every flight of the day is flown, as the pilot set it. Read
        # once when the day is set out, so a day does not change speed halfway.
        self._profile = profile() if callable(profile) else profile
        self.schedule = schedule
        self._vertiports = {record["id"]: record for record in vertiports if record.get("id")}
        self._network = network
        self._provisional_names = tuple(provisional_names)
        self._elevation = elevation
        # What the operator has moved on the decision charts, or the values the
        # code was written with. Read once here so a day plays with one set of
        # rules from start to finish; changing them mid-day would make the
        # first half and the second half two different rehearsals.
        self.policy = decision_policy.validate(policy)
        self._policy_id = hashlib.sha256(json.dumps(self.policy, sort_keys=True).encode()).hexdigest()[:16]
        self.vertiport_operators = vertiport_operators
        self.psu = sequencer or psu_sequencing.PsuSequencer(
            stands=self._stands_of, tuning=psu_sequencing.Tuning(**self.policy["psu"]))
        if self.vertiport_operators is not None:
            self.psu.attach_vertiports(self.vertiport_operators, now_s=float(schedule["window"]["start_s"]))
        self._deck_heights = {}
        self._routes = {}
        self._route_order = []
        self._corridors = self._corridor_bearings()
        self._holds = {}
        self._supplied_routes = {}
        for flight in schedule["flights"]:
            if flight.get("route_path") is not None and not flight.get("route_error"):
                try:
                    key = tuple(flight["route_path"])
                    if key not in self._supplied_routes:
                        self._supplied_routes[key] = scheduled_route.resolve(self._network, key,
                            f"fato:{flight['origin']}:{flight['departure_fato']}",
                            f"fato:{flight['destination']}:{flight['arrival_fato']}", provisional_names)
                except ValueError as error:
                    flight["route_error"] = f"{flight['flight_id']}: {error}"
                    schedule["problems"].append(flight["route_error"])
                    schedule["problem_count"] += 1
                if tuple(flight.get("route_path") or ()) in self._supplied_routes:
                    flight["provisional_waypoints"] = self._supplied_routes[tuple(flight["route_path"])].get("provisional_waypoints", [])
        self.flights = {flight["flight_id"]: flight for flight in schedule["flights"]}
        self.aircraft = {record["aircraft_id"]: Aircraft(record) for record in schedule["aircraft"]}
        self.time_s = float(schedule["window"]["start_s"])
        self.opens_s = float(schedule["window"]["start_s"])
        self.closes_s = float(schedule["window"]["end_s"])
        self.events = []
        self.problems = []
        self.direct_flights = 0
        self.started = False
        self._active_pads = _ActivePadView(self)
        self.reset()
        self._warm_entry_estimates(on_prepare)

    # ---- setting the day out ----------------------------------------------
    def reset(self):
        """Put every aircraft back on the stand it starts the day on."""
        self.close()
        self.initial_state = flight_schedule.initial_state(
            self.schedule, {key: self._stands_of(key) for key in self._vertiports})
        placements = {item["aircraft_id"]: item for item in self.initial_state["placements"]}
        if self.vertiport_operators is not None:
            # Reset rewinds scenario time.  Drop the PSU's old-day cache before
            # operators publish the new opening observation; otherwise the new
            # report is correctly dated in the past relative to the old clock
            # and would be rejected as stale.
            self.psu.resource_monitor.clear()
            self.vertiport_operators.reset_observations(self.opens_s)
        self.psu.reset()
        if self.ground_control:
            self.ground_control.reset()
            self._configure_ground_routes()
        self.time_s = self.opens_s
        self.events, self.problems = [], []
        self.direct_flights = 0
        self._holds = {}
        self._entry_forecasts = {}
        self._arrival_reviews = {}
        self._legacy_active_pads = {}
        self._terminal = TerminalReservations(self.policy['psu']['terminal_horizontal_m'],
                                               self.policy['psu']['terminal_vertical_m'],
                                               self.policy['psu'].get('terminal_separation', True),
                                               assume_mixed_separated=self.policy['psu'].get('assume_mixed_separated', True),
                                               assume_distinct_fatos_separated=self.policy['psu'].get('assume_distinct_fatos_separated', True))
        self._assignment_options, self._assigned_plans, self._decision_states = {}, {}, {}
        self._event_sequence = 0
        self.started = False
        for record in self.schedule["aircraft"]:
            aircraft = self.aircraft[record["aircraft_id"]]
            aircraft.telemetry, aircraft.pilot_active, aircraft.failed = {}, False, False
            aircraft.ground, aircraft.gate_revision, aircraft.instruction = None, 0, {}
            aircraft.external = None
            aircraft.phase, aircraft.flight, aircraft.route = PHASE_PARKED, None, None
            aircraft.index, aircraft.elapsed = 0, 0.0
            aircraft.next_flight, aircraft.completed, aircraft.cancelled = 0, 0, 0
            aircraft.clearance, aircraft.hold, aircraft.hold_seconds = None, None, 0.0
            aircraft.hold_slot = None
            aircraft.ready_s = self.opens_s
            aircraft.energy, aircraft.passengers = BatteryState(energy_profile(aircraft.seats)), 0
            aircraft.trail, aircraft.trail_flight = [], None
            aircraft.unloading, aircraft.departed_s = None, None
            assignment = placements[aircraft.aircraft_id]
            aircraft.vertiport, aircraft.stand = assignment["vertiport_id"], assignment["stand_id"]
            spot = self._stand_place(aircraft.vertiport, aircraft.stand)
            aircraft.place(spot[0], spot[1], spot[2], spot[3])
            aircraft.speed_mps = aircraft.climb_mps = 0.0
            self.psu.take_stand(aircraft.vertiport, aircraft.stand, aircraft.aircraft_id)
        return self

    def close(self):
        if self.pilots:
            self.pilots.close()

    def _layout(self, vertiport_id):
        return (self._vertiports.get(vertiport_id) or {}).get("layout") or {}

    def _stands_of(self, vertiport_id):
        return [gate["id"] for gate in self._layout(vertiport_id).get("gates") or ()]

    # The simulation supplies observations; the facility operator owns the
    # resource projection and reports it; PSU decisions read the report.  The
    # legacy table exists only for callers that have not composed operators.
    def _active_pad_items(self):
        if self.psu.resource_monitor is not None:
            return tuple(self.psu.fato_occupants(self.time_s).items())
        return tuple(self._legacy_active_pads.items())

    def _active_pad_owner(self, pad):
        if self.psu.resource_monitor is not None:
            resource = self.psu.resource_monitor.resource(pad[0], "fato", pad[1], self.time_s)
            return resource.occupant_id if resource else None
        return self._legacy_active_pads.get(pad)

    def _observe_pad_occupied(self, pad, flight_id, now_s):
        if self.vertiport_operators is not None:
            self.vertiport_operators.observe_occupancy(
                pad[0], "fato", pad[1], flight_id, now_s=now_s)
        else:
            self._legacy_active_pads[pad] = flight_id

    def _release_pad_observation(self, pad, flight_id=None, now_s=None):
        owner = self._active_pad_owner(pad)
        if owner is None or flight_id is not None and owner != flight_id:
            return False
        if self.vertiport_operators is not None:
            self.vertiport_operators.observe_occupancy(
                pad[0], "fato", pad[1], None, now_s=self.time_s if now_s is None else now_s)
        else:
            self._legacy_active_pads.pop(pad, None)
        return True

    def _release_pads_by_owner(self, flight_id, now_s):
        for pad, owner in self._active_pad_items():
            if owner == flight_id:
                self._release_pad_observation(pad, flight_id, now_s)

    def _configure_ground_routes(self):
        if not hasattr(self.ground_control,'configure_routes'): return
        for port in self._vertiports:
            layout=self._layout(port)
            endpoints=self._stands_of(port)+[p['id'] for p in layout.get('fatos',())]
            paths=[]
            for i,first in enumerate(endpoints):
                for second in endpoints[i+1:]:
                    taxi=flight_plan.taxi_path(layout,first,second)
                    if taxi and len(taxi['points'])>1:
                        points,_,_,_=ground_motion.prepare(taxi['points'],4,0)
                        paths.append(tuple(self._ground_xy(port,p) for p in points))
            self.ground_control.configure_routes(port,paths)

    def _deck_height(self, vertiport_id):
        if vertiport_id in self._deck_heights:
            return self._deck_heights[vertiport_id]
        layout = self._layout(vertiport_id)
        frame = layout.get("frame") or {}
        platform = layout.get("platform") or {}
        reference = layout.get("ground_reference", "highest")
        if reference == "manual":
            ground = float(frame.get("altitude_m") or 0.0)
        else:
            points = [(0.0, 0.0)]
            corners = platform.get("corners_m") or []
            if len(corners) == 4:
                a, b, _, d = corners
                points += [(a[0]+i/4*(b[0]-a[0])+j/4*(d[0]-a[0]),
                            a[1]+i/4*(b[1]-a[1])+j/4*(d[1]-a[1])) for i in range(5) for j in range(5)]
            points += [x["center_m"] for x in [*layout.get("fatos", ()), *layout.get("gates", ())]]
            heights = [self._ground_height(*flight_plan._local_to_global(frame, *point), 0.0)
                       for point in points]
            ground = min(heights) if reference == "lowest" else (
                sum(heights) / len(heights) if reference == "mean" else max(heights))
        height = ground + float(platform.get("height_m") or 0.0)
        self._deck_heights[vertiport_id] = height
        return height

    def _stand_place(self, vertiport_id, stand_id):
        """Authored gate centre; layout coordinates are already heading-rotated."""
        layout = self._layout(vertiport_id)
        frame = layout.get("frame") or {}
        gate = next((item for item in layout.get("gates", ()) if item.get("id") == stand_id), None)
        if gate is None:
            raise ValueError(f"{vertiport_id}: Gate {stand_id}가 실제 레이아웃에 없습니다")
        latitude, longitude = flight_plan._local_to_global(frame, *gate["center_m"])
        heading = float(frame.get("heading_deg") or 0.0)
        fato = flight_plan._fato_for(layout, "takeoff")
        taxi = flight_plan.taxi_path(layout, stand_id, fato) if fato else None
        if taxi and len(taxi["points"]) > 1:
            heading = _bearing(taxi["points"][0], taxi["points"][1])
        return latitude, longitude, self._deck_height(vertiport_id), heading

    def _nearby_pads(self, vertiport_id, first, second):
        if first == second:
            return True
        pads={p['id']:p['center_m'] for p in self._layout(vertiport_id).get('fatos',())}
        # How close two pads on one deck are before one in use closes the
        # other. This is the PSU's own number: it used to borrow the pilot's
        # en-route traffic distance, and at 120 m that made every pad on a
        # four-FATO deck (36 m pitch, 108 m end to end) adjacent to every
        # other, so the deck could never run two operations at once.
        limit=self.policy['psu'].get('pad_adjacency_m')
        if limit is None:limit=self.policy['pilot']['traffic_horizontal_m']
        return (first in pads and second in pads and
                math.dist(pads[first],pads[second]) < limit)

    def _ground_height(self, latitude, longitude, fallback):
        """Metres above the ellipsoid under a point, or the fallback.

        The elevation source answers either a number or a (height, coverage)
        pair — the local terrain package uses the pair to say how much of the
        point it actually covers, and a weight of zero means it has no data
        there. Either shape is accepted, and no coverage falls back rather than
        putting a corridor at sea level over a hill.
        """
        if self._elevation is None:
            return fallback
        try:
            sampled = self._elevation(longitude, latitude)
        except Exception:  # An optional terrain package must never stop the day.
            return fallback
        if isinstance(sampled, (tuple, list)):
            if len(sampled) < 2 or not sampled[1]:
                return fallback
            sampled = sampled[0]
        try:
            height = float(sampled)
        except (TypeError, ValueError):
            return fallback
        return height if math.isfinite(height) else fallback

    def _resolve(self, altitude, datum, latitude, longitude, decks):
        """A planned height against its datum, as metres above the ellipsoid."""
        if datum == flight_plan.MSL:
            return float(altitude)
        if isinstance(datum, str) and datum.startswith("deck:"):
            return self._deck_height(datum.split(":", 1)[1]) + float(altitude)
        return self._ground_height(latitude, longitude, decks) + float(altitude)

    # ---- routes ------------------------------------------------------------
    def _corridor_bearings(self):
        """Which way the corridors leave and enter each deck.

        A holding aircraft must not sit in one. The network's links are directed,
        so a link out of a vertiport's FATO is a departure bearing and a link
        into one is an arrival bearing; both are kept and both are avoided.
        """
        places = {}
        for node in (self._network or {}).get("nodes") or ():
            places[node["id"]] = (float(node["latitude"]), float(node["longitude"]))
        fatos = {}
        for fato in (self._network or {}).get("fatos") or ():
            places[fato["id"]] = (float(fato["latitude"]), float(fato["longitude"]))
            fatos[fato["id"]] = fato.get("vertiport")
        bearings = {}
        for link in (self._network or {}).get("links") or ():
            start, end = link.get("from"), link.get("to")
            if start not in places or end not in places:
                continue
            for node, other in ((start, end), (end, start)):
                vertiport = fatos.get(node)
                if vertiport:
                    bearings.setdefault(vertiport, set()).add(round(_bearing(places[node], places[other])))
        return bearings

    def route(self, flight):
        """The geometry this flight flies, built on first use and then shared."""
        key = (flight["origin"], flight["destination"], flight["departure_stand"],
               flight["arrival_stand"], flight["seat_class"], tuple(flight.get("route_path") or ()),
               flight.get("departure_fato"), flight.get("arrival_fato"),
               # How many people board is part of the geometry: the aircraft
               # waits on its stand until the last of them is aboard, so two
               # flights carrying different loads do not share a taxi.
               min(int(flight.get("passengers") or 0), int(flight.get("seats") or 0) or 1,
                   flight_plan.MAXIMUM_SEATS))
        found = self._routes.get(key)
        if found is not None:
            return found
        route = self._build_route(flight, key)
        self._routes[key] = route
        self._route_order.append(key)
        while len(self._route_order) > ROUTE_CACHE:
            self._routes.pop(self._route_order.pop(0), None)
        return route

    def _build_route(self, flight, key):
        if flight.get("route_error"):
            raise ValueError(flight["route_error"])
        records = list(self._vertiports.values())
        cabin = flight_schedule.seat_class(flight["seats"])
        request = {
            "from_vertiport": flight["origin"], "to_vertiport": flight["destination"],
            "from_gate": flight["departure_stand"] or None, "to_gate": flight["arrival_stand"] or None,
            "visual_asset_id": cabin["asset_id"],
            "from_fato": flight.get("departure_fato"), "to_fato": flight.get("arrival_fato"),
            # The cabin the schedule gave this flight, and the people it put in
            # it. Both go to the plan, so the walk on and off is the flight's
            # own load rather than a stand-in airframe's.
            "seat_capacity": min(int(flight["seats"] or 0) or 1, flight_plan.MAXIMUM_SEATS),
            "passengers": min(flight["passengers"], int(flight["seats"] or 0) or 1,
                              flight_plan.MAXIMUM_SEATS),
            "battery_start_pct": flight_plan.DEFAULT_BATTERY_START_PCT,
            "charge_target_pct": flight_plan.DEFAULT_CHARGE_TARGET_PCT,
        }
        supplied = self._supplied_routes.get(tuple(flight.get("route_path") or ()))
        if flight.get("route_path") is not None and supplied is None:
            raise ValueError("지정된 route_path를 해석하지 못했습니다")
        # Old CSVs may omit route_path. Resolve those against the drawn network,
        # but never invent a direct flight when the network cannot join them.
        plan = flight_plan.build_plan(request, records, self._network,
            supplied_air_path=supplied, profile=self._profile)
        decks = (self._deck_height(flight["origin"]) + self._deck_height(flight["destination"])) / 2.0
        phases = []
        for leg in plan["legs"]:
            if leg["stage"] == "charge":
                continue  # The turnaround is the schedule's business, not the plan's.
            points = [(point[1], point[0], self._resolve(point[2], point[3], point[1], point[0], decks))
                      for point in leg["path"]]
            offset = 0.0
            if leg["stage"] == "cruise":
                widths = [float(link.get("width_m") or 300.0) for link in (supplied or {}).get("links", ()) if link.get("segment") == "F"]
                offset = min(scheduled_route.RIGHT_OFFSET_M, min(widths, default=300.0)/4)
                points = scheduled_route.right_cruise(points, offset)
            speed, duration = leg["speed_mps"], leg["duration_s"]
            phases.append(Phase(leg["stage"], leg["name"], points, duration, speed or leg["speed_mps"],
                                {"segment": leg.get("segment"), "right_offset_m": offset,
                                 "right_room_m": max(0.0, min(widths, default=300.0)/2-offset-20.0) if leg["stage"] == "cruise" else 0.0,
                                 "supplied_waypoints": leg.get("waypoints", []),
                                 "taxi_nodes": leg.get("taxi_nodes", []),
                                 # Where the rotors point through this stage, so
                                 # a flight nobody is measuring still reports the
                                 # mode it is being flown in.
                                 "tilt": (leg.get("tilt_start_deg", 0.0), leg.get("tilt_end_deg", 0.0)),
                                 "ground_motion": leg.get("ground_motion")}))
        route = Route(key, phases, plan["arrival"], plan["departure"])
        route.direct = bool(plan.get("direct"))
        # The walk on and off, drawn by the plan against these two stands.
        route.boarding, route.alighting = plan.get("boarding"), plan.get("alighting")
        return route

    # ---- the clock ---------------------------------------------------------
    def advance(self, to_s):
        """Step the world forward to this scenario second.

        Time only goes forwards. Rewinding is `reset()` and running again, which
        is the only way that keeps the sequence honest: a service that has
        already given somebody landing number 4 cannot un-give it.
        """
        to_s = float(to_s)
        if to_s <= self.time_s:
            return self
        self.started = True
        while self.time_s < to_s:
            step = min(STEP_SECONDS * 5, to_s - self.time_s)
            self.time_s += step
            self._step(self.time_s, step)
        return self

    def _step(self, now, step):
        # Derived scalar results live only within this locked logical step.
        # Repeated departure candidates inspect identical fleet observations.
        self._remaining_step_cache = {}
        try:
            return self._step_observations(now, step)
        finally:
            self._remaining_step_cache = None

    def _step_observations(self, now, step):
        # All decisions use the same completed fleet observation, before workers
        # advance any aircraft. This avoids fleet-order-dependent traffic checks.
        if self.psu.resource_monitor is not None:
            self.psu.resource_monitor.advance(now)
        if self.vertiport_operators is not None:
            self.vertiport_operators.heartbeat(now)
        if self.pilots:
            self._refresh_predictions(now)
        # A submitted human request remains queued without another click.
        # Process permissions only; external pose and controls remain untouched.
        for aircraft in self.aircraft.values():
            if aircraft.external:
                manual_takeover.advance_request(self, aircraft, now)
        self._native_batch = [] if self.pilots and hasattr(self.pilots, "submit") else None
        starting = set()
        for aircraft in self.aircraft.values():
            scenario_energy.advance(self, aircraft, now, step)
            # An airframe someone is flying is not started by the schedule and
            # is not walked along a route. It still burns energy, still holds
            # the pad it is on, and is still seen by everyone else, because it
            # is where its pilot actually put it.
            if aircraft.external:
                starting.add(aircraft.aircraft_id)
                continue
            if aircraft.phase == PHASE_PARKED:
                unloading = aircraft.unloading
                if unloading and now >= unloading["from_s"] + unloading["duration_s"]:
                    aircraft.unloading, aircraft.passengers = None, 0
                if not aircraft.finished:
                    self._maybe_depart(aircraft, now)
                starting.add(aircraft.aircraft_id)
        ground_observations = tuple(self._ground_observations()) if self.ground_control else None
        if self.ground_control:
            self._ground_permissions(now,ground_observations)
        for aircraft in self.aircraft.values():
            if aircraft.phase == PHASE_PARKED or aircraft.aircraft_id in starting:
                continue
            if not aircraft.failed:
                self._fly(aircraft, now, step,ground_observations)
        # Barrier before the next logical step. Commit in stable fleet order,
        # never on worker threads, so resource arbitration remains deterministic.
        for aircraft, route, target, future in self._native_batch or ():
            try:
                self._observe_native(aircraft, route, target, future.result(), now)
            except (RuntimeError, ValueError, OSError) as problem:
                self._native_failed(aircraft, now, problem)
        self._native_batch = None
        self._audit_clearances(now)

    def _decision(self, now, flight, node, outcome, reason, **detail):
        key = (flight['flight_id'], node)
        state = json.dumps([outcome, reason, detail], sort_keys=True, ensure_ascii=False)
        if self._decision_states.get(key) == state:
            return
        self._decision_states[key] = state
        self._record(now, 'psu_decision', flight, role='psu', node=node,
                     chart_node={'allocate':'allocate', 'arrival_allocate':'allocate', 'terminal_arrival':'terminal',
                                 'terminal_departure':'departure_terminal'}.get(node, 'pad'), outcome=outcome,
                     reason=reason, policy_id=self._policy_id, **detail)

    def _audit_clearances(self, now):
        # Semantic changes only. Numerical ETA revisions remain in the live
        # clearance; they do not masquerade as a new operational decision.
        for c in self.psu._clearances.values():
            if c.released_s is not None or c.flight_id not in self.flights:
                continue
            self._decision(now, self.flights[c.flight_id], 'slot_' + c.kind, c.state, c.reason,
                vertiport=c.vertiport, fato=c.fato, stand=c.stand, sequence=c.sequence)

    def _terminal_release(self, aircraft, kind, now):
        if self._terminal.release(aircraft.flight['flight_id'], kind):
            self._decision(now, aircraft.flight, 'terminal_' + kind, 'released', '관측된 구간 이탈',
                vertiport=aircraft.flight['origin' if kind == 'departure' else 'destination'],
                fato=aircraft.flight[kind + '_fato'])

    def _resource_departure_blockers(self, flight, route=None):
        blocked = []
        if self.psu.resource_monitor is not None:
            resource = self.psu.resource_monitor.resource(
                flight['origin'], 'fato', flight['departure_fato'], self.time_s)
            if resource is None or not resource.usable:
                blocked.append({'flight_id': f"resource:{flight['origin']}:{flight['departure_fato']}",
                                'reason': 'fato_unavailable',
                                'vertiport': flight['origin'], 'fato': flight['departure_fato']})
        return blocked

    def _departure_blockers(self, flight, route):
        blocked = self._terminal.blockers(flight, route, 'departure')
        blocked.extend(self._resource_departure_blockers(flight, route))
        for (place, pad), owner in self._active_pad_items():
            if (place == flight['origin'] and owner != flight['flight_id']
                    and self._nearby_pads(place, flight['departure_fato'], pad)):
                blocked.append({'flight_id': owner, 'reason': 'pad_occupied', 'vertiport': place, 'fato': pad})
        if self.policy['psu']['predictive_arrivals'] and self._terminal.enabled:
            # A stream of taxi-out reservations must not starve a usable
            # arrival. Yield only to observed holding traffic with a secured
            # exit; blocked/full gates must still be allowed to drain.
            for a in self.aircraft.values():
                c = a.clearance
                if (not a.airborne or a.failed or not c or c.released_s is not None
                        or c.state == psu_sequencing.REFUSED or c.stand is None or c.approach_s is None
                        or a.hold_seconds < max(self.psu.tuning.landing_separation_s,
                                               self.psu.tuning.mixed_separation_s)):
                    continue
                assignment=self.psu.waiting.reservations.get(c.flight_id)
                if c.approach_started_s is None and (
                        c.approach_s>self.time_s+.5 or
                        assignment and (assignment['state']!='holding' or not self._queue_return_clear(a)) or
                        not assignment and a.instruction.get('action') in ('yield','wait_clear')):
                    # An unexecutable waiting flight cannot prevent the ground
                    # departure that would make its arrival resources available.
                    continue
                if (self._terminal.assume_distinct_fatos_separated
                        and flight['origin'] == c.vertiport and flight['departure_fato'] != c.fato):
                    continue
                overlap = self._terminal.overlap(route,'departure',a.route,'arrival')
                if overlap:
                    blocked.append(dict(overlap,flight_id=c.flight_id,reason='waiting_arrival_priority',
                                        vertiport=c.vertiport,fato=c.fato))
        return blocked

    def _select_fatos(self, flight, now):
        identifier = flight['flight_id']
        if identifier in self._assigned_plans:
            selected, route = self._assigned_plans[identifier]
            aircraft = self.aircraft[flight['aircraft_id']]
            # Entry metering is a forecast, not a taxi/departure authority.
            # A pad claimed while we wait on stand must not freeze us behind
            # it when another connected departure pad is actually available.
            # Keep the arrival pad and the booking's queue position unchanged.
            if (self.pilots and identifier in self._entry_forecasts
                    and aircraft.flight is None and not aircraft.pilot_active
                    and self.psu.clearance(identifier, psu_sequencing.DEPARTURE) is None
                    and self._departure_blockers(selected, route)):
                key = (identifier, flight['departure_stand'])
                if key not in self._assignment_options:
                    self._assignment_options[key] = fato_assignment.options(self, flight)
                alternatives = [(f,r) for f,r in self._assignment_options[key][0]
                    if f['arrival_fato'] == selected['arrival_fato']
                    and f['departure_fato'] != selected['departure_fato']
                    and not self._departure_blockers(f,r)
                    # New parallel departures need a genuinely separate exit,
                    # not just a different pad label. Distinct-FATO assumptions
                    # cannot prove separation at a shared climb/merge waypoint.
                    and not any(owner!=identifier and kind=='departure'
                        and self._terminal.overlap(r,'departure',claim['route'],'departure')
                        for (owner,kind),claim in self._terminal.claims.items())]
                if alternatives:
                    replacement, alternative, _ = fato_assignment.choose(alternatives,self.psu,now,[],
                        self._departure_blockers,entry_wait=lambda f,r,t:self._preview_arrival_entry(
                            aircraft,f,r,t,cached_only=True)['departure_s']-t)
                    self._assigned_plans[identifier] = (replacement, alternative)
                    self._decision(now,replacement,'allocate','selected','출발 허가 전 빈 FATO 재배정 · 도착 순서 유지',
                        previous_departure_fato=selected['departure_fato'],
                        departure_fato=replacement['departure_fato'],arrival_fato=replacement['arrival_fato'])
                    return replacement, alternative
            return selected, route
        key = (identifier, flight['departure_stand'])
        if key not in self._assignment_options:
            self._assignment_options[key] = fato_assignment.options(self, flight)
        available, rejected = self._assignment_options[key]
        forecasts = [{'flight_id': a.flight['flight_id'], 'vertiport': a.flight['destination'],
                      'fato': a.flight['arrival_fato'], 'eta_s': now + (self._remaining_native(a) if self.pilots
                          else a.route.remaining_to_touchdown(a.index, a.elapsed))}
                     for a in self.aircraft.values() if a.flight and a.route and not a.failed
                     and a.index <= a.route.landing_index]
        selected, route, assessment = fato_assignment.choose(available, self.psu, now, forecasts,
            self._departure_blockers if self.pilots else self._resource_departure_blockers,
            entry_wait=(lambda f,r,t: self._preview_arrival_entry(
                self.aircraft[f['aircraft_id']],f,r,t,cached_only=True)['departure_s']-t) if self.pilots else None)
        self._decision(now, selected, 'allocate', 'selected', '연결 항로와 FATO별 출발 및 진입 대기 비교',
            departure_fato=selected['departure_fato'], arrival_fato=selected['arrival_fato'],
            planned_departure_fato=flight['departure_fato'], planned_arrival_fato=flight['arrival_fato'],
            eligible_count=len(available), rejected=rejected,
            blocked_by=[r['flight_id'] for r in assessment['blockers']])
        return selected, route

    def _maybe_depart(self, aircraft, now):
        """Start the next flight once its off-block time has come round."""
        if aircraft.next_flight >= len(aircraft.flights):
            return
        flight = self.flights.get(aircraft.flights[aircraft.next_flight])
        if flight is None:
            aircraft.next_flight += 1
            return
        priority=manual_takeover.initial_departure_owner(self,flight['origin'],now,
            destination=flight['destination'],arrival_fato=flight.get('arrival_fato'))
        if priority and priority!=aircraft.aircraft_id:
            aircraft.instruction={'action':'departure_wait','reason':f'초기 수동 출발편 {priority} 우선 배정',
                                  'blocked_by':[priority]}
            return
        booked=getattr(self,'_entry_forecasts',{}).get(flight['flight_id'])
        if booked and now<booked['departure_s']:
            aircraft.instruction={'action':'departure_wait','reason':f"도착 {flight['destination']} / {flight['arrival_fato']} 진입 순서 대기 (주기장 유지)",
                                  'entry_s':booked['entry_s'],'ready_s':booked['departure_s']}
            return
        if now < flight["off_block_s"] or now < aircraft.ready_s:
            aircraft.instruction = {'action':'departure_wait', 'reason':
                '회항 준비 완료 대기' if now < aircraft.ready_s else '계획 출발 시각 대기'}
            return
        try:
            if aircraft.vertiport != flight["origin"]:
                raise ValueError("기체의 현재 버티포트와 출발지가 다릅니다. 재배치 비행이 필요합니다")
            # The imported plan remains immutable; fly from the actually assigned stand.
            flight = dict(flight, departure_stand=aircraft.stand)
            flight, route = self._select_fatos(flight, now)
        except ValueError as problem:
            # A pair the network does not join cannot be flown. The flight is
            # dropped by name, and the aircraft waits for its next one.
            self.problems.append(f"{flight['flight_id']}: {problem}")
            self._record(now, "cancelled", flight, reason=str(problem))
            aircraft.next_flight += 1
            aircraft.cancelled += 1
            return
        departure_resource = (self.psu.resource_monitor.resource(
            flight['origin'], 'fato', flight['departure_fato'], now)
            if self.psu.resource_monitor is not None else None)
        if self.psu.resource_monitor is not None and (
                departure_resource is None or not departure_resource.usable):
            aircraft.instruction = {'action': 'departure_wait',
                                    'reason': '버티포트 보고상 출발 FATO 사용 불가'}
            self._decision(now, flight, 'departure_slot', 'hold', aircraft.instruction['reason'],
                           vertiport=flight['origin'], fato=flight['departure_fato'])
            return
        if self.pilots:
            if not self._meter_arrival_entry(aircraft,flight,route,now):return
            pad = (flight["origin"], route.departure.get("fato") or flight["departure_fato"])
            blockers = self._departure_blockers(flight, route)
            if blockers:
                priority = any(b['reason']=='waiting_arrival_priority' for b in blockers)
                if priority:
                    self.psu.pad(*pad).release(flight['flight_id'])
                self._decision(now, flight, 'terminal_departure', 'hold',
                               '대기 도착편 우선 · 지상 출발 순서 조정' if priority else '이륙 경로 또는 패드 점유',
                               vertiport=pad[0], fato=pad[1], blockers=blockers)
                aircraft.instruction = {'action':'departure_wait', 'reason':
                    '대기 도착편 우선 · 지상 출발 순서 조정' if priority else '이륙 경로 또는 패드 점유',
                    'blocked_by':sorted({self.flights.get(b['flight_id'],{}).get('aircraft_id',b['flight_id']) for b in blockers})}
                return
            taxi_s = route.phases[0].duration_s if route.phases[0].stage == "gate_out" else 0.0
            if self.policy['psu']['predictive_arrivals']:
                # Do not occupy the shared pad during taxi-out if a committed
                # arrival will need it before this departure can clear it.
                clear_s = now + taxi_s + sum(p.duration_s for p in route.phases if p.stage == 'takeoff')
                clear_s += self.psu.tuning.mixed_separation_s
                if any(c.kind == psu_sequencing.ARRIVAL and c.vertiport == pad[0] and self._nearby_pads(pad[0],pad[1],c.fato)
                       and c.released_s is None and c.approach_started_s is not None
                       and (c.eta_s if c.eta_s is not None else c.cleared_s) <= clear_s
                       for c in self.psu._clearances.values()):
                    aircraft.instruction = {'action':'departure_wait','reason':'진입한 도착편의 공용 패드 이탈 대기'}
                    self._decision(now,flight,'departure_slot','hold',aircraft.instruction['reason'],vertiport=pad[0],fato=pad[1])
                    return
            permit = self.psu.request_departure(flight_id=flight["flight_id"], vertiport=pad[0],
                fato=pad[1], earliest_s=now+taxi_s, now_s=now)
            self._assigned_plans[flight['flight_id']] = (flight, route)
            earliest = self.psu.pad(*pad).earliest(now+taxi_s, psu_sequencing.DEPARTURE,
                self.psu.tuning.departure_separation_s, exclude=flight['flight_id'])
            if now+taxi_s < max(permit.cleared_s, earliest):
                aircraft.instruction = {'action':'departure_wait','reason':'공용 패드 운항 간격'}
                self._decision(now, flight, 'departure_slot', 'hold', '공용 패드 운항 간격',
                               vertiport=pad[0], fato=pad[1])
                return
            self._terminal.acquire(flight, route, 'departure')
            self._decision(now, flight, 'terminal_departure', 'granted', '이륙 경로 예약',
                           vertiport=pad[0], fato=pad[1])
            self._observe_pad_occupied(pad, flight["flight_id"], now)
        self._assigned_plans.pop(flight['flight_id'], None)
        self._assignment_options.pop((flight['flight_id'], flight['departure_stand']), None)
        scenario_energy.depart(self, aircraft, flight, now)
        aircraft.flight, aircraft.route = flight, route
        if route.direct:
            self.direct_flights += 1
        aircraft.index, aircraft.elapsed = 0, 0.0
        aircraft.phase = route.phases[0].stage if route.phases else PHASE_PARKED
        aircraft.clearance, aircraft.hold = None, None
        aircraft.instruction = {}
        aircraft.passengers = flight["passengers"]
        # A new flight is a new track, and the last one's passengers are long off.
        aircraft.trail, aircraft.trail_flight = [], flight["flight_id"]
        aircraft.unloading, aircraft.departed_s = None, None
        aircraft.remember(now)
        aircraft.next_flight += 1
        self._record(now, "taxi_requested", flight, direct=route.direct)

    @staticmethod
    def _ground_radius(aircraft):
        # Conservative physical-model footprint; never use camera/LOD scale.
        return 7.0

    def _ground_xy(self, vertiport, point):
        frame = self._layout(vertiport)['frame']
        scale = math.pi*EARTH_RADIUS_M/180
        return ((point[0]-frame['latitude'])*scale,
                (point[1]-frame['longitude'])*scale*math.cos(math.radians(frame['latitude'])))

    def _ground_observations(self):
        result = []
        for aircraft in self.aircraft.values():
            if not aircraft.airborne:
                port = (aircraft.flight['destination' if aircraft.phase == 'gate_in' else 'origin']
                        if aircraft.flight else aircraft.vertiport)
            else:
                # Low takeoff/landing and a failed aircraft near a deck are
                # still obstacles. Phase names cannot erase observed occupancy.
                candidates = (aircraft.flight['origin'],aircraft.flight['destination']) if aircraft.flight else ()
                ports = []
                for candidate in set(candidates):
                    point = self._ground_xy(candidate,(aircraft.latitude,aircraft.longitude))
                    platform = self._layout(candidate).get('platform',{})
                    radius = math.hypot(platform.get('width_m',100),platform.get('length_m',100))/2+20
                    if abs(aircraft.altitude-self._deck_height(candidate)) <= 15 and math.hypot(*point)<=radius:
                        ports.append((math.hypot(*point),candidate))
                if not ports: continue
                port = min(ports)[1]
            result.append(GroundObservation(aircraft.aircraft_id,port,
                self._ground_xy(port,(aircraft.latitude,aircraft.longitude)),self._ground_radius(aircraft)))
        return result

    def _pushback_fits(self, aircraft, path, port):
        """Conservative footprint check before admitting an off-centre manoeuvre."""
        layout=self._layout(port);corners=layout.get('platform',{}).get('corners_m',[])
        if len(corners)<3:return False
        radius=self._ground_radius(aircraft)
        points=[self._ground_xy(port,p) for p in path]
        area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(corners,corners[1:]+corners[:1]))
        sign=1 if area>0 else -1
        for point in points:
            for a,b in zip(corners,corners[1:]+corners[:1]):
                edge=math.dist(a,b)
                if edge<1e-6:return False
                inward=sign*((b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]))/edge
                if inward<radius:return False
        geometry=route_geometry(tuple(points))
        objects=[(o['center_m'],math.hypot(*o['size_m'])/2) for o in layout.get('boarding_points',())]
        objects += [(o['center_m'],o.get('radius_m',1.)) for o in layout.get('chargers',())]
        return not any(geometry.occupied_intervals(route_geometry((tuple(center),)),radius+size)
                       for center,size in objects)

    def _start_ground(self, aircraft, now):
        phase = aircraft.route.phases[aircraft.index]
        profile = phase.detail.get('ground_motion')
        pushback_applied = False
        if phase.stage=='gate_out' and profile:
            points=[(aircraft.latitude,aircraft.longitude),*[p[:2] for p in phase.points[1:]]]
            port=aircraft.flight['origin']
            for side in (1,-1):
                candidate=ground_motion.prepare_pushback(points,aircraft.heading or 0.,max(.1,phase.speed_mps),8,side=side)
                if candidate is None:break
                path,prepared,_,duration=candidate
                if not self._pushback_fits(aircraft,path,port):continue
                detail=deepcopy(phase.detail);detail['ground_motion']=prepared
                fresh=Phase(phase.stage,phase.label,[(p[0],p[1],aircraft.altitude) for p in path],duration,phase.speed_mps,detail)
                self._replace_ground_phase(aircraft,fresh);phase=fresh;profile=prepared
                pushback_applied = True
                break
        if phase.stage == 'gate_out' and profile and not pushback_applied:
            # Keep the authored boarding/stand hold in the departure profile.
            # Re-preparing it with a generic eight-second hold would discard
            # the passenger timing and could let the aircraft roll early.
            detail = deepcopy(phase.detail)
            profile = detail['ground_motion'] = deepcopy(profile)
            leg = {'ground_motion':profile,'duration_s':phase.duration_s}
            ground_motion.align_start(leg,aircraft.heading or 0.0)
            fresh = Phase(phase.stage,phase.label,phase.points,leg['duration_s'],phase.speed_mps,detail)
            self._replace_ground_phase(aircraft,fresh);phase=fresh
        if not profile or aircraft.phase == 'gate_in':
            # Actual touchdown may differ slightly from the planned pad centre.
            # Start there, never jump the state onto the cached taxi geometry.
            points = [(aircraft.latitude,aircraft.longitude),*[p[:2] for p in phase.points[1:]]]
            path, profile, _, duration = ground_motion.prepare(points,max(.1,phase.speed_mps),8)
            detail = deepcopy(phase.detail)
            detail['ground_motion'] = profile
            leg = {'ground_motion':profile,'duration_s':duration}
            ground_motion.align_start(leg,aircraft.heading or 0.0)
            fresh = Phase(phase.stage,phase.label,[(p[0],p[1],aircraft.altitude) for p in path],
                          leg['duration_s'],phase.speed_mps,detail)
            self._replace_ground_phase(aircraft, fresh)
            phase = fresh
        port = aircraft.flight['destination' if phase.stage=='gate_in' else 'origin']
        path = tuple(self._ground_xy(port,p) for p in phase.points)
        aircraft.ground = {'route_id':f"{aircraft.flight['flight_id']}:{phase.stage}:{aircraft.gate_revision}",
            'distance_m':0.0,'path_m':path,'length_m':route_geometry(path).length_m,
            'ready_s':0.0,'end_s':0.0,'wait_s':0.0,'requested_s':now,'vertiport':port,'authority':None}
        aircraft.speed_mps = 0.0

    @staticmethod
    def _replace_ground_phase(aircraft, phase):
        previous = aircraft.route
        phases = list(previous.phases)
        phases[aircraft.index] = phase
        aircraft.route = Route(previous.key,phases,previous.arrival,previous.departure)
        aircraft.route.boarding,aircraft.route.alighting = previous.boarding,previous.alighting
        aircraft.route.direct = previous.direct

    def _ground_permissions(self, now, observations=None):
        observations = tuple(self._ground_observations()) if observations is None else observations
        requests = []
        for aircraft in self.aircraft.values():
            # Human-controlled position is not progress along the automatic route.
            # Keep its actual footprint in observations, but never issue an
            # automatic route authority that disagrees with the pilot's pose.
            if aircraft.external:
                self.ground_control.release(aircraft.aircraft_id)
                aircraft.ground = None
                continue
            if aircraft.phase not in ('gate_out','gate_in') or aircraft.failed or not aircraft.route or not aircraft.flight:
                continue
            if aircraft.phase=='gate_in' and aircraft.speed_mps < .01 and aircraft.clearance:
                self._ensure_arrival_gate(aircraft,now,observations)
            if aircraft.ground is None:
                self._start_ground(aircraft,now)
            ground = aircraft.ground
            phase = aircraft.route.phases[aircraft.index]
            profile = phase.detail.get('ground_motion')
            total = profile['distances_m'][-1] if profile else 0.0
            distance = ground['distance_m']/total*ground['length_m'] if total else 0.0
            ready = not profile or ground['ready_s'] >= profile['times_s'][0]
            requests.append(GroundRequest(aircraft.aircraft_id,aircraft.flight['flight_id'],ground['vertiport'],
                ground['route_id'],ground['path_m'],distance,aircraft.speed_mps,
                phase.speed_mps if ready else 0.0,self._ground_radius(aircraft),ground['requested_s'],
                aircraft.phase=='gate_in'))
        authorities = self.ground_control.authorize(requests,observations,now)
        for aircraft in self.aircraft.values():
            if aircraft.ground:
                aircraft.ground['authority'] = authorities.get(aircraft.aircraft_id)

    def _fly_ground(self, aircraft, now, step,ground_observations=None):
        ground = aircraft.ground
        phase = aircraft.route.phases[aircraft.index]
        if ground is None: return  # A new phase waits for the next fleet permission.
        authority = ground.get('authority')
        if authority is None or authority.route_id != ground['route_id']:
            return
        profile = phase.detail.get('ground_motion')
        if not profile:
            ground['end_s'] += step
            done = ground['end_s'] >= phase.duration_s
        else:
            total = profile['distances_m'][-1]
            initial_hold = profile['times_s'][0]
            if ground['ready_s'] < initial_hold:
                ground['ready_s'] = min(initial_hold,ground['ready_s']+step)
                aircraft.elapsed = ground['ready_s']
                heading = ground_motion.heading_at(profile,0,ground['ready_s'])
                if heading is not None: aircraft.heading = heading
                return
            stop = authority.stop_distance_m/max(ground['length_m'],1e-12)*total
            try:
                ground['distance_m'],aircraft.speed_mps = ground_motion.advance(profile,
                    ground['distance_m'],aircraft.speed_mps,stop,authority.speed_limit_mps,step)
            except ValueError as problem:
                # Do not hide an inconsistent authority with a position jump.
                aircraft.failed = True
                aircraft.instruction = {'action':'ground_wait','reason':'지상 이동권 불일치: '+str(problem),
                                        'blocked_by':list(authority.blocked_by),'updated_s':now}
                self.problems.append(aircraft.aircraft_id+': '+str(problem))
                self._record(now,'ground_control_failed',aircraft.flight,reason=str(problem))
                return
            fraction = ground['distance_m']/total
            aircraft.elapsed = ground_motion.time_at_distance(profile,ground['distance_m'])
            aircraft.place(*phase.at_fraction(fraction,aircraft.elapsed),step=step)
            self._observe_ground_departure(aircraft,now)
            limited = stop < total-1e-5
            if limited and aircraft.speed_mps < .1: ground['wait_s'] += step
            action = 'ground_wait' if limited else 'ground_taxi'
            reason = authority.reason or '허가된 지상 경로 이동'
            prior = (aircraft.instruction.get('action'),aircraft.instruction.get('reason'))
            aircraft.instruction = {'action':action,'reason':reason,'blocked_by':list(authority.blocked_by),
                'stop_distance_m':round(stop,2),'distance_m':round(ground['distance_m'],2),
                'wait_seconds':round(ground['wait_s'],1),'route_id':ground['route_id'],'updated_s':now}
            if prior != (action,reason):
                self._record(now,'ground_decision',aircraft.flight,role='verti_c',action=action,reason=reason,
                             blocked_by=list(authority.blocked_by),route_id=ground['route_id'])
            if ground['distance_m'] >= total-1e-7 and aircraft.speed_mps < .001:
                ground['end_s'] += step
            aircraft.elapsed += ground['end_s']
            done = ground['end_s'] >= max(.1,phase.duration_s-profile['times_s'][-1])
        aircraft.remember(now)
        self._ask_psu(aircraft,now)
        if not done: return
        self.ground_control.release(aircraft.aircraft_id,ground['route_id'])
        aircraft.ground = None
        aircraft.instruction = {}
        if aircraft.index+1 >= len(aircraft.route.phases):
            return self._arrive(aircraft,now)
        aircraft.index += 1
        aircraft.elapsed = 0.0
        aircraft.phase = aircraft.route.phases[aircraft.index].stage
        if self.pilots and aircraft.airborne:
            self._fly_native(aircraft,now,0.0,ground_observations)

    def _observe_ground_departure(self, aircraft, now):
        """Movement start and physical stand clearance are different events."""
        if aircraft.phase != 'gate_out' or aircraft.flight is None:
            return
        flight = aircraft.flight
        spot = self._stand_place(flight['origin'], flight['departure_stand'])
        distance = flight_plan.haversine_m(spot[:2], (aircraft.latitude, aircraft.longitude))
        if aircraft.departed_s is None and distance > .01:
            aircraft.departed_s = now
            self._record(now, 'off_block', flight, delay_s=round(now-flight['off_block_s'], 1),
                         direct=aircraft.route.direct)
        gate = next((g for g in self._layout(flight['origin']).get('gates', ())
                     if g['id'] == flight['departure_stand']), {})
        if (distance >= float(gate.get('radius_m', 7.2)) + self._ground_radius(aircraft) and
                self.psu._stands.occupant(flight['origin'], flight['departure_stand']) == aircraft.aircraft_id):
            self.psu.leave_stand(flight['origin'], flight['departure_stand'], aircraft.aircraft_id)
            self._record(now, 'stand_cleared', flight, stand=flight['departure_stand'])

    def _fly(self, aircraft, now, step,ground_observations=None):
        route, flight = aircraft.route, aircraft.flight
        if route is None or flight is None:
            aircraft.phase = PHASE_PARKED
            return
        if self.ground_control and aircraft.phase in ('gate_out','gate_in'):
            return self._fly_ground(aircraft,now,step,ground_observations)
        if self.pilots and aircraft.phase not in GROUND_PHASES:
            return self._fly_native(aircraft, now, step,ground_observations)
        aircraft.elapsed += step
        self._ask_psu(aircraft, now)
        route = aircraft.route
        while aircraft.index < len(route.phases) and aircraft.elapsed >= route.phases[aircraft.index].duration_s:
            # Rehearsal uses the same observed gate/exit permission. A scheduled
            # finite wait is not evidence that the occupied gate became free.
            current = route.phases[aircraft.index]
            if self.ground_control and current.stage == HOLD:
                ready = self._ensure_arrival_gate(aircraft,now,ground_observations)
                route = aircraft.route
                if not ready:
                    aircraft.elapsed = current.duration_s
                    aircraft.hold_seconds += step
                    aircraft.instruction = {'clearance':'hold','clearance_reason':aircraft.clearance.gate_reason}
                    break
                aircraft.instruction = {'clearance':'approach','clearance_reason':'주기장과 도착 출구 확보'}
            aircraft.elapsed -= route.phases[aircraft.index].duration_s
            finished = route.phases[aircraft.index]
            aircraft.index += 1
            hold = self._hold_phases(aircraft, finished, now,ground_observations)
            route = aircraft.route
            if hold:
                return self._enter_hold(aircraft, hold, now)
            if aircraft.index >= len(route.phases):
                return self._arrive(aircraft, now)
            aircraft.phase = route.phases[aircraft.index].stage
            if self.pilots and aircraft.phase not in GROUND_PHASES:
                return self._fly_native(aircraft, now, 0.0,ground_observations)
            if finished.stage == "landing":
                self._release_arrival_pad(aircraft, now)
                self._record(now, "touchdown", flight, hold_s=round(aircraft.hold_seconds, 1))
        if aircraft.index < len(route.phases):
            phase = route.phases[aircraft.index]
            latitude, longitude, altitude, heading = phase.at(aircraft.elapsed)
            # The step is what makes the height change a rate: a climb walked
            # along a phase is still a climb, and an extrapolation of this
            # aircraft has to be able to see it.
            aircraft.place(latitude, longitude, altitude, heading, step)
            aircraft.speed_mps = (ground_motion.at(phase.detail["ground_motion"], aircraft.elapsed)[1]
                                  if phase.detail.get("ground_motion") else phase.speed_mps)
            aircraft.phase = phase.stage
            self._observe_ground_departure(aircraft, now)
            aircraft.remember(now)

    def _fly_native(self, aircraft, now, step,ground_observations=None):
        """Flight state is observed from the native runtime, never Phase.at()."""
        try:
            if not aircraft.pilot_active:
                if not self._prepare_waiting_route(aircraft,now):return
                self.pilots.start(aircraft.aircraft_id, aircraft.route, aircraft.heading)
                aircraft.pilot_active = True
                self.psu.mark_used(aircraft.flight['flight_id'], psu_sequencing.DEPARTURE, now)
                self._record(now, 'takeoff', aircraft.flight)
            self._ask_psu(aircraft, now)
            clearance, target = aircraft.clearance, None
            arrival_allocation.review(self,aircraft,now,ground_observations)
            guidance=aircraft.telemetry.get('guidance') or {}
            landing_locked=guidance.get('available') and guidance.get('landing_yaw_mutable') is False
            if clearance and clearance.stand is None and not self.ground_control:
                previous = clearance.stand
                self.psu.reconsider_arrival(aircraft.flight["flight_id"], now)
                if previous != clearance.stand:
                    self._retarget_arrival_gate(aircraft, clearance.stand)
            route = aircraft.route
            rules = self.policy['psu']
            predictive = rules['predictive_arrivals']
            approach_lead = sum(p.duration_s for p in route.phases if p.stage in ('descent', 'landing'))
            before_descent = aircraft.index < (route.descent_index or 0)
            if clearance and (not before_descent or self._near_queue_entry(aircraft) or aircraft.flight['flight_id'] in self.psu.waiting.reservations or self._remaining_native(aircraft) <= approach_lead + max(120., rules['final_guard_s'])):
                remaining = self._remaining_native(aircraft)
                final = self._at_final_gate(aircraft)
                egress = not self.ground_control or self._ensure_arrival_gate(aircraft,now,ground_observations,
                    clear_by_s=now+remaining-rules['prediction_buffer_s'] if predictive and not final else None)
                route = aircraft.route
                # A gate change is never a command to move a descending aircraft
                # sideways. Recheck before final entry; finish committed vertical
                # contact and let ground authority handle a newly blocked exit.
                if (aircraft.telemetry.get('guidance') or {}).get('reason')=='vertical_landing':
                    egress = True
                pad = (aircraft.flight['destination'], route.arrival.get('fato') or aircraft.flight['arrival_fato'])
                occupied = (not self.psu.fato_usable(*pad, aircraft.flight['flight_id'], now_s=now)
                            if self.psu.resource_monitor is not None else
                            self._active_pad_owner(pad) not in (None, aircraft.flight['flight_id']))
                occupied = occupied or any(place==pad[0] and owner!=aircraft.flight['flight_id']
                    and self._nearby_pads(place,pad[1],other) and self.flights.get(owner,{}).get('origin')==place
                    for (place,other),owner in self._active_pad_items())
                remaining = self._remaining_native(aircraft)
                final = self._at_final_gate(aircraft)
                terminal_route = self._arrival_authority_route(route)
                terminal_blockers = self._terminal.blockers(aircraft.flight, terminal_route, 'arrival')
                if (predictive and not final and terminal_blockers
                        and all(b.get('operation')=='departure' for b in terminal_blockers)):
                    entry = self._arrival_entry_route(aircraft,remaining)
                    if entry is not None and not self._terminal.blockers(aircraft.flight,entry,'arrival'):
                        terminal_route, terminal_blockers = entry, []
                clearance.approach_mode = 'initial' if terminal_route.key != self._arrival_authority_route(route).key else 'full'
                if predictive:
                    # ETA grants entry only. Actual pad occupancy is authoritative
                    # at the final gate, even when a preceding ETA was optimistic.
                    ahead = any(c.kind == psu_sequencing.ARRIVAL and c is not clearance
                        and c.vertiport == pad[0] and c.fato == pad[1] and c.released_s is None
                        and c.approach_started_s is not None and
                        (c.approach_started_s,c.requested_s,c.flight_id) <
                        (clearance.approach_started_s if clearance.approach_started_s is not None else float('inf'),
                         clearance.requested_s,clearance.flight_id)
                        for c in self.psu._clearances.values())
                    permitted = not (final and (occupied or ahead)) and egress and not terminal_blockers and (aircraft.flight['flight_id'] in self.psu.waiting.reservations or aircraft.instruction.get('action') not in ('yield','wait_clear')) and self._queue_return_clear(aircraft) and self.psu.begin_approach(aircraft.flight['flight_id'], now,
                        headway_s=rules['approach_headway_s'], capacity=rules['approach_capacity'])
                    waiting = not permitted or (final and (occupied or ahead))
                else:
                    landing_s = route.phases[route.landing_index].duration_s
                    waiting = (clearance.state == 'refused' or clearance.stand is None or occupied
                               or now < (clearance.cleared_s or now)-landing_s)
                traffic_wait = aircraft.instruction.get('action') in ('yield', 'wait_clear')
                separating = bool(aircraft.hold and aircraft.hold.get('separation') and
                    (math.hypot((aircraft.hold['fix'][0]-aircraft.latitude)*111320,
                        (aircraft.hold['fix'][1]-aircraft.longitude)*111320*math.cos(math.radians(aircraft.latitude))) > 8
                     or aircraft.speed_mps > 1))
                if aircraft.flight['flight_id'] in self.psu.waiting.reservations:
                    # The reserved bay has its own checked movement. A pilot's
                    # warning about the future route must not pin it on-route.
                    traffic_wait = not self._queue_return_clear(aircraft)
                    separating = False
                traffic_wait = traffic_wait or separating
                waiting = waiting or traffic_wait or bool(terminal_blockers) or not egress
                if landing_locked:
                    # Vertical contact owns this column. A following bay must
                    # not send the committed landing back into the queue.
                    waiting = occupied
                if not waiting:
                    self._terminal.acquire(aircraft.flight, terminal_route, 'arrival')
                wait_reason = (clearance.gate_reason if not egress else self._terminal_wait_reason(terminal_blockers) if terminal_blockers else
                    ('최종 패드 점유 대기' if final and occupied else
                     '주변 교통 분리 대기' if traffic_wait else clearance.reason if waiting else '접근 경로 확보'))
                self._decision(now, aircraft.flight, 'terminal_arrival', 'hold' if waiting else 'granted',
                    wait_reason,
                    vertiport=pad[0], fato=pad[1], blockers=terminal_blockers,
                    traffic_id=aircraft.instruction.get('traffic_id'),traffic_action=aircraft.instruction.get('action'),
                    separation_active=separating)
                if not waiting and (final or not predictive):
                    self._observe_pad_occupied(pad, aircraft.flight['flight_id'], now)
                # Crossing traffic can temporarily interrupt an already granted
                # merge. Brake there with the arrival authority retained; commanding
                # another 480 m trip to the bay caused repeated return/retreat
                # cycles. Lost pad/egress authority still uses the normal bay.
                pause_return = (waiting and traffic_wait and egress and not terminal_blockers
                    and not (final and (occupied or (predictive and ahead))))
                queued, queue_target = self._queue_instruction(aircraft, waiting, now, step,
                    hold_reason=wait_reason,pause_return=pause_return)
                if queued:
                    target = queue_target
                elif waiting:
                    checked_separation = hasattr(self.pilots,'separation_candidates')
                    escape = None
                    if (checked_separation and aircraft.instruction.get('action')=='yield'
                            and not (aircraft.hold or {}).get('separation')
                            and now-(aircraft.hold or {}).get('separation_checked_s',-float('inf')) >= 2):
                        escape = self._separation_fix(aircraft)
                        if aircraft.hold is not None:
                            aircraft.hold['separation_checked_s'] = now
                    relocate = (aircraft.hold is not None and aircraft.hold.get('slot') is None
                                and not aircraft.hold.get('separation') and
                                (not final or checked_separation) and aircraft.instruction.get('action') == 'yield')
                    if checked_separation:
                        relocate = aircraft.hold is not None and escape is not None
                    if aircraft.hold is None or relocate:
                        entry = (aircraft.latitude, aircraft.longitude, aircraft.altitude)
                        if escape:
                            target, slot = escape, None
                        elif final or before_descent or aircraft.instruction.get('action') == 'wait_clear' or checked_separation and aircraft.instruction.get('action')=='yield':
                            # No excursion back through a following approach on
                            # short final. Brake at the current altitude/position.
                            target, slot = entry, None
                        else:
                            target, slot = self._holding_fix(aircraft.flight['destination'], entry)
                        aircraft.hold = {'fix': target, 'slot': slot, 'entered_s': now,'separation_checked_s':now}
                        if escape:
                            aircraft.hold['separation'] = True
                            self._record(now,'approach_separation',aircraft.flight,reason='관측 교통·지형 확인 후 수평 분리 이동',
                                traffic_id=aircraft.instruction.get('traffic_id'),target=list(target))
                        self._holds.setdefault(aircraft.flight['destination'], {})[aircraft.aircraft_id] = aircraft.hold
                        self._record(now, 'hold', aircraft.flight, sequence=clearance.sequence)
                    if aircraft.hold.get('separation'):
                        own, rows = self._separation_observations(aircraft)
                        if not self.pilots.separation_clear(own,aircraft.hold['fix'],rows,self.policy['pilot']):
                            aircraft.hold['fix'] = (aircraft.latitude,aircraft.longitude,aircraft.altitude)
                            aircraft.hold.pop('separation',None)
                            self._record(now,'approach_separation_stopped',aircraft.flight,reason='분리 경로 재검증 실패 · 현 위치 대기')
                    target = aircraft.hold['fix']
                    aircraft.hold_seconds += step
                    aircraft.instruction = dict(aircraft.instruction, clearance='hold',
                        clearance_reason='분리 지점 이동 완료 확인' if separating else clearance.gate_reason if not egress else
                        self._terminal_wait_reason(terminal_blockers) if terminal_blockers else
                        '최종 패드 점유 확인' if final and occupied else
                        aircraft.instruction.get('reason','주변 교통 분리 대기') if traffic_wait else
                        '선행 착륙 완료 대기' if predictive and final and ahead else clearance.reason)
                else:
                    aircraft.instruction = dict(aircraft.instruction, clearance='land' if final else 'approach',
                        clearance_reason=clearance.gate_reason if clearance.landing_staging else
                        '초기 접근 허가 · 공용 최종 구간 재확인' if clearance.approach_mode=='initial' else
                        '최종 패드 확보' if final else '예측 도착 슬롯에 맞춰 접근')
                    if aircraft.hold is not None:
                        self._holds.get(aircraft.flight['destination'], {}).pop(aircraft.aircraft_id, None)
                        aircraft.hold = None
                        self._record(now, 'hold_released', aircraft.flight)
            if hasattr(self.pilots, 'set_traffic'):
                self.pilots.set_traffic(aircraft.aircraft_id, aircraft.instruction)
            if getattr(self, "_native_batch", None) is not None:
                future = self.pilots.submit(aircraft.aircraft_id, step, target)
                self._native_batch.append((aircraft, route, target, future))
                return
            self._observe_native(aircraft, route, target,
                                 self.pilots.advance(aircraft.aircraft_id, step, target), now)
        except (RuntimeError, ValueError, OSError) as problem:
            self._native_failed(aircraft, now, problem)

    def _warm_entry_estimates(self, on_prepare=None):
        # Forecast preparation happens before this engine is published/played.
        # Replays retain the cache; no simulation clock advances during warmup.
        if not hasattr(self.pilots,'estimate_to_entry'):return
        candidates = [a for a in self.aircraft.values() if a.flights and a.flights[0] in self.flights]
        if hasattr(self.pilots,'estimate_many'):
            # Every aircraft's first leg, rehearsed on the physics pool at once
            # rather than one after another; routes are built here, on this
            # thread, because the route builder is not the part that is slow.
            #
            # Every pad pair the departure may choose, not only the pair the
            # plan names: the departure picks between them, and a pair that was
            # not rehearsed was being rehearsed then, in the step, under the
            # lock. The options are kept, so the departure reads them too.
            requests=[]
            rehearsed=set()
            for aircraft in candidates:
                flight=dict(self.flights[aircraft.flights[0]],departure_stand=aircraft.stand)
                options=getattr(self,'_assignment_options',None)
                routes=[]
                if options is not None:
                    key=(flight['flight_id'],flight['departure_stand'])
                    try:
                        if key not in options:
                            options[key]=fato_assignment.options(self,flight)
                        routes=[route for _candidate,route in options[key][0]]
                    except (RuntimeError,ValueError,OSError,KeyError):
                        routes=[]
                if not routes:
                    try:
                        routes=[self.route(flight)]
                    except (RuntimeError,ValueError,OSError):
                        continue
                added=False
                for route in routes:
                    if route.descent_index is None:continue
                    ground=next((p for p in route.phases if p.stage=='gate_out'),None)
                    heading=ground.at_fraction(1.)[3] if ground else aircraft.heading
                    if id(route) in rehearsed:continue
                    rehearsed.add(id(route))
                    requests.append((route,heading))
                    added=True
                if added:rehearsed.add(aircraft.aircraft_id)
            # The batch reports actual unique native rehearsals.  An aircraft
            # may offer several pad pairs, while several arrival FATOs can
            # share the exact same route prefix up to descent.  Reporting the
            # aircraft count reached 132/132 while hundreds of real forecasts
            # were still running, which made a healthy warm-up look hung.
            self.pilots.estimate_many(requests,
                on_progress=(lambda done,total:on_prepare('forecast',done,total)) if on_prepare else None)
            if on_prepare and not requests:on_prepare('forecast',len(candidates),len(candidates))
            return
        if on_prepare:on_prepare('forecast', 0, len(candidates))
        for index, aircraft in enumerate(candidates, 1):
            flight=self.flights[aircraft.flights[0]]
            try:
                route=self.route(dict(flight,departure_stand=aircraft.stand))
                if route.descent_index is None:continue
                ground=next((p for p in route.phases if p.stage=='gate_out'),None)
                self.pilots.estimate_to_entry(route,ground.at_fraction(1.)[3] if ground else aircraft.heading)
            except (RuntimeError,ValueError,OSError):
                # A forecast failure is not an observed flight failure. The
                # admission path uses its explicit conservative timing fallback.
                continue

            finally:
                if on_prepare:on_prepare('forecast', index, len(candidates))

    def _preview_arrival_entry(self, aircraft, flight, route, now, *, cached_only=False):
        """Read the admission queue without booking or freezing a candidate route."""
        if route.descent_index is None:
            return {'key': (flight['destination'],), 'entry_s': now, 'departure_s': now}
        # One queue per arrival pad, not per port: a vertiport with two landing
        # FATOs takes two arrivals side by side. Keyed by the port alone, as it
        # was, every extra FATO the operator laid out changed nothing about how
        # many aircraft could come in. The pad's own timeline and the adjacent-
        # pad check still say whether the landing itself is safe.
        fato=(route.arrival or {}).get('fato') or flight.get('arrival_fato')
        key=(flight['destination'],fato) if self.policy['psu'].get('entry_per_fato',True) and fato else (flight['destination'],)
        lead=60.+1.5*sum(p.duration_s for p in route.phases[:route.descent_index])
        # Candidate enumeration must not run a native rehearsal per pad pair.
        # Use a prepared estimate where available; otherwise the existing
        # conservative duration fallback. Admission still requests its estimate.
        estimator=getattr(self.pilots,'cached_entry_estimate' if cached_only else 'estimate_to_entry',None)
        if estimator:
            ground=next((p for p in route.phases if p.stage=='gate_out'),None)
            heading=ground.at_fraction(1.)[3] if ground else aircraft.heading
            estimate=estimator(route,heading)
            if estimate is not None:lead=(ground.duration_s if ground else 0.)+estimate
        # Compare touchdown demand: two different approaches can reach their
        # entry fixes at separated times but still need the same pad together.
        offset=sum(p.duration_s for p in route.phases if p.stage in ('descent','landing'))
        desired=now+lead+offset;touchdown=desired
        spacing=max(self.policy['psu']['entry_spacing_s'],2*self.policy['psu']['approach_headway_s'],
                    self.psu.tuning.landing_separation_s)
        others={}
        passed_own=False
        # The aircraft being previewed always yields -- it is never allowed to
        # displace anyone -- so whatever is in `others` pushes it later. For a
        # hand-flown aircraft that meant queueing behind every other aircraft
        # still standing on its own stand, and since those are forecasts rather
        # than traffic, each recomputation found more of them and moved the
        # pilot's departure further away while they sat at the gate watching it.
        # It still yields to everything actually flying, which is the loop below.
        # Same rule as the arrival sequencer's, and the same switch governs both.
        waiting_only=bool(aircraft.external) and self.psu.tuning.manual_arrival_priority
        for owner,item in self._entry_forecasts.items():
            if owner==flight['flight_id']:
                passed_own=True
                continue
            # A later parked reservation cannot repeatedly move the mature
            # head to the tail. Actual traffic below always takes precedence.
            if passed_own or item['key']!=key or waiting_only:continue
            landing_offset=item.get('landing_offset_s',offset)
            # An older aircraft still on its stand cannot arrive in the past.
            # Protect its earliest *current* arrival, rather than allowing new
            # departures to fly into a stale reservation and then displace it
            # as observed traffic when its pilot asks again. Active aircraft
            # below replace this projection with their actual remaining travel.
            travel=item['entry_s']+landing_offset-item['departure_s']
            others[owner]=max(item['entry_s']+landing_offset,now+travel)
        for other in self.aircraft.values():
            f,r=other.flight,other.route
            if not f or not r or r.landing_index is None:continue
            owner=f['flight_id']
            if owner==flight['flight_id']:continue
            if other.index>r.landing_index or other.phase in ('parked','charge','gate_in'):
                others.pop(owner,None)
                continue
            pad=(r.arrival or {}).get('fato') or f.get('arrival_fato')
            other_key=(f['destination'],pad) if len(key)==2 else (f['destination'],)
            if other_key!=key:continue
            # A holding aircraft does not vanish when its initial entry time
            # expires. Read current remaining travel, including its bay return.
            eta=now+self._remaining_native(other)
            c=other.clearance
            if c and c.released_s is None and c.approach_s is not None and c.cleared_s is not None:
                eta=max(eta,c.cleared_s-self.policy['psu']['prediction_buffer_s'])
            others[owner]=eta
        previous=-float('inf')
        for expected in sorted(others.values()):
            occupied=max(expected,previous+spacing)
            previous=occupied
            if abs(touchdown-occupied)<spacing:
                touchdown=occupied+spacing
        return {'key':key,'entry_s':touchdown-offset,'departure_s':now+(touchdown-desired),
                'landing_offset_s':offset}

    def _meter_arrival_entry(self, aircraft, flight, route, now):
        """Space predicted terminal arrivals while aircraft still own a stand."""
        if route.descent_index is None:return True
        forecasts=getattr(self,'_entry_forecasts',None)
        if forecasts is None:self._entry_forecasts={};forecasts=self._entry_forecasts
        booked=forecasts.get(flight['flight_id'])
        if booked:
            if now+1e-6>=booked['departure_s']:
                # Ground congestion may have delayed release far beyond the
                # old slot. Recheck observed demand, without reordering it or
                # rerunning a native forecast inside the simulation tick.
                slot=self._preview_arrival_entry(aircraft,flight,route,now,cached_only=True)
                if slot['departure_s']<=now+.5:
                    booked.update(slot)
                    return True
                booked.update(slot)
            aircraft.instruction={'action':'departure_wait','reason':f"도착 {flight['destination']} / {flight['arrival_fato']} 진입 순서 대기 (주기장 유지)",
                                  'entry_s':booked['entry_s'],'ready_s':booked['departure_s']}
            return False
        # The estimate the slot is metered with is read, never rehearsed, in
        # a step: one not yet prepared is started beside the day and the
        # aircraft keeps its stand for one more step.
        prepare=getattr(self.pilots,'prepare_entry_estimate',None)
        if prepare:
            ground=next((p for p in route.phases if p.stage=='gate_out'),None)
            heading=ground.at_fraction(1.)[3] if ground else aircraft.heading
            if not prepare(route,heading):
                aircraft.instruction={'action':'departure_wait','reason':'진입 순서 예측 준비 중 (주기장 유지)'}
                return False
            slot=self._preview_arrival_entry(aircraft,flight,route,now,cached_only=True)
        else:
            slot=self._preview_arrival_entry(aircraft,flight,route,now)
        entry=slot['entry_s']
        desired=entry-(slot['departure_s']-now)
        forecasts[flight['flight_id']]=dict(slot)
        self._assigned_plans[flight['flight_id']]=(flight,route)
        if entry>desired+.5:
            aircraft.instruction={'action':'departure_wait','reason':f"도착 {flight['destination']} / {flight['arrival_fato']} 진입 순서 대기 (주기장 유지)",
                                  'entry_s':entry,'ready_s':slot['departure_s']}
            return False
        return True

    def _prepare_waiting_route(self, aircraft, now):
        """Assign the arrival bay before creating the pilot's immutable route.

        The native pilot brakes at that off-corridor waypoint itself. PSU holds
        its departure from the bay, rather than stopping it on the common leg.
        Only future guidance changes; observed position and the source FPL stay.
        """
        owner=aircraft.flight['flight_id']
        if owner in self.psu.waiting.reservations:return True
        route=aircraft.route;index=route.descent_index
        if index is None or index<1 or aircraft.index>=index or route.phases[index-1].stage!='cruise':return True
        entry=route.phases[index].points[0];policy=self.policy['pilot']
        # The bays are laid out around the corridor's end (the approach entry),
        # but the approach itself is flown from the bay straight to the next
        # point of the descent: an aircraft released from its bay does not fly
        # back to the entry it left the corridor at. The entry stays in the
        # phase's detail as the anchor bays are placed around.
        descent=route.phases[index]
        direct=bool(self.policy['psu'].get('direct_approach',True)) and len(descent.points)>1
        approach=descent.points[1:] if direct else list(descent.points)
        rejoin=approach[0]
        candidates=self._queue_candidates(aircraft)
        r=self.psu.waiting.reserve(owner,aircraft.flight['destination'],candidates,
            rejoin,now,policy['traffic_horizontal_m'],policy['traffic_vertical_m'],lambda point:True)
        if r is None:
            aircraft.instruction={'action':'departure_wait','reason':'PSU 접근 대기점 여유 확보 대기'}
            return False
        bay=r['target'];phases=list(route.phases);cruise=phases[index-1]
        # The line from the bay to the descent is not checked against the
        # other bays here: it is checked when the aircraft is released, against
        # the traffic actually there (`_queue_return_clear`), and the aircraft
        # keeps its bay until that line is clear.
        points=[*cruise.points[:-1],bay]
        phases[index-1]=Phase(cruise.stage,cruise.label,points,cruise.duration_s,cruise.speed_mps,dict(cruise.detail))
        extra=flight_plan.haversine_m(bay[:2],rejoin[:2])/max(1.,policy['approach_horizontal_speed_mps'])
        extra+=abs(bay[2]-rejoin[2])/max(.1,policy['descent_rate_mps'])
        phases[index]=Phase(descent.stage,descent.label,[bay,*approach],descent.duration_s+extra,
                            descent.speed_mps,dict(descent.detail,psu_rejoin=entry,psu_direct=direct,
                                psu_inbound=next((p for p in reversed(cruise.points) if flight_plan.haversine_m(p[:2],entry[:2])>5),entry)))
        aircraft.route=Route((route.key,'psu-bay',r['slot']),phases,dict(route.arrival),dict(route.departure))
        aircraft.route.boarding,aircraft.route.alighting=route.boarding,route.alighting
        aircraft.route.direct=route.direct
        r['state']='enroute';r['planned_route']=True;r['direct']=direct
        self._record(now,'holding_route_assigned',aircraft.flight,slot=r['slot'],target=bay,rejoin=rejoin,entry=entry)
        return True

    def reserve_manual_bay(self, aircraft, now):
        """Somewhere to wait, for a pilot who is flying the aircraft themselves.

        The same bay an automatic arrival is given, off the same approach entry,
        reserved the same way so nobody else is sent to it. What it does not do
        is splice the bay into a route: there is no route being flown here,
        there is a person, and what they need is to be told where the place is
        rather than to be carried to it.

        A hand-flown aircraft asking this is usually already over the deck, so
        unlike the automatic path there is no test for still being short of the
        descent. Being late to ask is the normal case, not a disqualification.
        """
        flight = aircraft.flight
        if flight is None or aircraft.route is None:
            return None
        owner = flight['flight_id']
        existing = self.psu.waiting.reservations.get(owner)
        if existing is not None:
            return existing
        route = aircraft.route
        index = route.descent_index
        if index is None or index < 1:
            return None
        descent = route.phases[index]
        direct = bool(self.policy['psu'].get('direct_approach', True)) and len(descent.points) > 1
        rejoin = (descent.points[1:] if direct else list(descent.points))[0]
        policy = self.policy['pilot']
        reservation = self.psu.waiting.reserve(owner, flight['destination'], self._queue_candidates(aircraft),
            rejoin, now, policy['traffic_horizontal_m'], policy['traffic_vertical_m'], lambda point: True)
        if reservation is None:
            return None
        reservation['manual'] = True
        aircraft.hold = {'fix': reservation['target'], 'slot': reservation['slot'],
                         'entered_s': reservation['assigned_s'], 'psu_queue': True, 'manual': True,
                         'rejoin': tuple(reservation['rejoin'])}
        self._holds.setdefault(flight['destination'], {})[aircraft.aircraft_id] = aircraft.hold
        if aircraft.clearance is not None:
            aircraft.clearance.holding_assignment = dict(reservation)
        self._record(now, 'holding_bay_assigned', flight, slot=reservation['slot'],
                     target=reservation['target'], rejoin=reservation['rejoin'])
        return reservation

    def _near_queue_entry(self, aircraft):
        route=aircraft.route
        if route.descent_index is None:return False
        if aircraft.index>=route.descent_index:return True
        current=(aircraft.latitude,aircraft.longitude,aircraft.altitude)
        distance=0.
        for index in range(aircraft.index,route.descent_index):
            phase=route.phases[index]
            first=min(int(aircraft.telemetry.get('segment_index',0))+1,len(phase.points)-1) if index==aircraft.index else 1
            for point in phase.points[first:]:
                distance+=flight_plan.haversine_m(current[:2],point[:2]);current=point
                if distance>1500:return False
        return True

    def _queue_observations(self):
        return [dict(owner=a.flight['flight_id'],
            position=(a.latitude,a.longitude,a.altitude),
            velocity=(a.telemetry.get('north_mps',0.),a.telemetry.get('east_mps',0.),a.climb_mps))
            for a in self.aircraft.values() if a.flight and a.airborne]

    def _queue_transfer_clear(self, aircraft, target, origin=None):
        policy=self.policy['pilot']
        position=origin or (aircraft.latitude,aircraft.longitude,aircraft.altitude)
        start_ground=self._ground_height(position[0],position[1],0. if self._elevation is None else float('inf'))
        clearance=min(policy['traffic_vertical_m'],max(5.,position[2]-start_ground))
        for i in range(13):
            point=tuple(a+(b-a)*i/12 for a,b in zip(position,target))
            if point[2] < self._ground_height(point[0],point[1],0. if self._elevation is None else float('inf'))+clearance-1e-6:
                return False
        return self.psu.waiting.transfer_clear(aircraft.flight['flight_id'],position,target,
            self._queue_observations(),policy['traffic_horizontal_m'],policy['traffic_vertical_m'],
            policy['traffic_lookahead_s'])

    def _queue_return_clear(self, aircraft):
        r=self.psu.waiting.reservations.get(aircraft.flight['flight_id'])
        if r is None:return True
        if r['state']=='enroute' and aircraft.index<aircraft.route.descent_index:return False
        if self._queue_transfer_clear(aircraft,r['rejoin']):return True
        level=(r['rejoin'][0],r['rejoin'][1],aircraft.altitude)
        return (flight_plan.haversine_m((aircraft.latitude,aircraft.longitude),level[:2])>15 and
                self._queue_transfer_clear(aircraft,level))

    @staticmethod
    def _arrival_authority_route(route):
        index=route.descent_index
        if index is None or 'psu_rejoin' not in route.phases[index].detail:return route
        phase=route.phases[index];phases=list(route.phases)
        phases[index]=Phase(phase.stage,phase.label,phase.points[1:],phase.duration_s,
                            phase.speed_mps,phase.detail)
        return Route((route.key,'terminal-authority'),phases,route.arrival,route.departure)

    def _queue_anchor(self, aircraft):
        route=aircraft.route
        if (aircraft.clearance and aircraft.clearance.approach_started_s is not None
                and self._compute_remaining_native(aircraft,include_queue=False)<=self.policy['psu']['final_guard_s']+60):
            point=route.phases[route.landing_index].points[0]
            floor=self._ground_height(point[0],point[1],0. if self._elevation is None else float('inf'))
            return (*point[:2],max(point[2],floor+self.policy['pilot']['traffic_vertical_m']))
        return route.phases[route.descent_index].detail.get('psu_rejoin',route.phases[route.descent_index].points[0])

    def _queue_candidates(self, aircraft):
        route=aircraft.route
        anchor=self._queue_anchor(aircraft)
        prior=[p for phase in route.phases[:route.descent_index] for p in phase.points
               if flight_plan.haversine_m(p[:2],anchor[:2])>5]
        inbound=route.phases[route.descent_index].detail.get('psu_inbound') or (prior[-1] if prior else route.phases[route.landing_index].points[-1])
        policy=self.policy['pilot']
        # Check the published network as well as the particular inbound leg.
        nodes={n['id']:n for n in [*self._network.get('nodes',()),*self._network.get('fatos',())]}
        for name,point in holding_positions(anchor,inbound,policy['traffic_horizontal_m'],policy['traffic_vertical_m']):
            if point[2] < self._ground_height(point[0],point[1],0. if self._elevation is None else float('inf'))+policy['traffic_vertical_m']:
                continue
            blocked=False
            for link in self._network.get('links',()):
                a,b=nodes.get(link.get('from')),nodes.get(link.get('to'))
                if not a or not b:continue
                ends=[]
                for node in (a,b):
                    altitude=node.get('altitude_m')
                    if altitude is None:altitude=anchor[2]
                    elif node.get('altitude_reference')=='agl':
                        altitude+=self._ground_height(node['latitude'],node['longitude'],0.)
                    ends.append(holding_relative(point,(node['latitude'],node['longitude'],altitude)))
                if min(ends[0][2],ends[1][2])-policy['traffic_vertical_m']<=0<=max(ends[0][2],ends[1][2])+policy['traffic_vertical_m']:
                    width=max(policy['traffic_horizontal_m'],float(link.get('width_m') or 0)/2+30.)
                    if terminal_paths.segment_distance((0.,0.),(0.,0.),ends[0][:2],ends[1][:2])<width:
                        blocked=True;break
            if not blocked:
                yield f"{aircraft.flight['destination']}/{round(anchor[0],5)},{round(anchor[1],5)}/{name}",point

    def _terminal_wait_reason(self, blockers):
        """Describe existing reservations; this never changes separation decisions."""
        reasons = []
        for blocker in blockers:
            flight_id = blocker.get('flight_id', '')
            identity = self.flights.get(flight_id, {}).get('aircraft_id') or flight_id or '식별 정보 없음'
            place = ' '.join(str(blocker[k]) for k in ('vertiport', 'fato') if blocker.get(k))
            operation = {'departure': '이륙', 'arrival': '착륙'}.get(blocker.get('operation'), '운항')
            reasons.append(f"{identity}" + (f" ({place})" if place else '') + f" {operation} 경로")
        return ', '.join(reasons) + '와 접근 경로 분리 대기' if reasons else '접근 경로 분리 대기'

    def _queue_instruction(self, aircraft, waiting, now, step, *, hold_reason='', pause_return=False):
        owner=aircraft.flight['flight_id']
        queue=self.psu.waiting
        r=queue.reservations.get(owner)
        if r and r['state']=='enroute':
            if aircraft.index<aircraft.route.descent_index:
                aircraft.clearance.holding_assignment=dict(r)
                aircraft.instruction=dict(aircraft.instruction,clearance='proceed_to_bay',
                    clearance_reason=f"PSU {r['port']} {r['slot'].rsplit('/',1)[-1]} · 지정 접근점으로 비행",
                    holding_slot=r['slot'],holding_target=r['target'],holding_state='enroute')
                return True,None
            r['state']='holding'
            self._record(now,'hold',aircraft.flight,sequence=aircraft.clearance.sequence,slot=r['slot'])
        # A committed vertical landing must never be redirected to a bay.
        guidance=aircraft.telemetry.get('guidance') or {}
        if guidance.get('available') and guidance.get('landing_yaw_mutable') is False:
            return False,None
        if r is None and not waiting:
            return False,None
        if r is None:
            route=aircraft.route
            if route.descent_index is None:return False,None
            phase=route.phases[aircraft.index]
            rejoin=self._queue_anchor(aircraft)
            policy=self.policy['pilot']
            observations=self._queue_observations()
            def available(point):
                from digital_twin.simulation.holding_queue import nearby
                return all(o['owner']==owner or not nearby(point,o['position'],
                    policy['traffic_horizontal_m'],policy['traffic_vertical_m']) for o in observations)
            r=queue.reserve(owner,aircraft.flight['destination'],self._queue_candidates(aircraft),
                rejoin,now,policy['traffic_horizontal_m'],policy['traffic_vertical_m'],available)
            if r is None:
                return False,None
            r['final_gate']=self._at_final_gate(aircraft)
            self._record(now,'hold',aircraft.flight,sequence=aircraft.clearance.sequence,slot=r['slot'])
            self._record(now,'holding_assignment',aircraft.flight,slot=r['slot'],target=r['target'],
                         rejoin=r['rejoin'],sequence=aircraft.clearance.sequence)
        position=(aircraft.latitude,aircraft.longitude,aircraft.altitude)
        paused = (waiting and pause_return and r['state']=='returning'
                  and aircraft.clearance.approach_started_s is not None)
        if not paused:
            r.pop('return_hold',None)
        if not waiting:
            r.pop('settled_target',None)
        # Released from a bay the approach was planned through, the aircraft
        # starts its approach where it is: the pilot's next point is already
        # the descent, so control is handed back at the bay rather than after
        # a return to the entry it once left the corridor at.
        direct=bool(r.get('direct') and r.get('planned_route') and not r.get('final_gate'))
        destination=(r.setdefault('return_hold',position) if paused else
                     r.get('settled_target',r['target']) if waiting else
                     position if direct else r['rejoin'])
        delta=holding_relative(position,destination)
        captured=math.hypot(*delta[:2])<8 and abs(delta[2])<3 and aircraft.speed_mps<1 and abs(aircraft.climb_mps)<.5
        if not waiting and r.get('planned_route') and not r.get('final_gate'):
            # This is an intermediate native approach waypoint, not a landing
            # hover. Hand control back inside its bounded passage envelope;
            # native guidance still owns waypoint advancement and physical pose.
            phase=aircraft.route.phases[aircraft.route.descent_index]
            if len(phase.points)>1:
                passage=min(20.,flight_plan.haversine_m(r['target'][:2],r['rejoin'][:2])*.15,
                    flight_plan.haversine_m(r['rejoin'][:2],phase.points[2][:2])*.25 if len(phase.points)>2 else 20.)
                captured = captured or (math.hypot(*delta[:2])<passage and abs(delta[2])<3
                    and aircraft.speed_mps<=self.policy['pilot']['approach_horizontal_speed_mps']
                    and abs(aircraft.climb_mps)<.5 and abs(aircraft.telemetry.get('tilt_deg',float('inf')))<1.)
        if waiting and not paused:
            # A holding bay is an area, not a precision landing WP. Once slow
            # inside it, hold a fixed observed point instead of chasing its
            # exact centre. Never move this point every tick (unbounded drift).
            captured=math.hypot(*delta[:2])<15 and abs(delta[2])<5 and aircraft.speed_mps<2 and abs(aircraft.climb_mps)<.5
            if captured and 'settled_target' not in r:
                r['settled_target']=position
                destination=position
        if not waiting and captured:
            queue.release(owner)
            aircraft.clearance.holding_assignment=None
            self._holds.get(aircraft.flight['destination'],{}).pop(aircraft.aircraft_id,None)
            aircraft.hold=None
            self._record(now,'hold_released',aircraft.flight,slot=r['slot'])
            self._record(now,'holding_rejoin_complete',aircraft.flight,slot=r['slot'])
            return False,None
        clear=paused or captured or self._queue_transfer_clear(aircraft,destination)
        movement_target=destination
        if not clear and abs(delta[2])>1 and math.hypot(*delta[:2])>8:
            # First vacate laterally at the observed level; change altitude
            # only once clear of the close neighbour's protection volume.
            level=(destination[0],destination[1],position[2])
            if self._queue_transfer_clear(aircraft,level):
                clear=True;movement_target=level
        if not clear:
            # A two-leg lateral route can bypass an occupied neighbouring bay.
            for via in ((destination[0],position[1],position[2]),
                        (position[0],destination[1],position[2])):
                if flight_plan.haversine_m(position[:2],via[:2])>15 and self._queue_transfer_clear(aircraft,via):
                    clear=True;movement_target=via;break
        if not clear:
            previous=r.get('via')
            if previous and flight_plan.haversine_m(position[:2],previous[:2])>8 and self._queue_transfer_clear(aircraft,previous):
                movement_target=previous;clear=True
            elif now>=r.get('retry_s',0.):
                r['retry_s']=now+2.
                options=[]
                for angle in range(0,360,15):
                    via=(*_offset(position[:2],angle,180.),position[2])
                    if self._queue_transfer_clear(aircraft,via):
                        complete=self._queue_transfer_clear(aircraft,destination,origin=via)
                        options.append((not complete,flight_plan.haversine_m(via[:2],destination[:2]),angle,via))
                if options:
                    movement_target=min(options)[-1];r['via']=movement_target;clear=True
        else:
            r.pop('via',None)
        # Describe the command actually sent to the pilot. A paused aircraft's
        # future rejoin is not a moving claim; it is rechecked before resuming.
        r['movement_target']=movement_target
        state='returning' if paused else (('holding' if waiting else 'rejoined') if captured else (
            ('moving' if waiting else 'returning') if clear else 'blocked'))
        if state!=r['state']:
            r['state']=state;r['move_start']=position
            self._record(now,'holding_movement',aircraft.flight,slot=r['slot'],state=state,
                         target=destination,reason='PSU 지정 대기·복귀 경로 확인' if clear else '대기 구역 이동 경로의 교통 확인')
        if waiting and not paused and captured and aircraft.clearance.approach_started_s is not None and terminal_paths.clear_of(
                self._arrival_authority_route(aircraft.route),'arrival',position,self._terminal.horizontal_m,self._terminal.vertical_m):
            # A physically captured off-route bay is not an active approach.
            # Release only observed-vacated route/pad claims, never by ETA.
            self._terminal.release(owner,'arrival')
            self._release_pads_by_owner(owner, now)
            aircraft.clearance.approach_started_s=None
            self._record(now,'approach_suspended',aircraft.flight,slot=r['slot'],
                         reason='지정 대기점 도착·접근 경로 실제 이탈 확인')
        target=movement_target if clear else position
        aircraft.hold_seconds += step
        aircraft.hold={'fix':target,'slot':r['slot'],'entered_s':r['assigned_s'],'psu_queue':True}
        self._holds.setdefault(aircraft.flight['destination'],{})[aircraft.aircraft_id]=aircraft.hold
        aircraft.clearance.holding_assignment=dict(r)
        bay_reason=f"PSU {r['port']} {r['slot'].rsplit('/',1)[-1]} · " + \
                ('복귀 경로 교통 통과 대기' if paused else
                 {'holding':'지정 위치 대기','moving':'대기 위치 이동','returning':'접근점 복귀',
                  'blocked':'이동 경로 재확인','rejoined':'접근 재개'}[state])
        # Keep the current decision cause, not a previous tick's instruction.
        # Returning to the approach must not retain an already-cleared blocker.
        aircraft.instruction=dict(aircraft.instruction,clearance='hold',
            clearance_reason=(f"{hold_reason} · {bay_reason}" if waiting and hold_reason else bay_reason),
            holding_slot=r['slot'],holding_target=r['target'],holding_state=state)
        return True,target

    def _separation_observations(self, aircraft):
        rows = []
        for a in self.aircraft.values():
            item = dict(a.telemetry,aircraft_id=a.aircraft_id,latitude_deg=a.latitude,longitude_deg=a.longitude,
                altitude_m=a.altitude,speed_mps=a.speed_mps,heading_deg=a.heading,climb_mps=a.climb_mps,
                airborne=a.airborne,instruction=a.instruction)
            if a.hold and a.hold.get('separation'):
                item['separation_target'] = a.hold['fix']
            rows.append(item)
        return next(row for row in rows if row['aircraft_id']==aircraft.aircraft_id), rows

    def _separation_fix(self, aircraft):
        own, rows = self._separation_observations(aircraft)
        for target in self.pilots.separation_candidates(own,rows,self.policy['pilot']):
            # Unknown terrain is not permission to leave the approach. Level
            # transfer avoids climbing through a predecessor's waiting height.
            clear = True
            for i in range(13):
                lat=aircraft.latitude+(target[0]-aircraft.latitude)*i/12
                lon=aircraft.longitude+(target[1]-aircraft.longitude)*i/12
                if target[2] < self._ground_height(lat,lon,float('inf')) + self.policy['pilot']['traffic_vertical_m']:
                    clear = False
                    break
            if clear:
                return target
        return None

    def _observe_native(self, aircraft, route, target, sample, now):
        previous_guidance = aircraft.telemetry.get('guidance',{}).get('reason')
        aircraft.telemetry = sample
        guidance = sample.get('guidance') or {}
        if guidance.get('available') and previous_guidance!=guidance.get('reason'):
            self._record(now,'pilot_guidance',aircraft.flight,reason=guidance['reason'],
                         waypoint_index=guidance.get('waypoint_index'))
        aircraft.place(sample["latitude_deg"], sample["longitude_deg"], sample["altitude_m"], sample["heading_deg"])
        aircraft.speed_mps = sample["speed_mps"]
        # The physics measured its own vertical rate, so that is used rather
        # than a difference of two heights.
        climb = sample.get("climb_mps")
        if isinstance(climb, (int, float)) and climb == climb:
            aircraft.climb_mps = float(climb)
        aircraft.remember(now)
        aircraft.index, aircraft.elapsed = sample["phase_index"], sample["phase_elapsed"]
        aircraft.phase = HOLD if target is not None else route.phases[aircraft.index].stage
        departure=next(p for p in route.phases if p.stage=='takeoff').points[0]
        departure_distance=math.hypot((aircraft.latitude-departure[0])*111320,
            (aircraft.longitude-departure[1])*111320*math.cos(math.radians(departure[0])))
        if aircraft.phase != "takeoff" and departure_distance>=self.policy['pilot']['traffic_horizontal_m']:
            departure_pad = (aircraft.flight["origin"], route.departure.get("fato") or aircraft.flight["departure_fato"])
            if self._active_pad_owner(departure_pad) == aircraft.flight["flight_id"]:
                self._release_pad_observation(departure_pad, aircraft.flight["flight_id"], now)
                self.psu.complete(aircraft.flight["flight_id"], psu_sequencing.DEPARTURE, now)
        if (route.phases[aircraft.index].stage not in ('takeoff', 'climb') and terminal_paths.clear_of(
                route, 'departure', (aircraft.latitude, aircraft.longitude, aircraft.altitude),
                self._terminal.horizontal_m, self._terminal.vertical_m)):
            self._terminal_release(aircraft, 'departure', now)
        if sample["done"]:
            self.psu.mark_used(aircraft.flight['flight_id'], psu_sequencing.ARRIVAL, now)
            self.pilots.finish(aircraft.aircraft_id)
            aircraft.pilot_active = False
            self._record(now, "touchdown", aircraft.flight, hold_s=round(aircraft.hold_seconds, 1))
            aircraft.index, aircraft.elapsed = route.landing_index + 1, 0.0
            if aircraft.index >= len(route.phases):
                return self._arrive(aircraft, now)
            aircraft.phase = route.phases[aircraft.index].stage
            aircraft.ground = None
            aircraft.telemetry = {}

    def _native_failed(self, aircraft, now, problem):
        # Failed aircraft still occupy space; their bay stays reserved.
        aircraft.failed = True
        self.pilots.finish(aircraft.aircraft_id)
        aircraft.pilot_active = False
        self.problems.append(f"{aircraft.aircraft_id}: {problem}")
        self._record(now, "pilot_failed", aircraft.flight, reason=str(problem))

    # ---- the service -------------------------------------------------------
    def _at_final_gate(self, aircraft):
        # Queue ETA is a scheduling forecast, not physical approach progress.
        # Keep a final contingency bay latched until its actual rejoin finishes.
        r=self.psu.waiting.reservations.get(aircraft.flight['flight_id'])
        return bool(r and r.get('final_gate')) or aircraft.index>=aircraft.route.landing_index or (
            self._compute_remaining_native(aircraft,include_queue=False)<=self.policy['psu']['final_guard_s'])

    def _remaining_native(self, aircraft):
        cache = getattr(self, '_remaining_step_cache', None)
        if cache is None:
            return self._compute_remaining_native(aircraft)
        policy = self.policy['pilot']
        key = (aircraft.route, aircraft.index, aircraft.latitude, aircraft.longitude,
               aircraft.altitude, int(aircraft.telemetry.get('segment_index', 0)),
               policy['approach_horizontal_speed_mps'], policy['landing_rate_mps'],
               policy['descent_rate_mps'], policy['climb_rate_mps'],
               tuple((self.psu.waiting.reservations.get(aircraft.flight['flight_id']) or {}).get('rejoin',())))
        if key not in cache:
            cache[key] = self._compute_remaining_native(aircraft)
        return cache[key]

    def _compute_remaining_native(self, aircraft, include_queue=True):
        route = aircraft.route
        if not route or route.landing_index is None or aircraft.index > route.landing_index:
            return 0.0
        current = (aircraft.latitude, aircraft.longitude, aircraft.altitude)
        total = 0.0
        first_index=aircraft.index
        reservation = self.psu.waiting.reservations.get(aircraft.flight['flight_id']) if include_queue else None
        if reservation and reservation['state']=='enroute':reservation=None
        if reservation:
            delta = holding_relative(current,reservation['rejoin'])
            total = (math.hypot(*delta[:2])/max(1.,self.policy['pilot']['approach_horizontal_speed_mps']) +
                abs(delta[2])/max(.1,self.policy['pilot']['descent_rate_mps'])) + 25.
            current = reservation['rejoin']
            first_index=max(first_index,route.descent_index)
        elif aircraft.external and aircraft.airborne:
            # A hand-flown aircraft does not walk the plan. Its phase follows the
            # wheels, so `index` stays where it was handed over, and the walk
            # below would start at the departure gate however far it has
            # actually flown -- measuring the taxi back to the origin, at taxi
            # speed, as time still to come. The number then grows the closer the
            # aircraft gets to its destination, which is exactly when a pilot
            # reads it: one arriving over the deck was told 74 minutes, and the
            # landing slot was booked that far out.
            #
            # What is left for a pilot is the distance to the touchdown point.
            # They are not flying the plan and the plan cannot say. The last of
            # that distance is flown at approach speed and the rest at the
            # fastest speed the plan asks for, so a flight that has just taken
            # off is not charged approach speed for the whole way home.
            target = route.phases[route.landing_index].points[-1]
            delta = holding_relative(current, target)
            approach = max(1., self.policy['pilot']['approach_horizontal_speed_mps'])
            cruise = max(approach, *(phase.speed_mps for phase in route.phases[:route.landing_index + 1]))
            final = 0.0
            for a, b in zip(route.phases[route.descent_index or 0].points,
                            route.phases[route.descent_index or 0].points[1:]):
                final += math.hypot((b[0]-a[0])*111320, (b[1]-a[1])*111320*math.cos(math.radians(a[0])))
            straight = math.hypot(*delta[:2])
            # Coming down is the en-route descent rate, not the touchdown rate:
            # the slow last metres over the pad are nothing at this distance,
            # and charging the whole height at them made the answer the descent
            # time no matter how far out the aircraft was.
            rate = self.policy['pilot']['descent_rate_mps'] if delta[2] < 0 else self.policy['pilot']['climb_rate_mps']
            return max(min(straight, final)/approach + max(0., straight - final)/cruise,
                       abs(delta[2])/max(.1, rate))
        for index in range(first_index, route.landing_index + 1):
            phase = route.phases[index]
            segment = int(aircraft.telemetry.get('segment_index', 0)) if index == aircraft.index else 0
            points = [current, *phase.points[min(segment+1, len(phase.points)-1):]] if index == aircraft.index else phase.points
            for a, b in zip(points, points[1:]):
                horizontal = math.hypot((b[0]-a[0])*111320,
                    (b[1]-a[1])*111320*math.cos(math.radians(a[0])))
                speed = max(1.0, phase.speed_mps)
                if phase.stage == 'descent':
                    speed = min(speed, self.policy['pilot']['approach_horizontal_speed_mps'])
                vertical_speed = self.policy['pilot']['landing_rate_mps'] if phase.stage == 'landing' else (
                    self.policy['pilot']['descent_rate_mps'] if b[2] < a[2] else self.policy['pilot']['climb_rate_mps'])
                total += max(horizontal/speed, abs(b[2]-a[2])/max(.1, vertical_speed))
        return total

    def _refresh_predictions(self, now):
        observations, traffic = {}, []
        ground_observations = tuple(self._ground_observations()) if self.ground_control else ()
        for aircraft in self.aircraft.values():
            if aircraft.flight is None or aircraft.route is None:
                continue
            if aircraft.phase == 'gate_in':
                landing = aircraft.route.phases[aircraft.route.landing_index].points[-1]
                distance = math.hypot((aircraft.latitude-landing[0])*111320,
                    (aircraft.longitude-landing[1])*111320*math.cos(math.radians(landing[0])))
                if distance >= self.policy['psu']['pad_clear_radius_m']:
                    self._release_arrival_pad(aircraft, now)
            if not aircraft.airborne or aircraft.failed:
                continue
            self._ask_psu(aircraft, now)
            arrival_allocation.review(self,aircraft,now,ground_observations)
            remaining = self._remaining_native(aircraft)
            if aircraft.clearance:
                ready = True
                wait_reason = None
                if self.ground_control and self.policy['psu']['predictive_arrivals']:
                    final = self._at_final_gate(aircraft)
                    ready = self._ensure_arrival_gate(aircraft,now,ground_observations,
                        clear_by_s=None if final else now+remaining-self.policy['psu']['prediction_buffer_s'])
                    if (aircraft.telemetry.get('guidance') or {}).get('reason') == 'vertical_landing':
                        ready = True
                    if not ready:
                        self.psu.release_uncommitted_stand(aircraft.flight['flight_id'])
                assignment = self.psu.waiting.reservations.get(aircraft.flight['flight_id'])
                if (ready and self.policy['psu']['predictive_arrivals']
                        and aircraft.clearance.approach_started_s is None
                        and assignment and assignment['state'] != 'enroute'
                        and not self._queue_return_clear(aircraft)):
                    # A free gate is insufficient if this aircraft cannot leave
                    # its bay. Do not let an unstarted, unusable head monopolize
                    # the pad's forecast and stop every ready follower.
                    ready = False
                    wait_reason = '대기점 복귀 경로 확보 대기'
                observations[aircraft.flight['flight_id']] = {'eta_s': now+remaining, 'remaining_s': remaining,
                    'approach_ready': ready, 'approach_wait_reason': wait_reason,
                    # Which one a person is flying. The sequencer books that one
                    # first among the arrivals still waiting; it is the only way
                    # it can tell, and it never displaces a committed approach.
                    'manual': bool(aircraft.external)}
            phase = aircraft.route.phases[min(aircraft.index, len(aircraft.route.phases)-1)]
            segment=min(int(aircraft.telemetry.get('segment_index',0)),len(phase.points)-2)
            a,b=phase.points[max(0,segment):max(0,segment)+2]
            north,east=(b[0]-a[0])*111320,(b[1]-a[1])*111320*math.cos(math.radians(a[0]))
            dn,de=(aircraft.latitude-a[0])*111320,(aircraft.longitude-a[1])*111320*math.cos(math.radians(a[0]))
            right_offset=(-east*dn+north*de)/max(1,math.hypot(north,east))
            traffic.append(dict(aircraft.telemetry, aircraft_id=aircraft.aircraft_id,
                latitude_deg=aircraft.latitude, longitude_deg=aircraft.longitude, altitude_m=aircraft.altitude,
                heading_deg=aircraft.heading, speed_mps=aircraft.speed_mps, phase=aircraft.phase,
                climb_mps=aircraft.climb_mps, right_room_m=phase.detail.get('right_room_m', 0),
                right_offset_m=right_offset,
                resume_target=tuple(b),
                route_phase=phase.stage, destination=aircraft.flight['destination'],
                arrival_fato=aircraft.route.arrival.get('fato'),
                sequence=aircraft.clearance.sequence if aircraft.clearance else None,
                requested_s=aircraft.clearance.requested_s if aircraft.clearance else None,
                approach_started_s=aircraft.clearance.approach_started_s if aircraft.clearance else None))
        if self.policy['psu']['predictive_arrivals']:
            previous_stands = {a.aircraft_id: a.clearance.stand for a in self.aircraft.values() if a.clearance}
            self.psu.refresh_arrivals(observations, now, buffer_s=self.policy['psu']['prediction_buffer_s'])
            for aircraft in self.aircraft.values():
                if (aircraft.clearance and aircraft.clearance.stand is not None
                        and aircraft.clearance.stand != previous_stands.get(aircraft.aircraft_id)):
                    self._retarget_arrival_gate(aircraft, aircraft.clearance.stand)
        commands = self.pilots.traffic_commands(traffic, self.policy['pilot'], now) if hasattr(self.pilots, 'traffic_commands') else {}
        for aircraft in self.aircraft.values():
            if not aircraft.airborne:
                continue
            previous = aircraft.instruction.get('action')
            aircraft.instruction = commands.get(aircraft.aircraft_id, {})
            action = aircraft.instruction.get('action')
            if action != previous and aircraft.flight and (action or previous):
                self._record(now, 'traffic_advisory', aircraft.flight, action=action or 'clear',
                             traffic_id=aircraft.instruction.get('traffic_id'))

    def _ask_psu(self, aircraft, now):
        """Ask for a landing slot once the aircraft is within the request lead."""
        if aircraft.clearance is not None or aircraft.route.landing_index is None:
            return
        remaining = self._remaining_native(aircraft) if self.pilots else aircraft.route.remaining_to_touchdown(aircraft.index, aircraft.elapsed)
        if (remaining > self.psu.tuning.request_lead_s and
                aircraft.index < (aircraft.route.descent_index or 0) and not self._near_queue_entry(aircraft)):
            return
        flight = aircraft.flight
        choices = self._stands_of(flight['destination'])
        if self.ground_control:
            choices = [stand for stand in choices if self._arrival_candidate(aircraft,stand) is not None]
        clearance = self.psu.request_arrival(
            flight_id=flight["flight_id"], vertiport=flight["destination"],
            fato=aircraft.route.arrival.get("fato") or flight["arrival_fato"],
            stand=flight["arrival_stand"], earliest_s=now + remaining, now_s=now,
            stands=choices)
        aircraft.clearance = clearance
        if clearance.stand and clearance.stand != flight["arrival_stand"]:
            self._retarget_arrival_gate(aircraft, clearance.stand)
        self._record(now, "arrival_request", flight, sequence=clearance.sequence,
                     hold_s=round(clearance.hold_s or 0.0, 1), state=clearance.state,
                     stand=clearance.stand, reason=clearance.reason)

    def _arrival_candidate(self, aircraft, stand):
        try:
            route = self.route(dict(aircraft.flight,arrival_stand=stand))
            if route.arrival.get('fato') != aircraft.route.arrival.get('fato'):
                return None
            return next(p for p in route.phases if p.stage=='gate_in')
        except (ValueError,StopIteration):
            return None

    def _taxi_clear_time(self, aircraft_id, geometry, radius, now):
        """Observed moving, authorized taxi can release a shared swept corridor.

        Never infer movement from a schedule alone, extend an authority, or
        remove the observed body. The endpoint must be outside the corridor.
        """
        other = self.aircraft.get(aircraft_id)
        if (not other or other.failed or other.phase not in ('gate_in','gate_out')
                or other.speed_mps <= .05 or not other.ground or not other.flight):
            return None
        if other.phase == 'gate_out' and (other.flight['flight_id'],'departure') not in self._terminal.claims:
            return None
        ground = other.ground
        authority = ground.get('authority')
        if not authority or authority.route_id != ground['route_id'] or authority.speed_limit_mps <= 0:
            return None
        phase = other.route.phases[other.index]
        profile = phase.detail.get('ground_motion')
        if not profile or not ground['length_m']:
            return None
        own = route_geometry(ground['path_m'])
        total = profile['distances_m'][-1]
        start = ground['distance_m']/max(total,1e-12)*own.length_m
        intervals = own.occupied_intervals(geometry,radius,start)
        if not intervals:
            return None
        exit_m = max(end for _,end in intervals)+.25
        if exit_m >= own.length_m or exit_m > authority.stop_distance_m:
            return None
        end = exit_m/own.length_m*total
        seconds = ground_motion.time_at_distance(profile,end)-ground_motion.time_at_distance(profile,ground['distance_m'])
        seconds *= max(1.,phase.speed_mps/authority.speed_limit_mps)
        seconds += authority.speed_limit_mps/ground_motion.ACCEL_MPS2 + self.policy['psu']['prediction_buffer_s']
        return now+seconds

    def _taxi_clears_before(self, aircraft_id, geometry, radius, now, deadline):
        release = self._taxi_clear_time(aircraft_id,geometry,radius,now)
        return release is not None and release <= deadline

    def _native_leg_seconds(self, phase, a, b):
        horizontal = math.hypot((b[0]-a[0])*111320,
            (b[1]-a[1])*111320*math.cos(math.radians(a[0])))
        speed = max(1.0, phase.speed_mps)
        if phase.stage == 'descent':
            speed = min(speed, self.policy['pilot']['approach_horizontal_speed_mps'])
        vertical_speed = self.policy['pilot']['landing_rate_mps'] if phase.stage == 'landing' else (
            self.policy['pilot']['descent_rate_mps'] if b[2] < a[2] else self.policy['pilot']['climb_rate_mps'])
        return max(horizontal/speed, abs(b[2]-a[2])/max(.1, vertical_speed))

    def _arrival_entry_route(self, aircraft, remaining):
        """Reserve only a disjoint initial approach while departure owns final.

        The untouched suffix remains protected by the departing aircraft. The
        actual arrival must be outside it by both the terminal envelope and a
        braking margin. Every native step rechecks before moving, so a delayed
        departure produces a stop before the shared volume, not a new deadline.
        """
        route, rules = self._arrival_authority_route(aircraft.route), self.policy['psu']
        guard = rules['final_guard_s']+rules['prediction_buffer_s']
        if remaining <= guard or not rules.get('progressive_approach',True):
            return None
        legs = [(phase,a,b,self._native_leg_seconds(phase,a,b))
                for phase in route.phases if phase.stage in ('descent','landing')
                for a,b in zip(phase.points,phase.points[1:])]
        total = sum(seconds for _,_,_,seconds in legs)
        cutoff = total-guard
        if cutoff <= 0:
            return None
        prefix, suffix, elapsed = [], [], 0.
        for phase,a,b,seconds in legs:
            end = elapsed+seconds
            if end <= cutoff:
                prefix.append(Phase('descent','initial approach',[a,b],seconds,phase.speed_mps))
            elif elapsed >= cutoff:
                suffix.append(Phase('descent','protected final',[a,b],seconds,phase.speed_mps))
            else:
                f = (cutoff-elapsed)/max(seconds,1e-12)
                split = tuple(a[i]+(b[i]-a[i])*f for i in range(3))
                prefix.append(Phase('descent','initial approach',[a,split],cutoff-elapsed,phase.speed_mps))
                suffix.append(Phase('descent','protected final',[split,b],end-cutoff,phase.speed_mps))
            elapsed = end
        current = (aircraft.latitude,aircraft.longitude,aircraft.altitude)
        brake = max(.1,self.policy['pilot']['approach_brake_mps2'])
        stopping = aircraft.speed_mps**2/(2*brake)+aircraft.speed_mps*2
        tail = Route((route.key,'final-guard',guard),suffix,route.arrival,route.departure)
        if not terminal_paths.clear_of(tail,'arrival',current,
                self._terminal.horizontal_m+stopping,self._terminal.vertical_m+abs(aircraft.climb_mps)*2):
            return None
        # Include the observed entry position so newly admitted departures must
        # also respect the aircraft just before the authored descent starts.
        if aircraft.index < (route.descent_index or 0):
            prefix.insert(0,Phase('descent','approach entry',[current,prefix[0].points[0]],0,aircraft.speed_mps))
        key = (route.key,'entry',guard,current if aircraft.index < (route.descent_index or 0) else None)
        return Route(key,prefix,route.arrival,route.departure)


    def _arrival_staging_clear(self, aircraft, departure, observations):
        """An actually empty independent FATO can hold one landed aircraft.

        Its body must leave the dependency's entire taxi and takeoff route open.
        The normal terminal/pad checks still run before vertical entry; ground
        authority alone moves the landed aircraft, and owns all taxi stop lines.
        """
        if not departure.route or not departure.flight:
            return False
        c, port = aircraft.clearance, aircraft.flight['destination']
        departure_pad = departure.route.departure.get('fato') or departure.flight['departure_fato']
        if self._nearby_pads(port,c.fato,departure_pad):
            return False
        if (not self.psu.fato_usable(port, c.fato, aircraft.flight['flight_id'], now_s=self.time_s)
                if self.psu.resource_monitor is not None else
                self._active_pad_owner((port,c.fato)) not in (None,aircraft.flight['flight_id'])):
            return False
        landing = aircraft.route.phases[aircraft.route.landing_index].points[-1]
        point = self._ground_xy(port,landing)
        if any(o.aircraft_id != aircraft.aircraft_id and o.vertiport_id == port
               and math.dist(o.point_m,point) <= self._ground_radius(aircraft)+o.radius_m
               for o in observations):
            return False
        taxi = next((p for p in departure.route.phases if p.stage=='gate_out'),None)
        if taxi is None:
            return False
        if route_geometry(tuple(self._ground_xy(port,p) for p in taxi.points)).occupied_intervals(
                route_geometry((point,)),self._ground_radius(aircraft)+self._ground_radius(departure)):
            return False
        return not self._terminal.overlap(aircraft.route,'arrival',departure.route,'departure')

    def _forecast_arrival_gate(self, aircraft, now, observations, clear_by_s, native_final):
        """Reserve an occupied gate behind its observed departing owner.

        Future intent is exclusive and separate from actual occupancy. A short
        on-pad wait is admitted only on a free, independent landing FATO. A
        stopped dependency cancels airborne admission on the next decision.
        """
        rules, c, flight = self.policy['psu'], aircraft.clearance, aircraft.flight
        if (not rules.get('predictive_ground',True) or not rules['predictive_arrivals']
                or not aircraft.airborne or aircraft.failed or not self.ground_control):
            return False
        observations = tuple(self._ground_observations()) if observations is None else tuple(observations)
        remaining = self._remaining_native(aircraft) if self.pilots else aircraft.route.remaining_to_touchdown(aircraft.index,aircraft.elapsed)
        final = clear_by_s is None
        deadline = (now+remaining+rules.get('landing_staging_wait_s',30.) if final else clear_by_s)
        deadline = min(deadline,now+rules.get('ground_lookahead_s',120.))
        stands = sorted(self._stands_of(flight['destination']),key=lambda s:(s!=c.stand,s!=flight['arrival_stand'],s))
        for stand in stands:
            if not self.psu.tuning.reassign_stand and stand != flight['arrival_stand']:
                continue
            if native_final and stand != c.stand:
                continue
            owner = self.psu._stands.occupant(flight['destination'],stand)
            departure = self.aircraft.get(owner)
            if (not departure or not departure.flight or departure.phase!='gate_out'
                    or departure.flight['origin']!=flight['destination']
                    or departure.flight['departure_stand']!=stand
                    or self.psu._stands.reservation(flight['destination'],stand) not in (None,flight['flight_id'])):
                continue
            candidate = self._arrival_candidate(aircraft,stand)
            if candidate is None:
                continue
            geometry = route_geometry(tuple(self._ground_xy(flight['destination'],p) for p in candidate.points))
            radius = self._ground_radius(aircraft)+self._ground_radius(departure)
            # Include the stand's authored radius when proving off-block release.
            gate = next((g for g in self._layout(flight['destination'])['gates'] if g['id']==stand),{})
            spot = route_geometry((self._ground_xy(flight['destination'],self._stand_place(flight['destination'],stand)),))
            gate_time = self._taxi_clear_time(owner,spot,max(radius,float(gate.get('radius_m',7.2))+self._ground_radius(departure)),now)
            exit_time = self._taxi_clear_time(owner,geometry,radius,now)
            if gate_time is None or exit_time is None or max(gate_time,exit_time)>deadline:
                continue
            release = max(gate_time,exit_time)
            if self._gate_path_blockers(aircraft,candidate,observations,now=now,clear_by_s=deadline):
                continue
            if final and (rules.get('landing_staging_wait_s',30.)<=0
                          or not self._arrival_staging_clear(aircraft,departure,observations)):
                continue
            if c.stand != stand or aircraft.route.arrival.get('gate') != stand:
                if not self._retarget_arrival_gate(aircraft,stand,expected_departure=owner):
                    continue
            else:
                self.psu._stands.reserve_future(flight['destination'],stand,flight['flight_id'],owner)
            c.gate_release_aircraft_id, c.gate_available_s = owner, release
            c.landing_staging = final
            c.gate_reason = ('선착륙 후 FATO 대기' if final else '출발편 뒤 게이트 선예약')+f' · {owner} → {stand}'
            self._decision(now,flight,'arrival_resources','staging' if final else 'forecast',c.gate_reason,
                           vertiport=flight['destination'],fato=c.fato,stand=stand,
                           gate_release_aircraft_id=owner,gate_available_s=round(release,1),
                           landing_staging=final)
            return True
        return False

    def _gate_path_blockers(self, aircraft, phase, observations=None, *, now=None, clear_by_s=None, geometry=None):
        port = aircraft.flight['destination']
        if geometry is None:
            geometry = route_geometry(tuple(self._ground_xy(port,p) for p in phase.points))
        start = 0.0
        if aircraft.phase == 'gate_in' and aircraft.ground and phase is aircraft.route.phases[aircraft.index]:
            total = phase.detail.get('ground_motion',{}).get('distances_m',[1])[-1]
            start = aircraft.ground['distance_m']/max(total,1e-12)*geometry.length_m
        observations = self._ground_observations() if observations is None else observations
        return sorted(o.aircraft_id for o in observations
            if o.aircraft_id!=aircraft.aircraft_id and o.vertiport_id==port and
            geometry.occupied_intervals(route_geometry((o.point_m,)),
                                        self._ground_radius(aircraft)+o.radius_m,start)
            and not (clear_by_s is not None and now is not None and
                self._taxi_clears_before(o.aircraft_id,geometry,self._ground_radius(aircraft)+o.radius_m,now,clear_by_s)))

    def _ensure_arrival_gate(self, aircraft, now, observations=None, *, clear_by_s=None):
        """Validate a reachable gate/egress bundle before final entry.

        Existing valid assignments win ties. Moving aircraft keep their route
        until stopped; final native alignment never resets or redirects pose.
        """
        c,flight = aircraft.clearance,aircraft.flight
        if c is None or flight is None or c.state==psu_sequencing.REFUSED:
            return False
        current = c.stand
        c.gate_release_aircraft_id = c.gate_available_s = c.landing_staging = None
        phase = next((p for p in aircraft.route.phases if p.stage=='gate_in'),None)
        if current and current!=aircraft.route.arrival.get('gate'):
            phase = self._arrival_candidate(aircraft,current)
        free = bool(current and self.psu._stands.free(flight['destination'],current,flight['flight_id']))
        blocked = self._gate_path_blockers(aircraft,phase,observations,now=now,clear_by_s=clear_by_s) if phase else []
        if free and phase and not blocked:
            if aircraft.route.arrival.get('gate')!=current:
                return self._retarget_arrival_gate(aircraft,current)
            # A clearance alone is not a live reservation. Reacquire before
            # promising egress, and remove a reason for an obstacle now gone.
            self.psu._stands.reserve(flight['destination'],current,flight['flight_id'])
            if (c.gate_reason or '').startswith(('착륙 출구 확보 대기','사용 가능한 주기장 확보 대기','출발편 뒤 게이트 선예약','선착륙 후 FATO 대기')):
                c.gate_reason = '계획 주기장 유지' if current==flight['arrival_stand'] else f'배정 주기장 {current} 유지'
            return True
        native_final = (aircraft.telemetry.get('guidance') or {}).get('landing_yaw_mutable') is False
        may_change = (not native_final and (not free or blocked) and
                      (aircraft.phase!='gate_in' or aircraft.speed_mps<.01))
        if may_change:
            candidates=[]
            for stand in self._stands_of(flight['destination']):
                if not self.psu.tuning.reassign_stand and stand!=flight['arrival_stand']: continue
                if not self.psu._stands.free(flight['destination'],stand,flight['flight_id']): continue
                candidate=self._arrival_candidate(aircraft,stand)
                if candidate is None: continue
                if aircraft.phase=='gate_in':
                    try:
                        taxi=flight_plan.taxi_path_from_position(self._layout(flight['destination']),
                            (aircraft.latitude,aircraft.longitude),stand)
                    except ValueError: continue
                    candidate=Phase('gate_in','재배정',[(a,b,aircraft.altitude) for a,b in taxi['points']],0,0)
                if self._gate_path_blockers(aircraft,candidate,observations,now=now,clear_by_s=clear_by_s): continue
                candidates.append((stand!=current,stand!=flight['arrival_stand'],candidate.distance_m,stand))
            for *_,stand in sorted(candidates):
                try:
                    if self._retarget_arrival_gate(aircraft,stand): return True
                except ValueError: continue
        if self._forecast_arrival_gate(aircraft,now,observations,clear_by_s,native_final):
            return True
        c.gate_reason = ('착륙 출구 확보 대기: '+', '.join(blocked)) if blocked else '사용 가능한 주기장 확보 대기'
        return False

    def _retarget_arrival_gate(self, aircraft, stand, *, expected_departure=None):
        if aircraft.phase == 'gate_in' and aircraft.speed_mps > .01:
            return False
        # A person has read the gate number and is walking the aircraft to it.
        # An automatic arrival re-plans its taxi inside the same tick and costs
        # nothing to move; a pilot has to be told, and being told a different
        # gate *after landing* is how a taxi ends up at the wrong stand. The
        # guard above only holds while they happen to be rolling, so stopping
        # to read the panel was enough to have the number changed underneath
        # them. Once they are down, the gate they were given stands. Before
        # they leave and while they are in the air it is still free to change:
        # that is where the service is meant to settle it, and where they are
        # told in time to fly to it.
        if aircraft.external and aircraft.external.get('departed') and not aircraft.airborne:
            return False
        flight = aircraft.flight
        reassigned = dict(flight, arrival_stand=stand)
        replacement = self.route(reassigned)
        if replacement.arrival.get("fato") != aircraft.route.arrival.get("fato"):
            raise ValueError("배정 변경이 다른 FATO 접근을 요구합니다")
        ground = next(p for p in replacement.phases if p.stage == 'gate_in')
        if aircraft.phase == 'gate_in':
            taxi = flight_plan.taxi_path_from_position(self._layout(flight['destination']),
                                                      (aircraft.latitude,aircraft.longitude),stand)
            path,profile,_,duration = ground_motion.prepare(taxi['points'],ground.speed_mps,8)
            detail = dict(ground.detail,ground_motion=profile,taxi_nodes=taxi['nodes'])
            ground = Phase('gate_in',ground.label,[(a,b,aircraft.altitude) for a,b in path],duration,ground.speed_mps,detail)
        phases = [ground
                  if p.stage == "gate_in" else p for p in aircraft.route.phases]
        previous = aircraft.route
        rebuilt = Route(previous.key,phases,replacement.arrival,previous.departure)
        rebuilt.direct = previous.direct
        rebuilt.boarding,rebuilt.alighting = previous.boarding,replacement.alighting
        reason = f"도착 경로 재배정 {previous.arrival.get('gate') or flight['arrival_stand']} → {stand}"
        # Check before touching the pilot. The serialized engine is the only
        # reservation writer; publish the reservation/route together only after
        # the fallible native boundary call has returned.
        if aircraft.clearance and not (self.psu._stands.free(flight['destination'],stand,flight['flight_id']) or
                expected_departure is not None and self.psu._stands.occupant(flight['destination'],stand)==expected_departure
                and self.psu._stands.reservation(flight['destination'],stand) in (None,flight['flight_id'])):
            raise ValueError('도착 주기장이 이미 점유 또는 예약되어 있습니다')
        if aircraft.pilot_active and self.pilots and hasattr(self.pilots,'set_landing_yaw'):
            heading = ground.at_fraction(0)[3]
            if heading is not None:
                capable = getattr(getattr(self.pilots,'library',None),'terminal_guidance_capable',True)
                accepted = capable and self.pilots.set_landing_yaw(aircraft.aircraft_id,heading)
                if not accepted: reason += ' · 접지 후 지상 정렬'
        if aircraft.clearance:
            self.psu.assign_arrival_stand(flight['flight_id'],stand,self.time_s,reason,expected_departure=expected_departure)
        # An early arrival reservation may change while taxiing out. Only the
        # arrival path was replaced: retain departure progress and its claim.
        if aircraft.phase == 'gate_in':
            if self.ground_control and aircraft.ground:
                self.ground_control.release(aircraft.aircraft_id,aircraft.ground['route_id'])
            aircraft.ground = None
        aircraft.gate_revision += 1
        if aircraft.clearance: aircraft.clearance.gate_reason = reason
        aircraft.route = rebuilt
        if aircraft.phase == 'gate_in': aircraft.elapsed = 0.0
        self._record(self.time_s,'gate_reassigned',flight,stand=stand,planned_stand=flight['arrival_stand'],
                     reason=reason,gate_revision=aircraft.gate_revision)
        return True

    def _release_arrival_pad(self, aircraft, now):
        """Release native pad ownership after observed taxi clears its radius.

        The legacy kinematic path calls at touchdown. Disabling early release
        keeps either path reserved through arrival at the stand.
        """
        if not self.policy["psu"]["release_pad_at_touchdown"] or aircraft.flight is None:
            return
        flight_id = aircraft.flight["flight_id"]
        pad = (aircraft.flight["destination"],
               (aircraft.route.arrival or {}).get("fato") or aircraft.flight["arrival_fato"])
        if self._active_pad_owner(pad) == flight_id:
            self._release_pad_observation(pad, flight_id, now)
        self.psu.complete(flight_id, psu_sequencing.ARRIVAL, now)
        self._terminal_release(aircraft, 'arrival', now)

    def _hold_phases(self, aircraft, finished, now,ground_observations=None):
        """The three phases of a hold, or None when the aircraft may carry on.

        The hold is entered where the aircraft would otherwise start down the
        arrival corridor: it leaves the corridor, waits clear of it, and comes
        back to the same point. Entering it anywhere later would mean holding on
        the approach, which is the one place a hold must not be.
        """
        clearance = aircraft.clearance
        route = aircraft.route
        if clearance is None or route.descent_index is None:
            return None
        returning = finished.stage == HOLD_RETURN
        if aircraft.index - 1 != route.descent_index and not (self.ground_control and returning):
            return None
        gate_ready = not self.ground_control or self._ensure_arrival_gate(aircraft,now,ground_observations)
        route = aircraft.route
        if returning and gate_ready:
            aircraft.hold = None
            self._holds.get(aircraft.flight['destination'],{}).pop(aircraft.aircraft_id,None)
            return None
        if aircraft.hold is not None and not returning:
            return None
        if not clearance.holding and gate_ready:
            return None
        wait = max(0.0, (clearance.cleared_s or now) - now
                   - route.remaining_to_touchdown(aircraft.index, 0.0))
        if not gate_ready:
            wait = max(wait,self.psu.tuning.stand_wait_s,self.psu.tuning.minimum_hold_s)
            aircraft.instruction = {'clearance':'hold','clearance_reason':clearance.gate_reason}
        if wait < self.psu.tuning.minimum_hold_s:
            return None
        entry = finished.points[-1]
        # The pattern is drawn to fit the wait: far enough out to be clear of the
        # approach, near enough that the aircraft is waiting rather than
        # commuting. Two thirds of the wait is spent getting there and back at
        # most, which leaves a third of it actually stopped.
        rules = self.policy["psu"]
        radius = min(rules["hold_radius_m"],
                     max(rules["hold_min_radius_m"], wait * rules["hold_speed_mps"] / 3.0))
        fix, slot = self._holding_fix(aircraft.flight["destination"], entry, radius)
        aircraft.hold_slot = slot
        travel = flight_plan.haversine_m((entry[0], entry[1]), (fix[0], fix[1]))
        speed = rules["hold_speed_mps"]
        leg_s = travel / speed if speed else 0.0
        # The transition out and back is flown, so only what is left is waited.
        # A wait the round trip has already used up still stops: an aircraft that
        # turned out of the corridor and straight back was never holding.
        station = max(rules["hold_min_station_s"], wait - 2 * leg_s)
        return [
            Phase(HOLD_EXIT, "역천이 · 대기 지점 이동", [entry, fix], leg_s, speed,
                  {"hold_seconds": round(wait, 1)}),
            Phase(HOLD, "PSU 대기", [fix, fix], station, 0.0,
                  {"sequence": clearance.sequence, "hold_seconds": round(wait, 1)}),
            Phase(HOLD_RETURN, "접근 복귀", [fix, entry], leg_s, speed, {}),
        ]

    def _enter_hold(self, aircraft, phases, now):
        route = aircraft.route
        rebuilt = Route(route.key, route.phases[:aircraft.index] + phases + route.phases[aircraft.index:],
                        route.arrival, route.departure)
        rebuilt.direct = route.direct
        rebuilt.boarding,rebuilt.alighting = route.boarding,route.alighting
        aircraft.route = rebuilt
        aircraft.hold = {"entered_s": now, "seconds": phases[0].detail.get("hold_seconds", 0.0),
                         "sequence": aircraft.clearance.sequence if aircraft.clearance else None,

                         # The slot is kept with the hold, so the next aircraft
                         # to wait for this deck is given a different one.
                         "slot": getattr(aircraft, "hold_slot", None)}
        aircraft.hold_seconds += float(aircraft.hold["seconds"] or 0.0)
        aircraft.elapsed = 0.0
        aircraft.phase = HOLD_EXIT
        self._holds.setdefault(aircraft.flight["destination"], {})[aircraft.aircraft_id] = aircraft.hold
        self._record(now, "hold", aircraft.flight, seconds=round(aircraft.hold["seconds"], 1),
                     sequence=aircraft.hold["sequence"])

    def _holding_fix(self, vertiport_id, entry, radius_m=None):
        """A place to wait that is clear of the corridors and of other holders.

        Answers the fix and the slot it took, so the caller can record the slot
        against the aircraft and the next one to wait here is sent elsewhere.
        """
        record = self._vertiports.get(vertiport_id) or {}
        centre = (float(record.get("latitude") or entry[0]), float(record.get("longitude") or entry[1]))
        corridors = self._corridors.get(vertiport_id) or set()
        taken = self._holds.get(vertiport_id) or {}
        used = {holder.get("slot") for holder in taken.values() if holder.get("slot") is not None}
        # Spread horizontally before climbing through an existing holder's
        # altitude. If the ring is full, use a new ring, never wrap to slot 0.
        used = {tuple(slot) if len(slot) == 3 else (*slot, 0) for slot in used}
        bearings = [(index, index * (360.0 / HOLD_SLOTS)) for index in range(HOLD_SLOTS)]
        clear = [(index, bearing) for index, bearing in bearings
                 if not any(_angle_between(bearing, corridor) < CORRIDOR_CLEARANCE_DEG for corridor in corridors)]
        if not clear:
            raise ValueError('접근 회랑과 분리된 대기 구역이 없습니다')
        rules = self.policy['psu']
        pilot = self.policy['pilot']
        minimum = max(HOLD_MIN_RADIUS_M, rules['hold_min_radius_m'])
        maximum = max(minimum, float(rules['hold_radius_m'] if radius_m is None else radius_m))
        inbound = _bearing(centre, entry)
        distance = flight_plan.haversine_m(centre, entry[:2])
        horizontal_speed = max(1.0, min(rules['hold_speed_mps'], pilot['approach_horizontal_speed_mps']))
        vertical_speed = max(.1, min(pilot['climb_rate_mps'], pilot['descent_rate_mps']))
        deck_height = self._deck_height(vertiport_id)
        occupied = [h['fix'] for h in taken.values() if h.get('fix')]
        ring = 0
        while True:
            choices = []
            for index, bearing in clear:
                # The nearest radial point on this clear bearing, bounded by
                # the operator's holding region. Short waits need not commute
                # to its outer rim. Existing outer rings remain a fallback.
                projection = distance * math.cos(math.radians(_angle_between(bearing, inbound)))
                radius = min(maximum + ring * 600.0, max(minimum + ring * 600.0, projection))
                latitude, longitude = _offset(centre, bearing, radius)
                for tier in range(HOLD_TIERS):
                    slot = (index, tier, ring)
                    if slot in used:
                        continue
                    altitude = deck_height + HOLD_BASE_M + tier * HOLD_TIER_M
                    point = (latitude, longitude, altitude)
                    # Different requested radii must not create geometrically
                    # overlapping positions under different slot identifiers.
                    if any(abs(altitude - p[2]) < pilot['traffic_vertical_m'] and
                           flight_plan.haversine_m(point[:2], p[:2]) < pilot['traffic_horizontal_m']
                           for p in occupied):
                        continue
                    travel = flight_plan.haversine_m(entry[:2], point[:2])
                    return_seconds = max(travel / horizontal_speed, abs(altitude-entry[2]) / vertical_speed)
                    choices.append((return_seconds, travel, tier, index, point, slot))
            if choices:
                best = min(choices)
                return best[-2], best[-1]
            ring += 1

    def _arrive(self, aircraft, now):
        """The flight is over: park the aircraft and hand back what it held."""
        if aircraft.flight:
            self.psu.waiting.release(aircraft.flight['flight_id'])
        flight = aircraft.flight
        clearance = aircraft.clearance
        stand = (clearance.stand if clearance else None) or flight["arrival_stand"]
        self.psu._stands.occupy_reserved(flight['destination'],stand,flight['flight_id'],aircraft.aircraft_id)
        aircraft.vertiport, aircraft.stand = flight["destination"], stand
        spot = self._stand_place(flight["destination"], stand)
        aircraft.place(spot[0], spot[1], spot[2])
        aircraft.speed_mps = aircraft.climb_mps = 0.0
        aircraft.phase = PHASE_PARKED
        # People do not vanish when the wheels stop. The plan drew the walk off
        # against this stand; the aircraft holds them until the last one is
        # away, and the turnaround cannot finish before that.
        carried = int(aircraft.passengers or 0)
        walk = aircraft.route.alighting if aircraft.route else None
        unload_s = max(ALIGHTING_MIN_S, float((walk or {}).get("duration_s") or 0.0)) if carried else 0.0
        aircraft.unloading = {"from_s": now, "duration_s": round(unload_s, 1), "count": carried,
                              "flight_id": flight["flight_id"], "vertiport": flight["destination"],
                              "stand": stand, "schedule": walk} if carried and not aircraft.external else None
        aircraft.passengers = carried
        aircraft.completed += 1
        cabin = flight_schedule.seat_class(aircraft.seats)
        aircraft.ready_s = now + max(cabin["turnaround_seconds"], unload_s)
        self._release_pads_by_owner(flight["flight_id"], now)
        self.psu.complete(flight["flight_id"], psu_sequencing.ARRIVAL, now)
        self._entry_forecasts.pop(flight['flight_id'], None)
        self._arrival_reviews.pop(flight['flight_id'], None)
        self._terminal_release(aircraft, 'arrival', now)
        self._terminal_release(aircraft, 'departure', now)
        holders = self._holds.get(flight["destination"])
        if holders:
            holders.pop(aircraft.aircraft_id, None)
        self._record(now, "in_block", flight, stand=stand,
                     hold_s=round(aircraft.hold_seconds, 1),
                     late_s=round(now - (flight["in_block_s"] or now), 1))
        scenario_energy.arrive(self, aircraft, now)
        aircraft.flight, aircraft.route, aircraft.clearance, aircraft.hold = None, None, None, None
        aircraft.index, aircraft.elapsed, aircraft.hold_seconds = 0, 0.0, 0.0

    def _record(self, now, kind, flight, **detail):
        self._event_sequence += 1
        self.events.append({"event_sequence": self._event_sequence,
                            "departure_fato": flight.get('departure_fato'),
                            "arrival_fato": flight.get('arrival_fato'), "time_s": round(now, 1), "clock": flight_schedule.clock_text(now),
                            "kind": kind, "flight_id": flight["flight_id"],
                            "aircraft_id": flight["aircraft_id"],
                            "origin": flight["origin"], "destination": flight["destination"], **detail})
        if len(self.events) > 20000:
            del self.events[:5000]

    # ---- what the world looks like now -------------------------------------
    def states(self):
        """Every aircraft, wherever it is. Parked ones included: a deck with
        nothing standing on it looks broken, and the day starts with 84 of them."""
        return [self._state(aircraft) for aircraft in self.aircraft.values()]

    def _phase_share(self, aircraft):
        """How far through its current phase the aircraft is, 0 to 1."""
        route = aircraft.route
        if route is None or not (0 <= aircraft.index < len(route.phases)):
            return 1.0
        phase = route.phases[aircraft.index]
        if phase.duration_s <= 0:
            return 1.0
        return min(1.0, max(0.0, aircraft.elapsed / phase.duration_s))

    def _tilt(self, aircraft):
        """Where the rotors point: measured if a pilot is flying it, planned if not."""
        measured = aircraft.telemetry.get("tilt_deg")
        if isinstance(measured, (int, float)) and measured == measured and aircraft.airborne:
            return float(measured)
        if not aircraft.airborne:
            return 0.0
        return flight_mode.tilt_for(aircraft.phase, self._phase_share(aircraft))

    def _adherence(self, aircraft, now):
        """This flight against the plan it was given: where it should be by now.

        `progress` is how far through the flight as it is being flown, holds
        included — they are part of the flight, not an interruption to it.
        `plan_share` is how far through the planned block time the clock has
        come, so the two together say whether the flight is keeping up.
        """
        flight, route = aircraft.flight, aircraft.route
        if flight is None or route is None:
            return None
        progress = route.share_at(aircraft.index, aircraft.elapsed)
        off_block = flight.get("off_block_s")
        # Block time if the plan gave one, and otherwise as far as the plan does
        # say — a schedule that only names a touchdown still says how long the
        # flight was meant to take.
        ends = flight.get("in_block_s") or flight.get("touchdown_s")
        planned = (float(ends) - float(off_block)) if (off_block is not None and ends is not None) else None
        plan_share = None if not planned or planned <= 0 else min(1.5, max(0.0, (now - float(off_block)) / planned))
        touchdown = flight.get("touchdown_s")
        expected = now + route.remaining_to_touchdown(aircraft.index, aircraft.elapsed)
        return {
            "progress": round(progress, 4),
            "plan_share": None if plan_share is None else round(plan_share, 4),
            "planned_block_s": None if planned is None else round(planned, 1),
            "elapsed_s": round(max(0.0, now - float(off_block)), 1) if off_block is not None else None,
            "remaining_s": round(route.remaining_to_touchdown(aircraft.index, aircraft.elapsed), 1),
            # Late is positive. Measured against the touchdown the plan asked
            # for, because that is the time the service and the deck were told.
            "delay_s": None if touchdown is None else round(expected - float(touchdown), 1),
            "planned_touchdown_s": None if touchdown is None else round(float(touchdown), 1),
            "expected_touchdown_s": round(expected, 1),
        }

    def _passenger_flow(self, aircraft, now):
        """Who is getting on or off right now, and how far along they are."""
        from digital_twin.model_library.passenger_boarding import onboard
        unloading = aircraft.unloading
        if unloading:
            span = max(0.0, float(unloading["duration_s"]))
            done = 1.0 if span <= 0 else min(1.0, max(0.0, (now - unloading["from_s"]) / span))
            count = int(unloading["count"])
            remaining = onboard(unloading.get("schedule"), now-unloading["from_s"], True)
            return {"phase": "alighting", "count": count, "moved": count-remaining,
                    "on_board": remaining,
                    "elapsed_s": round(max(0.0, now - unloading["from_s"]), 1),
                    "duration_s": round(span, 1), "share": round(done, 3),
                    "vertiport": unloading["vertiport"], "stand": unloading["stand"]}
        route, flight = aircraft.route, aircraft.flight
        walk = route.boarding if route else None
        count = int(aircraft.passengers or 0)
        if flight is None or not count:
            return None
        # Boarding is over when the walk is over, not when the taxi is: the plan
        # holds the aircraft on its stand for the walk and then rolls, so an
        # aircraft still taxiing has everybody aboard.
        span = max(0.0, float((walk or {}).get("duration_s") or 0.0))
        if aircraft.phase == "gate_out" and walk and aircraft.elapsed < span:
            done = 1.0 if span <= 0 else min(1.0, max(0.0, aircraft.elapsed / span))
            seated = onboard(walk, aircraft.elapsed)
            return {"phase": "boarding", "count": count, "moved": seated,
                    "on_board": seated,
                    "elapsed_s": round(aircraft.elapsed, 1), "duration_s": round(span, 1),
                    "share": round(done, 3),
                    "vertiport": flight["origin"], "stand": flight["departure_stand"]}
        return {"phase": "aboard", "count": count, "moved": count, "on_board": count,
                "elapsed_s": None, "duration_s": None, "share": 1.0,
                "vertiport": None, "stand": None}

    def _state(self, aircraft):
        tilt = self._tilt(aircraft)
        flow = self._passenger_flow(aircraft, self.time_s)
        mode = flight_mode.mode_of(aircraft.phase, tilt, self._phase_share(aircraft))
        return {
            "aircraft_id": aircraft.aircraft_id,
            "flight_id": aircraft.flight["flight_id"] if aircraft.flight else None,
            "battery_pct": round(aircraft.battery_pct, 3),
            "energy": aircraft.energy.snapshot(),
            "charging_connection": dict(aircraft.energy.connection, state=aircraft.energy.charge_state) if aircraft.energy.connection else None,
            "latitude_deg": aircraft.latitude, "longitude_deg": aircraft.longitude,
            "altitude_m": aircraft.altitude, "heading_deg": aircraft.heading,
            "speed_mps": aircraft.speed_mps,
            "velocity_ned_mps": aircraft.telemetry.get("velocity_ned_mps") if aircraft.pilot_active or aircraft.external else None,
            "climb_mps": round(aircraft.climb_mps, 3),
            "pitch_deg": aircraft.telemetry.get("pitch_deg", 0.0),
            "roll_deg": aircraft.telemetry.get("roll_deg", 0.0),
            "tilt_deg": tilt,
            "flight_mode": mode, "flight_mode_label": flight_mode.label(mode),
            "adherence": self._adherence(aircraft, self.time_s),
            "passenger_flow": flow,
            "door_state": ("OPENING" if flow["elapsed_s"]<2 else "CLOSING" if flow["elapsed_s"]>flow["duration_s"]-2 else "OPEN") if flow and flow["phase"] in ("boarding","alighting") else "CLOSED",
            "on_board": (flow or {}).get("on_board", 0),
            "track_points": len(aircraft.trail),
            "control_surface_deg": aircraft.telemetry.get("control_surface_deg") if aircraft.airborne else None,
            "rotor_radps": aircraft.telemetry.get("rotor_radps", 0.0),
            "engine": self.pilots.mode if self.pilots and aircraft.airborne else "kinematic-ground" if self.pilots else "kinematic-rehearsal",
            "pilot_failed": aircraft.failed,
            "instruction": dict(aircraft.instruction),
            "ground_waiting": (aircraft.phase in ('gate_out','gate_in') and
                               aircraft.instruction.get('action')=='ground_wait' and aircraft.speed_mps<.1),
            "ground_radius_m": self._ground_radius(aircraft),
            "ground_footprint_source": 'conservative_fallback',
            "gate_assignment": self._gate_assignment(aircraft),
            "guidance": dict(aircraft.telemetry.get('guidance') or {'available':False,'reason':'unavailable'}),
            "clearance": aircraft.clearance.as_dict() if aircraft.clearance else None,
            "phase": aircraft.phase, "airborne": aircraft.airborne,
            "seats": aircraft.seats, "seat_class": aircraft.seat_class,
            "asset_id": aircraft.asset_id, "type_id": aircraft.type_id,
            "passengers": aircraft.passengers,
            "vertiport": aircraft.vertiport, "stand": aircraft.stand,
            "origin": aircraft.flight["origin"] if aircraft.flight else aircraft.vertiport,
            "destination": aircraft.flight["destination"] if aircraft.flight else None,
            "holding": aircraft.phase in HOLD_PHASES,
            "direct": bool(aircraft.route.direct) if aircraft.route else False,
            "hold_seconds": round(aircraft.hold_seconds, 1),
            "sequence": aircraft.clearance.sequence if aircraft.clearance else None,
        }

    @staticmethod
    def _gate_assignment(aircraft):
        if not aircraft.flight: return None
        c=aircraft.clearance
        return {'planned_stand':aircraft.flight['arrival_stand'],
                'assigned_stand':c.stand if c else None,
                'revision':aircraft.gate_revision,'reason':c.gate_reason if c else '도착 주기장 미배정'}

    def summary(self):
        airborne = [aircraft for aircraft in self.aircraft.values() if aircraft.airborne]
        holding = [aircraft for aircraft in airborne if aircraft.phase in HOLD_PHASES]
        parked = [aircraft for aircraft in self.aircraft.values() if aircraft.phase == PHASE_PARKED]
        flown = sum(aircraft.completed for aircraft in self.aircraft.values())
        started = sum(aircraft.completed + (1 if aircraft.flight else 0) for aircraft in self.aircraft.values())
        return {
            "schema_version": SCHEMA_VERSION,
            "flight_engine": self.pilots.mode if self.pilots else "kinematic-rehearsal",
            "pilot_failures": sum(a.failed for a in self.aircraft.values()),
            "time_s": round(self.time_s, 1), "clock": flight_schedule.clock_text(self.time_s),
            "opens_s": self.opens_s, "closes_s": self.closes_s,
            "progress": 0.0 if self.closes_s <= self.opens_s else
                        min(1.0, max(0.0, (self.time_s - self.opens_s) / (self.closes_s - self.opens_s))),
            "aircraft": len(self.aircraft), "airborne": len(airborne), "parked": len(parked),
            # On a flight, taxi included: what an operator counts as "out".
            "active": sum(1 for aircraft in self.aircraft.values() if aircraft.flight is not None),
            # Airframes with nothing left to fly today. They are still parked and
            # still drawn; this only says the day is over for them.
            "finished": sum(1 for aircraft in self.aircraft.values() if aircraft.finished),
            "holding": len(holding), "flights": len(self.flights),
            "flights_started": started, "flights_completed": flown,
            "flights_remaining": max(0, len(self.flights) - started),
            "passengers_carried": sum(aircraft.passengers for aircraft in airborne),
            "cancelled": sum(aircraft.cancelled for aircraft in self.aircraft.values()),
            # Flights down a corridor nobody drew, because the route network
            # does not join those two decks. Reported so the day is not read as
            # having been flown on designed routes when it was not.
            "direct_flights": self.direct_flights,
            "psu": self.psu.statistics(),
            "problems": len(self.problems),
        }

    def track(self, aircraft_id):
        """The path this airframe has flown on the flight it is flying.

        Points as `[state_s, longitude, latitude, altitude_m]`, oldest first —
        the order and shape a path is drawn from. Empty between flights, because
        the track belongs to a flight rather than to the airframe.
        """
        aircraft = self.aircraft.get(aircraft_id) or self.aircraft.get(str(aircraft_id).split(":", 1)[-1])
        if aircraft is None:
            return None
        flown = self.flights.get(aircraft.trail_flight) or {}
        return {
            "aircraft_id": aircraft.aircraft_id,
            "flight_id": aircraft.trail_flight,
            "flying": aircraft.flight is not None,
            "origin": flown.get("origin"),
            "destination": flown.get("destination"),
            "departed_s": aircraft.departed_s,
            "time_s": round(self.time_s, 1),
            "points": [[round(lon, 7), round(lat, 7), round(alt, 2), moment]
                       for moment, lat, lon, alt in aircraft.trail],
        }

    def flight_detail(self, flight_id):
        """Everything known about one flight, for the panel that asked about it."""
        flight = self.flights.get(flight_id)
        if flight is None:
            return None
        aircraft = next((item for item in self.aircraft.values()
                         if item.flight and item.flight["flight_id"] == flight_id), None)
        clearance = self.psu.clearance(flight_id)
        return {
            "flight": dict(flight),
            "state": self._state(aircraft) if aircraft else None,
            "clearance": clearance.as_dict() if clearance else None,
            "events": [event for event in self.events if event["flight_id"] == flight_id][-20:],
        }
