"""Immutable local north/east metre inputs and route-bound ground permissions."""
from dataclasses import dataclass
from functools import lru_cache
import math


def _number(value, name, *, positive=False, nonnegative=False):
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be finite')
    if positive and value <= 0 or nonnegative and value < 0:
        raise ValueError(f'{name} is outside its allowed range')


def _point(value):
    if len(value) != 2:
        raise ValueError('ground points require north/east coordinates')
    point = tuple(value)
    for component in point:
        _number(component, 'coordinate')
    return point


def _checked_path(path_m):
    points = tuple(_point(point) for point in path_m)
    if not points:
        raise ValueError('a ground route needs at least one point')
    return points


# A taxi route is the vertiport's layout, not a reading: the same few hundred
# points arrive again every tick for every aircraft rolling on them, and walking
# them proved to be the most expensive thing the service did -- a third of the
# whole ground permission pass, spent re-proving that constants are still
# finite. The check is kept in full and paid once per distinct route.
@lru_cache(maxsize=512)
def _cached_checked_path(path_m):
    return _checked_path(path_m)


def _validated_path(path_m):
    path = tuple(path_m)
    try:
        return _cached_checked_path(path)
    except TypeError:
        # A path of lists cannot be a cache key. It is still a path, and
        # rejecting it here would be a new rule rather than a faster one.
        return _checked_path(path)


@dataclass(frozen=True)
class GroundObservation:
    aircraft_id: str
    vertiport_id: str
    point_m: tuple[float, float]
    radius_m: float = 7.0

    def __post_init__(self):
        if not self.aircraft_id or not self.vertiport_id:
            raise ValueError('aircraft and vertiport identifiers are required')
        object.__setattr__(self, 'point_m', _point(self.point_m))
        _number(self.radius_m, 'radius_m', positive=True)


@dataclass(frozen=True)
class GroundRouteProposal:
    """One vertiport-authored taxi alternative offered for PSU comparison.

    The path is expressed in the vertiport's local north/east metre frame.
    ``rank`` is geometric order (one is shortest); live blockers are a factual
    observation attached by the vertiport, not a movement authority.
    """

    vertiport_id: str
    route_id: str
    start_id: str
    goal_id: str
    node_ids: tuple[str, ...]
    path_m: tuple[tuple[float, float], ...]
    distance_m: float
    rank: int
    clear_distance_m: float
    blocked_by: tuple[str, ...] = ()

    def __post_init__(self):
        if not all((self.vertiport_id, self.route_id, self.start_id, self.goal_id)):
            raise ValueError('vertiport, route and endpoint identifiers are required')
        nodes = tuple(str(item) for item in self.node_ids)
        if len(nodes) < 2 or nodes[0] != self.start_id or nodes[-1] != self.goal_id:
            raise ValueError('ground proposal nodes must join the named endpoints')
        path = _validated_path(self.path_m)
        if len(path) != len(nodes):
            raise ValueError('ground proposal nodes and points must have equal length')
        _number(self.distance_m, 'distance_m', nonnegative=True)
        _number(self.clear_distance_m, 'clear_distance_m', nonnegative=True)
        if self.clear_distance_m > self.distance_m + 1e-7:
            raise ValueError('clear_distance_m cannot exceed the route distance')
        if isinstance(self.rank, bool) or int(self.rank) < 1:
            raise ValueError('ground proposal rank must be a positive integer')
        object.__setattr__(self, 'node_ids', nodes)
        object.__setattr__(self, 'path_m', path)
        object.__setattr__(self, 'rank', int(self.rank))
        object.__setattr__(self, 'blocked_by', tuple(sorted({str(item) for item in self.blocked_by})))

    @property
    def clear(self):
        return not self.blocked_by and self.clear_distance_m >= self.distance_m - 1e-7


@dataclass(frozen=True)
class GroundRequest:
    aircraft_id: str
    flight_id: str
    vertiport_id: str
    route_id: str
    path_m: tuple[tuple[float, float], ...]
    distance_m: float
    speed_mps: float
    max_speed_mps: float
    radius_m: float
    requested_s: float
    arrival: bool = False

    def __post_init__(self):
        if not all((self.aircraft_id, self.flight_id, self.vertiport_id, self.route_id)):
            raise ValueError('aircraft, flight, vertiport and route identifiers are required')
        object.__setattr__(self, 'path_m', _validated_path(self.path_m))
        for name in ('distance_m', 'speed_mps', 'max_speed_mps'):
            _number(getattr(self, name), name, nonnegative=True)
        _number(self.radius_m, 'radius_m', positive=True)
        _number(self.requested_s, 'requested_s')


@dataclass(frozen=True)
class MovementAuthority:
    stop_distance_m: float
    speed_limit_mps: float
    reason: str = ''
    blocked_by: tuple[str, ...] = ()
    route_id: str = ''
