"""The edge barrier follows the deck it stands on.

Seen live on a radial deck: four straight rails standing in the air outside a
round platform, squared off around a circle. The barrier was worked out on the
bounding rectangle for every pattern, while the radial pattern draws a full
circle. A rounded deck now gets its rail along the rounded edge.
"""
import math

from digital_twin.model_library.vertiport_layout import (generate_layout, validate_definition, BARRIER_INSET_M,
                                                         _rounded_barrier)
from project_support.tests.web_live.test_vertiport import definition


def layout_of(pattern, **kw):
    return generate_layout(validate_definition(definition(pattern=pattern, **kw)))


def test_a_round_deck_has_its_barrier_on_the_circle_not_the_square():
    layout = layout_of("radial", gates=8, fatos=["takeoff", "landing", "takeoff", "landing"])
    platform = layout["platform"]
    width, depth = platform["size_m"]
    radius = platform["corner_radius_m"]
    assert abs(radius - min(width, depth) / 2) < 1e-3, 'the radial platform is a circle (stored to the millimetre)'
    runs = layout["barrier"]["runs_m"]
    assert runs, 'a round deck still gets edge protection'
    points = [p for run in runs for p in run]
    # The deck is a stadium: the name strip makes it a little deeper than wide,
    # so two semicircles with a short straight between their centres. Every
    # rail point sits `inset` in from that rounded edge - at radius - inset
    # from the stadium's axis - never out on the bounding rectangle's sides.
    half = abs(depth - width) / 2
    along_y = depth >= width
    def axis_distance(x, y):
        a, b = (y, x) if along_y else (x, y)     # a runs along the straight, b across it
        return math.hypot(max(0.0, abs(a) - half), b)
    for x, y in points:
        distance = axis_distance(x, y)
        assert abs(distance - (radius - BARRIER_INSET_M)) < 0.35, f'{distance:.2f} m from the axis, radius {radius:.2f}'
    assert all(abs(x) < width / 2 - BARRIER_INSET_M + 1e-3 and abs(y) < depth / 2 - BARRIER_INSET_M + 1e-3 for x, y in points),         'nothing on the bounding rectangle'
    # It goes right round: the rail covers most of the circumference, less the
    # gaps where the FATO safety areas reach the edge.
    covered = sum(math.dist(a, b) for run in runs for a, b in zip(run, run[1:]))
    perimeter = 2 * math.pi * radius + 4 * half
    assert covered > 0.6 * perimeter, f'{covered:.0f} m of {perimeter:.0f} m'


def test_a_rectangular_deck_keeps_its_straight_two_point_runs():
    layout = layout_of("flank", gates=6, fatos=["takeoff", "landing"])
    assert "corner_radius_m" not in layout["platform"]
    runs = layout["barrier"]["runs_m"]
    assert len(runs) >= 4
    assert all(len(run) == 2 for run in runs), 'straight runs, as before'


def test_the_rail_is_broken_where_a_fato_reaches_the_edge():
    dims = {"fato_radius_m": 10.0, "safety_margin_m": 5.0}
    # A 60 m circle with one FATO pushed against its right-hand edge.
    fatos = [{"design_m": (25.0, 0.0)}]
    out = _rounded_barrier(-30, 30, -30, 30, fatos, dims, 30.0, BARRIER_INSET_M)
    assert len(out["runs"]) == 1, 'one gap, so one run round the rest'
    run = out["runs"][0]
    assert all(math.dist(p, (25.0, 0.0)) >= 15.0 for p in run), 'no rail inside the safety area'
    assert len(run) > 20, 'the arc is sampled, not a single chord'
    # And with nothing in the way, one closed ring.
    whole = _rounded_barrier(-30, 30, -30, 30, [], dims, 30.0, BARRIER_INSET_M)
    assert len(whole["runs"]) == 1 and whole["runs"][0][0] == whole["runs"][0][-1]
