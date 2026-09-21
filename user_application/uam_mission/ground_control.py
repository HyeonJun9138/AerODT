"""Central, deterministic ground permissions; never an aircraft motion owner.

Each call reads a complete same-tick local-metre observation batch. Claims
protect a swept route prefix, not a guessed future position. Their lower bound
advances only from the caller's actual route progress. Missing claim owners stay
protected until observed again or explicitly released by lifecycle handling.
"""
from dataclasses import dataclass
import math

from digital_twin.contracts.ground_operations import GroundObservation, MovementAuthority
from digital_twin.model_library.ground_motion import ACCEL_MPS2
from digital_twin.model_library.ground_routes import RouteGeometry, route_geometry, same_route_geometry

_STOP_MARGIN_M = .01
_OBSERVATION_TOLERANCE_M = .25
_ARRIVAL_PRIORITY_SECONDS = 60.
_EPS = 1e-7


@dataclass(frozen=True)
class _Claim:
    aircraft_id: str
    vertiport_id: str
    route_id: str
    geometry: RouteGeometry
    radius_m: float
    start_m: float
    end_m: float
    sequence: int
    entered: bool = False


class VertiportGroundControl:
    """Issue safe prefixes; the existing ground executor integrates movement.

    Callers retain aircraft state and enforce braking, route version and clock
    coherence. A finite stop point is not permission to teleport to that point.
    A blocked physical layout remains blocked, without timeout-based escape.
    """

    def __init__(self):
        self._claims = {}
        self._potential_routes = {}
        self._maximum_radius = {}
        self._sequence = 0

    def reset(self):
        """Discard execution-specific permissions, never change observations."""
        self._claims.clear()
        self._potential_routes.clear()
        self._maximum_radius.clear()
        self._sequence = 0

    def configure_routes(self, vertiport_id, paths_m, *, radius_m=7.0):
        """Register immutable possible taxi paths before issuing port claims.

        These paths identify potential conflict zones, not occupied corridors.
        Opposite directions of an identical path share one static geometry.
        Radius is the maximum admitted aircraft envelope for this port. Larger
        requests are rejected, while larger observations remain real obstacles.
        Reset clears this layout together with execution-specific claims.
        """
        if not vertiport_id:
            raise ValueError('vertiport identifier is required')
        if not math.isfinite(radius_m) or radius_m <= 0.:
            raise ValueError('registered maximum radius must be finite and positive')
        routes = {}
        for path in paths_m:
            points = tuple(tuple(point) for point in path)
            if not points or any(len(point) != 2 or not all(math.isfinite(v) for v in point)
                                 for point in points):
                raise ValueError('configured paths require finite north/east points')
            geometry = route_geometry(points)
            canonical = min(geometry.points, tuple(reversed(geometry.points)))
            routes[canonical] = route_geometry(canonical)
        configured = tuple(routes[key] for key in sorted(routes))
        if (any(claim.vertiport_id == vertiport_id for claim in self._claims.values())
                and (configured != self._potential_routes.get(vertiport_id, ())
                     or radius_m != self._maximum_radius.get(vertiport_id))):
            raise ValueError('configure ground layout before issuing port claims')
        self._potential_routes[vertiport_id] = configured
        self._maximum_radius[vertiport_id] = radius_m

    def release(self, aircraft_id, route_id=None):
        """Release a lifecycle-ended route claim, not physical occupancy.

        Observations supplied to subsequent calls remain obstacles regardless
        of this operation. A mismatching route cannot release a newer claim.
        """
        claim = self._claims.get(aircraft_id)
        if claim is not None and (route_id is None or claim.route_id == route_id):
            del self._claims[aircraft_id]

    def authorize(self, requests, observations, now_s):
        """Return route-bound authorities from one immutable input batch.

        Inputs use the same local NE origin within each vertiport. Request
        progress itself locates a moving aircraft when its separate observation
        is omitted. Other missing aircraft are not assumed to have departed.
        """
        if not math.isfinite(now_s):
            raise ValueError('now_s must be finite')
        batch = {}
        geometry = {}
        for request in requests:
            identifier = request.aircraft_id
            if identifier in batch:
                raise ValueError('duplicate ground request: '+identifier)
            route = route_geometry(request.path_m)
            maximum_radius = self._maximum_radius.get(request.vertiport_id)
            if maximum_radius is not None and request.radius_m > maximum_radius:
                raise ValueError('request radius exceeds the registered operating maximum')
            if request.distance_m > route.length_m+_EPS:
                raise ValueError('distance_m exceeds route length')
            claim = self._claims.get(identifier)
            if claim is not None and (claim.route_id != request.route_id or
                                      claim.vertiport_id != request.vertiport_id or
                                      claim.geometry != route):
                raise ValueError('release the old route claim before replacing its route')
            if claim is not None and request.distance_m < claim.start_m-_EPS:
                raise ValueError('route progress cannot rewind an occupied claim')
            batch[identifier] = request
            geometry[identifier] = route
        observed = {}
        for observation in observations:
            if observation.aircraft_id in observed:
                raise ValueError('duplicate ground observation: '+observation.aircraft_id)
            observed[observation.aircraft_id] = observation
        # All input validation precedes mutation of control state.
        for identifier, request in batch.items():
            point = geometry[identifier].point_at(request.distance_m)
            observation = observed.get(identifier)
            if observation is not None:
                if observation.vertiport_id != request.vertiport_id:
                    raise ValueError('request and observation vertiports differ')
                maximum_radius = self._maximum_radius.get(request.vertiport_id)
                if maximum_radius is not None and observation.radius_m > maximum_radius:
                    raise ValueError('active observed radius exceeds the registered operating maximum')
                if math.dist(point, observation.point_m) > _OBSERVATION_TOLERANCE_M:
                    raise ValueError('request progress and same-tick observation disagree')
            else:
                observed[identifier] = GroundObservation(identifier, request.vertiport_id,
                                                        point, request.radius_m)
        # Enclose any small projection roundoff and the larger reported radius.
        radii = {identifier: max(request.radius_m, observed[identifier].radius_m)
                 + math.dist(geometry[identifier].point_at(request.distance_m),
                             observed[identifier].point_m)
                 for identifier, request in batch.items()}
        by_port = {}
        for observation in observed.values():
            by_port.setdefault(observation.vertiport_id, []).append(observation)
        for port in by_port:
            by_port[port].sort(key=lambda item: item.aircraft_id)

        # Pure geometry reuse within this decision only. No observation-derived
        # key or result survives authorize(), unlike static route caches.
        interval_cache = {}

        def occupied(route, other, radius, start, end=None, other_start=0., other_end=None):
            key = (route, other, radius, start, end, other_start, other_end)
            if key not in interval_cache:
                interval_cache[key] = route.occupied_intervals(
                    other, radius, start, end, other_start, other_end)
            return interval_cache[key]

        def priority(request):
            claim = self._claims.get(request.aircraft_id)
            if claim is not None and (claim.entered or request.distance_m > claim.start_m+_EPS):
                return 0, claim.sequence, request.aircraft_id
            # Waiting eventually outweighs the bounded arrival-egress bonus.
            return (1, request.requested_s-(_ARRIVAL_PRIORITY_SECONDS if request.arrival else 0.),
                    request.aircraft_id)

        protected = [claim for identifier, claim in self._claims.items()
                     if identifier not in batch and identifier not in observed]
        next_claims = {claim.aircraft_id: claim for claim in protected}
        result = {}
        ordered = sorted(batch.values(), key=priority)
        for request in ordered:
            identifier = request.aircraft_id
            route = geometry[identifier]
            start = min(request.distance_m, route.length_m)
            stop = route.length_m
            blockers = set()

            def restrict(intervals, blocker):
                nonlocal stop, blockers
                if not intervals:
                    return
                limit = max(start, intervals[0][0]-_STOP_MARGIN_M)
                if limit < stop-_EPS:
                    stop, blockers = limit, {blocker}
                elif abs(limit-stop) <= _EPS:
                    blockers.add(blocker)

            for observation in by_port.get(request.vertiport_id, ()):
                if observation.aircraft_id == identifier:
                    continue
                obstacle = route_geometry((observation.point_m,))
                radius = radii[identifier]+radii.get(observation.aircraft_id, observation.radius_m)
                # Query through the margin before applying the shifted stop line;
                # clipping at an earlier shifted stop would hide a tighter line.
                restrict(occupied(route, obstacle, radius, start,
                                  min(route.length_m, stop+_STOP_MARGIN_M)), observation.aircraft_id)
            for claim in protected:
                if claim.vertiport_id == request.vertiport_id and claim.aircraft_id != identifier:
                    restrict(occupied(route, claim.geometry, radii[identifier]+claim.radius_m,
                                      start, min(route.length_m, stop+_STOP_MARGIN_M),
                                      claim.start_m, claim.end_m),
                             claim.aircraft_id)

            # A blocked winner may not occupy an intersection while awaiting its
            # exit. Retreat its permission to the previous safe point, never its
            # actual position. Iterate because retreat can expose another zone.
            if stop < route.length_m-_EPS:
                egress_zones = []
                for other in ordered:
                    if other.aircraft_id == identifier or other.vertiport_id != request.vertiport_id:
                        continue
                    zones = occupied(route, geometry[other.aircraft_id],
                                     radii[identifier]+radii[other.aircraft_id],
                                     start, route.length_m, other.distance_m)
                    egress_zones.append((zones, other.aircraft_id))
                for potential in self._potential_routes.get(request.vertiport_id, ()):
                    if same_route_geometry(route, potential):
                        continue
                    # Size a safe stop for the largest admitted future aircraft,
                    # not only those already requesting movement this tick.
                    # Its valid future projection error must fit here as well.
                    clearance = (radii[identifier]+self._maximum_radius[request.vertiport_id]
                                 + _OBSERVATION_TOLERANCE_M)
                    zones = occupied(route, potential, clearance,
                                     start, route.length_m)
                    egress_zones.append((zones, None))
                changed = True
                while changed and stop > start+_EPS:
                    changed = False
                    for zones, blocker in egress_zones:
                        for low, high in zones:
                            safe_before = max(start, low-_STOP_MARGIN_M)
                            # Intersection etiquette cannot revoke the braking corridor
                            # of an already moving aircraft. Keep the physically
                            # clear stop; its prefix remains protected from others.
                            braking_end = start+request.speed_mps**2/(2*ACCEL_MPS2)
                            if (safe_before >= braking_end-_EPS and
                                    safe_before < stop-_EPS and stop <= high+_STOP_MARGIN_M+_EPS):
                                stop = safe_before
                                if blocker is not None:
                                    blockers.add(blocker)
                                changed = True
                                break
                        if changed:
                            break
            stop = max(start, stop)
            can_move = stop > start+_EPS
            reason = '지상 경로 막힘: ' if not can_move else '지상 통과 대기: '
            result[identifier] = MovementAuthority(
                stop, request.max_speed_mps if can_move else 0.,
                reason+', '.join(sorted(blockers)) if blockers else '',
                tuple(sorted(blockers)), request.route_id)
            previous = self._claims.get(identifier)
            entered = previous is not None and (previous.entered or start > previous.start_m+_EPS)
            if not entered:
                # Request age is not an acquired right. Reissued, unused claims
                # take this decision's grant order, behind already entered
                # owners. A previously parked aircraft cannot inherit an old
                # sequence and steal a moving owner's braking corridor.
                self._sequence += 1
            # A denied request still reserves its hold point. Losing contact
            # must not silently erase that footprint on the next decision.
            claim = _Claim(identifier, request.vertiport_id, request.route_id, route,
                           radii[identifier], start,
                           stop if request.max_speed_mps > 0. else start,
                           previous.sequence if entered else self._sequence, entered)
            next_claims[identifier] = claim
            protected.append(claim)
        self._claims = next_claims
        return {identifier: result[identifier] for identifier in sorted(result)}
