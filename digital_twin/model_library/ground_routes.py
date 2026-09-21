"""Static polyline geometry for conservative circular ground footprints.

Geometry uses local north/east metres. Capsules cover the full linear sweep,
not only sampled aircraft centres. Bounded caches contain static geometry;
no aircraft observations or live runtime state are retained here.
"""
from bisect import bisect_right
from collections import OrderedDict, namedtuple
from dataclasses import dataclass
from functools import lru_cache, wraps, cached_property
import heapq
import math
import struct
import sys
from threading import RLock

_EPS = 1e-10
_CACHE_CLEARANCE_QUANTUM_M = 1e-3
_CONFLICT_CACHE_MAX_BYTES = 128*1024*1024
_CONFLICT_CACHE_MAX_ENTRIES = 2048
_CELL = struct.Struct('<Idd')  # Exact float64 bounds; other segment is the group index.
_INTERVAL = struct.Struct('<dd')
_ConflictCacheInfo = namedtuple('ConflictCacheInfo',
                               'hits misses maxsize currsize bytes evictions')


@dataclass(frozen=True, slots=True)
class _PackedConflictCells:
    groups: tuple[bytes, ...]
    count: int
    interval_groups: tuple[bytes, ...] = ()

    def __len__(self):
        return self.count

    def __iter__(self):
        # Preserve the former own-segment/other-segment order for diagnostics.
        # Runtime consumers read group buffers directly, without this merge.
        def cells(j, data):
            return ((i, j, low, high) for i, low, high in _CELL.iter_unpack(data))
        return heapq.merge(*(cells(j, data) for j, data in enumerate(self.groups) if data),
                           key=lambda cell: (cell[0], cell[1]))

    def retained_bytes(self):
        return (sys.getsizeof(self)+sys.getsizeof(self.count)+sys.getsizeof(self.groups)
                +sum(sys.getsizeof(data) for data in self.groups)
                +sys.getsizeof(self.interval_groups)+sum(sys.getsizeof(data) for data in self.interval_groups))


def _route_retained_bytes(route):
    # Charge shared geometry to each key conservatively. Eviction therefore
    # bounds retained key references as well as the packed cell payload.
    return (sys.getsizeof(route)+sys.getsizeof(route.__dict__)
            +sys.getsizeof(route.points)+sum(sys.getsizeof(point)
                +sum(sys.getsizeof(value) for value in point) for point in route.points)
            +sys.getsizeof(route.distances)+sum(map(sys.getsizeof, route.distances))
            +sys.getsizeof(route.bounds)+sum(map(sys.getsizeof, route.bounds)))


def _bounded_conflict_cache(compute):
    entries = OrderedDict()
    lock = RLock()
    hits = misses = retained = evictions = 0

    @wraps(compute)
    def cached(route, other, radius):
        nonlocal hits, misses, retained, evictions
        key = (route, other, radius)
        with lock:
            if key in entries:
                hits += 1
                entries.move_to_end(key)
                return entries[key][0]
            misses += 1
        result = compute(route, other, radius)
        cost = (result.retained_bytes()+_route_retained_bytes(route)+_route_retained_bytes(other)
                +sys.getsizeof(key)+sys.getsizeof(radius)+256)  # LRU/dict entry overhead.
        with lock:
            if key in entries:  # Another reader may have completed the same static pair.
                entries.move_to_end(key)
                return entries[key][0]
            if cost <= _CONFLICT_CACHE_MAX_BYTES:
                while entries and (retained+cost > _CONFLICT_CACHE_MAX_BYTES or
                                   len(entries) >= _CONFLICT_CACHE_MAX_ENTRIES):
                    _, (_, previous_cost) = entries.popitem(last=False)
                    retained -= previous_cost
                    evictions += 1
                entries[key] = (result, cost)
                retained += cost
        return result

    def cache_clear():
        nonlocal hits, misses, retained, evictions
        with lock:
            entries.clear()
            hits = misses = retained = evictions = 0

    def cache_info():
        with lock:
            return _ConflictCacheInfo(hits, misses, _CONFLICT_CACHE_MAX_ENTRIES,
                                      len(entries), retained, evictions)

    cached.cache_clear = cache_clear
    cached.cache_info = cache_info
    return cached


