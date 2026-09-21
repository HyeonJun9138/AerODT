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
