"""The people side of a deck: an edge nobody can walk off, and somewhere at each
stand for them to come out of.

Both are derived from a laid-out vertiport rather than designed per pattern, so
these run over every arrangement the library offers and check what must hold
whatever shape it came out: the protection goes right round, and no shelter
stands on a stand, a cabinet, a taxi route or off the deck.
"""
import math

import pytest

from digital_twin.model_library.vertiport_layout import (BOARDING_HEIGHT_M, PATTERNS, generate_layout,
                                                         validate_definition)


def layout_of(pattern, gates=6, fatos=None, **changes):
    fatos = fatos or [{"role": "takeoff"}, {"role": "landing"}]
    definition = dict(name="테스트 버티포트", latitude=37.5, longitude=127.0, heading_deg=0,
                      pattern=pattern, gates=gates, fatos=fatos, platform_height_m=10.0)
    definition.update(changes)
    return generate_layout(validate_definition(definition))


def deck_of(layout):
    corners = layout["platform"]["corners_m"]
    return (min(c[0] for c in corners), max(c[0] for c in corners),
            min(c[1] for c in corners), max(c[1] for c in corners))


ARRANGEMENTS = sorted(PATTERNS)


# ---------------------------------------------------------------- the edge

@pytest.mark.parametrize("pattern", ARRANGEMENTS)
def test_the_protection_goes_right_round_the_deck(pattern):
    layout = layout_of(pattern)
    barrier = layout["barrier"]
    assert barrier["runs_m"], f"{pattern} leaves its deck edge open"
    # Low enough to sit under any approach surface, which is why it can carry on
    # across the side a FATO departs over instead of stopping short of it.
    assert 0.9 <= barrier["height_m"] <= 1.3
    min_x, max_x, min_y, max_y = deck_of(layout)
    sides = set()
    for run in barrier["runs_m"]:
        for x, y in run:
            assert min_x - 0.01 <= x <= max_x + 0.01, "a run stands on the deck"
            assert min_y - 0.01 <= y <= max_y + 0.01
        assert math.dist(run[0], run[1]) >= 2.0, "a run worth building"
        # A straight run stands on the side it starts on; a run that follows a
        # rounded edge right round the deck stands on every side it passes.
        for x, y in (run if len(run) > 2 else run[:1]):
            for name, value, edge in (("x", x, (min_x, max_x)), ("y", y, (min_y, max_y))):
                if abs(value - edge[0]) < barrier["inset_m"] + 0.5:
                    sides.add("-" + name)
                if abs(value - edge[1]) < barrier["inset_m"] + 0.5:
                    sides.add("+" + name)
    assert sides == {"-x", "+x", "-y", "+y"}, f"{pattern} protects only {sorted(sides)}"


@pytest.mark.parametrize("pattern", ARRANGEMENTS)
def test_no_run_stands_inside_a_fato_safety_area(pattern):
    layout = layout_of(pattern)
    for run in layout["barrier"]["runs_m"]:
        for fato in layout["fatos"]:
            gap = _distance_to_segment(fato["center_m"], run[0], run[1])
            assert gap >= fato["safety_radius_m"] - 0.5, (
                f"{pattern}: a run stands {gap:.1f} m from {fato['id']}, inside its safety area")


# ---------------------------------------------------------------- the shelters

@pytest.mark.parametrize("pattern", ARRANGEMENTS)
def test_every_stand_has_a_shelter_beside_its_cabinet(pattern):
    layout = layout_of(pattern)
    points = layout["boarding_points"]
    gates = [gate["id"] for gate in layout["gates"]]
    assert [point["gate"] for point in points] == gates, f"{pattern}: one shelter per stand, in order"
    chargers = {charger["id"]: charger for charger in layout["chargers"]}
    for point in points:
        assert point["charger"] in chargers, "a shelter belongs to a cabinet"
        assert point["height_m"] == BOARDING_HEIGHT_M
        beside = math.dist(point["center_m"], chargers[point["charger"]]["center_m"])
        assert beside < 6.0, f"{pattern}: the shelter is {beside:.1f} m from its cabinet, not beside it"


@pytest.mark.parametrize("pattern", ARRANGEMENTS)
def test_a_shelter_stands_on_the_deck_and_off_everything_already_there(pattern):
    layout = layout_of(pattern)
    min_x, max_x, min_y, max_y = deck_of(layout)
    for point in layout["boarding_points"]:
        half = max(point["size_m"]) / 2
        x, y = point["center_m"]
        assert min_x + half <= x <= max_x - half, f"{pattern}: {point['id']} hangs off the deck"
        assert min_y + half <= y <= max_y - half
        for group, what in ((layout["gates"], "stand"), (layout["fatos"], "FATO")):
            for item in group:
                radius = item.get("safety_radius_m") or item["radius_m"]
                gap = math.dist(point["center_m"], item["center_m"])
                assert gap >= radius + half - 0.5, (
                    f"{pattern}: {point['id']} is {gap:.1f} m from {what} {item['id']}")
        for charger in layout["chargers"]:
            if charger["id"] == point["charger"]:
                continue
            gap = math.dist(point["center_m"], charger["center_m"])
            assert gap >= charger["radius_m"] + half - 0.5, (
                f"{pattern}: {point['id']} overlaps cabinet {charger['id']}")
        for edge in layout["edges"]:
            for start, end in zip(edge["points_m"], edge["points_m"][1:]):
                gap = _distance_to_segment(point["center_m"], start, end)
                assert gap >= edge["width_m"] / 2 + half - 1.0, (
                    f"{pattern}: {point['id']} stands {gap:.1f} m from taxiway {edge['id']}")


@pytest.mark.parametrize("pattern", ARRANGEMENTS)
def test_no_two_shelters_overlap(pattern):
    points = layout_of(pattern)["boarding_points"]
    for index, one in enumerate(points):
        for other in points[index + 1:]:
            gap = math.dist(one["center_m"], other["center_m"])
            needed = max(one["size_m"]) / 2 + max(other["size_m"]) / 2
            assert gap >= needed - 0.5, f"{pattern}: {one['id']} and {other['id']} are {gap:.1f} m apart"


def test_the_walk_and_its_buildings_are_gone():
    # They were replaced by a shelter at each stand: one place people come out
    # of, beside the cabinet, rather than a walk and a stair head that could
    # reach across a stand.
    layout = layout_of("double", gates=8)
    assert "walkways" not in layout
    assert layout["boarding_points"], "and something took their place"


def test_a_turned_vertiport_turns_its_shelters_and_its_barrier_with_it():
    straight = layout_of("row")
    turned = layout_of("row", heading_deg=90)
    assert len(turned["barrier"]["runs_m"]) == len(straight["barrier"]["runs_m"])
    assert len(turned["boarding_points"]) == len(straight["boarding_points"])

    def lengths(layout):
        return sorted(round(math.dist(run[0], run[1]), 2) for run in layout["barrier"]["runs_m"])

    assert lengths(turned) == lengths(straight), "a rigid turn, not a redesign"
    assert turned["barrier"]["runs_m"] != straight["barrier"]["runs_m"], "it really did turn"
    assert turned["boarding_points"][0]["center_m"] != straight["boarding_points"][0]["center_m"]


def _distance_to_segment(point, start, end):
    (px, py), (ax, ay), (bx, by) = point, start, end
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    if length <= 1e-9:
        return math.dist(point, start)
    along = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return math.dist(point, (ax + along * dx, ay + along * dy))