def _route_cache_clearance(radius):
    """Upper-only cache envelope; exact point/capsule helpers are unchanged.

    A half-cell positive guard keeps nominal model sizes off cell boundaries.
    At ordinary metre scales the added radius is at most 1.5 cells. At extreme
    finite magnitudes a cell is below one ULP: preserve the finite input rather
    than overflow or reduce its clearance.
    """
    if not math.isfinite(radius) or radius < 0.:
        raise ValueError('route clearance must be finite and nonnegative')
    scaled = radius/_CACHE_CLEARANCE_QUANTUM_M
    if not math.isfinite(scaled):
        return radius
    upper = math.ceil(scaled+.5)*_CACHE_CLEARANCE_QUANTUM_M
    return max(radius, upper) if math.isfinite(upper) else radius


def _dot(a, b):
    return a[0]*b[0]+a[1]*b[1]


def _sub(a, b):
    return a[0]-b[0], a[1]-b[1]


def _lerp(a, b, t):
    return a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t


def _band(value, slope, low, high):
    # Called twice for every capsule test, so the two-element sort and the
    # clamping builtins are written out rather than called.
    if -_EPS < slope < _EPS:
        return (0., 1.) if low-_EPS <= value <= high+_EPS else None
    a = (low-value)/slope
    b = (high-value)/slope
    if a > b:
        a, b = b, a
    if a < 0.:
        a = 0.
    if b > 1.:
        b = 1.
    return (a, b) if a <= b+_EPS else None


def _circle_interval(a, b, centre, radius):
    # The arithmetic below is `_sub`/`_dot` written out. This is the innermost
    # function of the ground permission pass -- tens of thousands of calls per
    # tick, every one of them five Python frames deep for six multiplications --
    # so the helpers are spelled out here and kept above for everyone else.
    ax, ay = a
    bx, by = b
    cx, cy = centre
    vx, vy = bx-ax, by-ay
    ox, oy = ax-cx, ay-cy
    aa = vx*vx+vy*vy
    bb = ox*vx+oy*vy
    cc = ox*ox+oy*oy-radius*radius
    if aa < _EPS:
        return (0., 1.) if cc <= _EPS else None
    discriminant = bb*bb-aa*cc
    if discriminant < -_EPS:
        return None
    root = math.sqrt(discriminant if discriminant > 0. else 0.)
    low, high = (-bb-root)/aa, (-bb+root)/aa
    if low < 0.:
        low = 0.
    if high > 1.:
        high = 1.
    return (low, high) if low <= high+_EPS else None


def capsule_interval(a, b, c, d, radius):
    """Parameter interval of segment AB within radius of segment CD."""
    cx, cy = c
    dx, dy = d
    axis_x, axis_y = dx-cx, dy-cy
    length = math.hypot(axis_x, axis_y)
    if length < _EPS:
        return _circle_interval(a, b, c, radius)
    ax, ay = a
    unit_x, unit_y = axis_x/length, axis_y/length
    normal_x, normal_y = -unit_y, unit_x
    ox, oy = ax-cx, ay-cy
    vx, vy = b[0]-ax, b[1]-ay
    intervals = [x for x in (_circle_interval(a, b, c, radius),
                             _circle_interval(a, b, d, radius)) if x is not None]
    along = _band(ox*unit_x+oy*unit_y, vx*unit_x+vy*unit_y, 0., length)
    across = _band(ox*normal_x+oy*normal_y, vx*normal_x+vy*normal_y, -radius, radius)
    if along is not None and across is not None:
        low, high = max(along[0], across[0]), min(along[1], across[1])
        if low <= high+_EPS:
            intervals.append((low, high))
    if not intervals:
        return None
    # The capsule is convex, so the union is a single interval.
    return min(x[0] for x in intervals), max(x[1] for x in intervals)


