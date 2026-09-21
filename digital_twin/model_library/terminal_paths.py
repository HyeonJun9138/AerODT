"""Conservative protected volumes for configured terminal flight paths.

This is planning geometry, not predicted aircraft motion. Intersecting or close
terminal routes require an operational sequencing gate; en-route traffic still
uses the existing observed-state traffic awareness.
"""
import math


def segments(route, operation):
    stages = {'takeoff', 'climb'} if operation == 'departure' else {'descent', 'landing'}
    return [(a, b, phase.stage) for phase in route.phases if phase.stage in stages
            for a, b in zip(phase.points, phase.points[1:])]


def _point_distance(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = dx*dx+dy*dy
    t = max(0.0, min(1.0, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0.0
    return math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)


def segment_distance(a, b, c, d):
    def cross(p, q, r):return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    bounds = all(max(min(a[i], b[i]), min(c[i], d[i])) <= min(max(a[i], b[i]), max(c[i], d[i])) for i in (0, 1))
    if bounds and cross(a,b,c)*cross(a,b,d) <= 0 and cross(c,d,a)*cross(c,d,b) <= 0:
        return 0.0
    return min(_point_distance(a,c,d), _point_distance(b,c,d), _point_distance(c,a,b), _point_distance(d,a,b))


def conflict(first, first_kind, second, second_kind, horizontal_m, vertical_m):
    left, right = segments(first, first_kind), segments(second, second_kind)
    if not left or not right:
        return {'reason': 'terminal_geometry_missing'}  # No geometry is not proof of independence.
    origin = left[0][0]
    scale = 111320.0*math.cos(math.radians(origin[0]))
    def xy(p):return ((p[0]-origin[0])*111320.0, (p[1]-origin[1])*scale)
    for a, b, stage_a in left:
        for c, d, stage_b in right:
            vertical_gap = max(min(a[2],b[2]),min(c[2],d[2]))-min(max(a[2],b[2]),max(c[2],d[2]))
            if vertical_gap > vertical_m:
                continue
            distance = segment_distance(xy(a),xy(b),xy(c),xy(d))
            if distance <= horizontal_m:
                return {'reason': 'terminal_paths_overlap', 'horizontal_m': round(distance, 1),
                        'vertical_gap_m': round(max(0.0,vertical_gap), 1),
                        'stages': [stage_a, stage_b]}
    return None


def clear_of(route, kind, position, horizontal_m, vertical_m):
    """A phase change alone does not prove the observed pose left the volume."""
    scale = 111320.0 * math.cos(math.radians(position[0]))
    for a, b, _ in segments(route, kind):
        if min(a[2], b[2]) - vertical_m <= position[2] <= max(a[2], b[2]) + vertical_m:
            left = ((a[0]-position[0])*111320.0, (a[1]-position[1])*scale)
            right = ((b[0]-position[0])*111320.0, (b[1]-position[1])*scale)
            if _point_distance((0, 0), left, right) <= horizontal_m:
                return False
    return True