@dataclass(frozen=True)
class RouteGeometry:
    points: tuple[tuple[float, float], ...]
    distances: tuple[float, ...]
    bounds: tuple[float, float, float, float]

    @cached_property
    def _hash_value(self):
        return hash((self.points,self.distances,self.bounds))

    def __hash__(self):
        # Static geometry is immutable. Avoid walking hundreds of coordinates
        # again for every bounded-cache or per-decision dictionary lookup.
        return self._hash_value

    @property
    def length_m(self):
        return self.distances[-1]

    def point_at(self, distance_m):
        if len(self.points) == 1:
            return self.points[0]
        distance = max(0., min(self.length_m, distance_m))
        index = min(len(self.points)-2, max(0, bisect_right(self.distances, distance)-1))
        span = self.distances[index+1]-self.distances[index]
        return _lerp(self.points[index], self.points[index+1],
                     (distance-self.distances[index])/span)

    def occupied_intervals(self, other, radius_m, start_m=0., end_m=None,
                           other_start_m=0., other_end_m=None):
        """Own arc-length intervals whose swept disc intersects the other path."""
        end = self.length_m if end_m is None else end_m
        other_end = other.length_m if other_end_m is None else other_end_m
        if start_m > end or other_start_m > other_end:
            return ()
        if len(other.points) == 1:
            # Observed obstacle positions are transient, not static cache keys.
            # Broad-phase bounds only reject distant points. The extra metre
            # keeps numeric tangency tolerance entirely in the exact test.
            x,y=other.points[0];margin=abs(radius_m)+1.
            lo_x,lo_y,hi_x,hi_y=self.bounds
            if x<lo_x-margin or x>hi_x+margin or y<lo_y-margin or y>hi_y+margin:
                return ()
            intervals = []
            for _,a,b,origin,span,lo_x,lo_y,hi_x,hi_y in _bounded_segments(self):
                if origin+span < start_m-_EPS or origin > end+_EPS:
                    continue
                if x<lo_x-margin or x>hi_x+margin or y<lo_y-margin or y>hi_y+margin:
                    continue
                interval = _circle_interval(a, b, other.points[0], radius_m)
                if interval is not None:
                    low = max(start_m, origin+span*interval[0])
                    high = min(end, origin+span*interval[1])
                    if low <= high+_EPS:
                        intervals.append((low, high))
            return _merge(intervals)
        # Only route-vs-route static geometry receives conservative cache
        # padding. The point-observation branch above uses its exact radius.
        radius_m = _route_cache_clearance(radius_m)
        if other_start_m <= 0. and other_end >= other.length_m:
            return tuple((max(start_m, low), min(end, high))
                         for low, high in _static_intervals(self, other, radius_m)
                         if high >= start_m-_EPS and low <= end+_EPS)
        first = min(len(other.points)-2,
                    max(0, bisect_right(other.distances, other_start_m)-1))
        last = min(len(other.points)-2,
                   max(first, bisect_right(other.distances, other_end)-1))
        intervals = list(_segment_range_intervals(self, other, radius_m, first+1, last-1))
        cells_by_segment = _cells_by_other_segment(self, other, radius_m)
        # Only the two clipped boundary segments need fresh capsule arithmetic.
        # All complete segments are a reusable static path slice.
        for j in sorted({first, last}):
            origin_b = other.distances[j]
            span_b = other.distances[j+1]-origin_b
            c = _lerp(other.points[j], other.points[j+1],
                      max(0., (other_start_m-origin_b)/span_b))
            d = _lerp(other.points[j], other.points[j+1],
                      min(1., (other_end-origin_b)/span_b))
            for i, low, high in _CELL.iter_unpack(cells_by_segment[j]):
                if high < start_m-_EPS or low > end+_EPS:
                    continue
                if len(self.points) == 1:
                    a = b = self.points[0]
                    origin = span = 0.
                else:
                    a, b = self.points[i:i+2]
                    origin = self.distances[i]
                    span = self.distances[i+1]-origin
                interval = capsule_interval(a, b, c, d, radius_m)
                if interval is not None:
                    intervals.append((origin+span*interval[0], origin+span*interval[1]))
        return tuple((max(start_m, low), min(end, high)) for low, high in _merge(intervals)
                     if high >= start_m-_EPS and low <= end+_EPS)


def route_geometry(path_m):
    if len(path_m) == 1:
        point = path_m[0]
        return RouteGeometry(path_m, (0.,), (*point, *point))
    return _cached_route_geometry(path_m)


@lru_cache(maxsize=512)
def _cached_route_geometry(path_m):
    """Build a reusable static route, discarding only zero-length segments."""
    clean = [path_m[0]]
    distances = [0.]
    for point in path_m[1:]:
        length = math.dist(clean[-1], point)
        if length > _EPS:
            clean.append(point)
            distances.append(distances[-1]+length)
    points = tuple(clean)
    return RouteGeometry(points, tuple(distances),
                         (min(p[0] for p in points), min(p[1] for p in points),
                          max(p[0] for p in points), max(p[1] for p in points)))


def _segments(route):
    if len(route.points) == 1:
        yield 0, route.points[0], route.points[0], 0., 0.
    else:
        for i, (a, b) in enumerate(zip(route.points, route.points[1:])):
            yield i, a, b, route.distances[i], route.distances[i+1]-route.distances[i]


def _boxes_apart(a, b, c, d, radius):
    return any(max(a[k], b[k])+radius < min(c[k], d[k]) or
               max(c[k], d[k])+radius < min(a[k], b[k]) for k in (0, 1))


@lru_cache(maxsize=512)
def _bounded_segments(route):
    """Reuse exact endpoint bounds without changing samples or arc lengths."""
    return tuple((i, a, b, origin, span,
                  min(a[0], b[0]), min(a[1], b[1]),
                  max(a[0], b[0]), max(a[1], b[1]))
                 for i, a, b, origin, span in _segments(route))


@_bounded_conflict_cache
def _conflict_cells(route, other, radius):
    """Cache intersecting segment pairs, never frame-by-frame geometry scans."""
    a0, a1, a2, a3 = route.bounds
    b0, b1, b2, b3 = other.bounds
    groups = [bytearray() for _ in range(max(1, len(other.points)-1))]
    if a2+radius < b0 or b2+radius < a0 or a3+radius < b1 or b3+radius < a1:
        empty=tuple(bytes(data) for data in groups)
        return _PackedConflictCells(empty,0,empty)
    count = 0
    other_segments = _bounded_segments(other)
    for i, a, b, origin, span, amin_x, amin_y, amax_x, amax_y in _bounded_segments(route):
        for j, c, d, _, _, bmin_x, bmin_y, bmax_x, bmax_y in other_segments:
            if (amax_x+radius < bmin_x or bmax_x+radius < amin_x or
                    amax_y+radius < bmin_y or bmax_y+radius < amin_y):
                continue
            overlap = capsule_interval(a, b, c, d, radius)
            if overlap is None:
                continue
            # Consumers need only the own-route interval; reverse arc bounds
            # were unused and doubled capsule work for every intersecting pair.
            groups[j].extend(_CELL.pack(i, origin+span*overlap[0], origin+span*overlap[1]))
            count += 1
    packed=tuple(bytes(data) for data in groups)
    unions=tuple(b''.join(_INTERVAL.pack(low,high) for low,high in
        _merge((low,high) for _,low,high in _CELL.iter_unpack(data))) for data in packed)
    return _PackedConflictCells(packed,count,unions)


def _merge(intervals):
    merged = []
    for low, high in sorted(intervals):
        if merged and low <= merged[-1][1]+_EPS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], high))
        else:
            merged.append((low, high))
    return tuple(merged)


@lru_cache(maxsize=2048)
def _static_intervals(route, other, radius):
    return _merge(interval for data in _conflict_cells(route,other,radius).interval_groups
                  for interval in _INTERVAL.iter_unpack(data))


def _cells_by_other_segment(route, other, radius):
    # Do not retain a second cache of expanded cells or buffers after eviction.
    return _conflict_cells(route, other, radius).groups


@lru_cache(maxsize=4096)
def _segment_range_intervals(route, other, radius, first, last):
    # Integer segment indices identify static subgeometry, not observed state.
    if last < first:
        return ()
    # Per-segment unions share the raw cell cache's byte budget and eviction.
    # A sliding query sorts compact unions, not every intersecting cell pair.
    groups=_conflict_cells(route,other,radius).interval_groups
    return _merge(interval for data in groups[first:last+1]
                  for interval in _INTERVAL.iter_unpack(data))


@lru_cache(maxsize=1024)
def same_route_geometry(route, other):
    """Recognize the same physical centreline despite reversed/dense samples."""
    if route.points == other.points or route.points == tuple(reversed(other.points)):
        return True
    tolerance = 1e-5
    forward = (math.dist(route.points[0], other.points[0]) <= tolerance and
               math.dist(route.points[-1], other.points[-1]) <= tolerance)
    reverse = (math.dist(route.points[0], other.points[-1]) <= tolerance and
               math.dist(route.points[-1], other.points[0]) <= tolerance)
    if not (forward or reverse) or abs(route.length_m-other.length_m) > tolerance:
        return False
    for a, b in ((route, other), (other, route)):
        # Centreline identity is an exact tolerance check, not a traffic
        # reservation: do not widen it with the operational cache envelope.
        covered = _static_intervals(a, b, tolerance)
        if not covered or covered[0][0] > _EPS or covered[-1][1] < a.length_m-_EPS:
            return False
        if len(covered) != 1:
            return False
    return True

