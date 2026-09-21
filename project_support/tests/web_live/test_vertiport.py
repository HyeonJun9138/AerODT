"""Vertiport definitions: validation, generated ground layout, storage and the wire."""
import json
import math

import pytest
from fastapi.testclient import TestClient

from data.simulation.vertiport_records import VertiportRecords
from digital_twin.model_library.vertiport_layout import (FATO_SIDES, PATTERNS, SIDED_PATTERNS, VEHICLE_CLASSES,
                                                         describe_options, dimensions_for, generate_layout, rotate,
                                                         validate_definition)
from user_application.apps.web_dashboard.application import create_app


def definition(**changes):
    base = dict(name="김포 버티허브", latitude=37.558, longitude=126.79, heading_deg=0,
                gates=6, fatos=[{"role": "takeoff"}, {"role": "landing"}])
    base.update(changes)
    return base


def test_definition_is_normalised_and_fatos_get_ids():
    normalised = validate_definition(definition(heading_deg=-90, fatos=["takeoff", {"role": "BOTH"}]))
    assert normalised["heading_deg"] == 270
    assert normalised["fatos"] == [{"id": "F1", "role": "takeoff", "side": "front"}, {"id": "F2", "role": "both", "side": "front"}]
    assert normalised["gates"] == 6
    assert "altitude_m" not in normalised


@pytest.mark.parametrize("changes,field", [
    ({"name": ""}, "name"), ({"latitude": 91}, "latitude"), ({"longitude": "east"}, "longitude"),
    ({"gates": 0}, "gates"), ({"gates": 21}, "gates"), ({"fatos": []}, "fatos"),
    ({"fatos": [{"role": "hover"}]}, "fatos[1].role"), ({"latitude": float("nan")}, "latitude"),
    ({"fatos": [{"role": "both"}, {"role": "both", "side": "top"}]}, "fatos[2].side")])
def test_invalid_definitions_name_the_field(changes, field):
    with pytest.raises(ValueError) as error:
        validate_definition(definition(**changes))
    assert str(error.value).startswith(field + ":")


def test_layout_has_every_gate_and_fato_with_markings_and_roles():
    layout = generate_layout(validate_definition(definition()))
    assert [gate["marking"] for gate in layout["gates"]] == [f"G{i}" for i in range(1, 7)]
    assert [fato["marking"] for fato in layout["fatos"]] == ["F", "F"]
    assert [fato["role"] for fato in layout["fatos"]] == ["takeoff", "landing"]
    dims = layout["dimensions"]
    assert all(gate["radius_m"] == dims["gate_radius_m"] for gate in layout["gates"])
    assert all(fato["radius_m"] == dims["fato_radius_m"] for fato in layout["fatos"])
    assert all(fato["safety_radius_m"] > fato["radius_m"] for fato in layout["fatos"])
    assert layout["frame"]["latitude"] == 37.558 and layout["frame"]["heading_deg"] == 0
    assert "not a surveyed" in layout["note"]


def test_circles_do_not_overlap_within_a_row():
    layout = generate_layout(validate_definition(definition(gates=20, fatos=["both"] * 8)))
    for group in ("gates", "fatos"):
        items = layout[group]
        for a, b in zip(items, items[1:]):
            assert math.dist(a["center_m"], b["center_m"]) >= a["radius_m"] + b["radius_m"] + 4


def test_taxiway_graph_connects_every_gate_to_every_fato():
    layout = generate_layout(validate_definition(definition(gates=4, fatos=["takeoff", "landing", "both"])))
    neighbours = {}
    for edge in layout["edges"]:
        neighbours.setdefault(edge["from"], set()).add(edge["to"])
        neighbours.setdefault(edge["to"], set()).add(edge["from"])
        assert edge["length_m"] == pytest.approx(math.dist(*edge["points_m"]), abs=1e-3)
        assert edge["width_m"] == layout["dimensions"]["taxiway_width_m"]
    ids = {node["id"] for node in layout["nodes"]}
    assert {edge["from"] for edge in layout["edges"]} | {edge["to"] for edge in layout["edges"]} <= ids

    def reachable(start):
        seen, stack = set(), [start]
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            stack.extend(neighbours.get(node, ()))
        return seen
    for gate in layout["gates"]:
        assert {fato["id"] for fato in layout["fatos"]} <= reachable(gate["id"])
    kinds = {edge["kind"] for edge in layout["edges"]}
    assert kinds == {"stand", "approach", "spine"}


# ---------------------------------------------------------------- v2: vehicle size, patterns, platform

def circles_of(layout):
    yield from (("fato", f["id"], f["center_m"], f["safety_radius_m"]) for f in layout["fatos"])
    yield from (("gate", g["id"], g["center_m"], g["radius_m"]) for g in layout["gates"])
    yield from (("charger", c["id"], c["center_m"], c["radius_m"]) for c in layout.get("chargers", ()))


def segment_distance(point, start, end):
    (px, py), (ax, ay), (bx, by) = point, start, end
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0 if length2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.dist(point, (ax + t * dx, ay + t * dy))


def assert_clear(layout):
    """No circle touches another and no taxiway crosses a circle it does not serve."""
    circles = list(circles_of(layout))
    for i, (_, a_id, a, ra) in enumerate(circles):
        for _, b_id, b, rb in circles[i + 1:]:
            assert math.dist(a, b) >= ra + rb + 2, f"{a_id} and {b_id} overlap in {layout['pattern']}"
    for edge in layout["edges"]:
        for kind, cid, centre, radius in circles:
            if cid in (edge["from"], edge["to"]):
                continue
            clearance = segment_distance(centre, *edge["points_m"])
            assert clearance >= radius + edge["width_m"] / 2 - 0.01, f"{edge['id']} crosses {cid} in {layout['pattern']}"


@pytest.mark.parametrize("pattern", sorted(PATTERNS))
@pytest.mark.parametrize("gates,fatos", [(1, 1), (2, 1), (3, 2), (7, 3), (20, 8), (5, 1)])
def test_every_pattern_keeps_circles_and_taxiways_clear(pattern, gates, fatos):
    layout = generate_layout(validate_definition(definition(pattern=pattern, gates=gates, fatos=["both"] * fatos)))
    assert layout["pattern"] == pattern and len(layout["gates"]) == gates and len(layout["fatos"]) == fatos
    assert_clear(layout)
    ids = {node["id"] for node in layout["nodes"]}
    assert all(edge["from"] in ids and edge["to"] in ids for edge in layout["edges"])
    assert all(edge["length_m"] > 0 for edge in layout["edges"])


@pytest.mark.parametrize("pattern", sorted(PATTERNS))
def test_every_pattern_connects_every_gate_to_every_fato(pattern):
    layout = generate_layout(validate_definition(definition(pattern=pattern, gates=5, fatos=["takeoff", "landing"])))
    neighbours = {}
    for edge in layout["edges"]:
        neighbours.setdefault(edge["from"], set()).add(edge["to"])
        neighbours.setdefault(edge["to"], set()).add(edge["from"])
    seen, stack = set(), [layout["gates"][0]["id"]]
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack.extend(neighbours.get(node, ()))
    assert {node["id"] for node in layout["nodes"]} <= seen, "one connected taxiway network"


# ---------------------------------------------------------------- v3: FATOs on any side, and the court

SIDE_CASES = [
    (["front", "back"], 4), (["back"], 1), (["back", "back", "back"], 20), (["left", "right"], 6),
    (["front", "back", "left", "right"], 5), (["front", "front", "back", "back"], 8),
    (["left"] * 8, 1), (["right", "right", "back"], 3), (["front", "left", "left", "left", "right"], 20),
]


@pytest.mark.parametrize("pattern", sorted(SIDED_PATTERNS))
@pytest.mark.parametrize("sides,gates", SIDE_CASES)
def test_a_fato_stands_off_the_side_it_was_asked_for_and_everything_stays_clear(pattern, sides, gates):
    fatos = [{"role": "both", "side": side} for side in sides]
    layout = generate_layout(validate_definition(definition(pattern=pattern, gates=gates, fatos=fatos)))
    assert [f["side"] for f in layout["fatos"]] == sides, "reported in the order they were defined"
    assert_clear(layout)
    # Off the right edge of the stand block, and so on: every stand and every
    # cabinet is on the far side of the FATO's own edge.
    xs = [g["center_m"][0] for g in layout["gates"]] + [c["center_m"][0] for c in layout["chargers"]]
    ys = [g["center_m"][1] for g in layout["gates"]] + [c["center_m"][1] for c in layout["chargers"]]
    for fato in layout["fatos"]:
        x, y = fato["center_m"]
        if fato["side"] == "front":
            assert y > max(ys)
        elif fato["side"] == "back":
            assert y < min(ys)
        elif fato["side"] == "left":
            assert x < min(xs)
        else:
            assert x > max(xs)
    # And every stand still reaches every FATO along the taxiways.
    neighbours = {}
    for edge in layout["edges"]:
        neighbours.setdefault(edge["from"], set()).add(edge["to"])
        neighbours.setdefault(edge["to"], set()).add(edge["from"])
    seen, stack = set(), [layout["gates"][0]["id"]]
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack.extend(neighbours.get(node, ()))
    assert {node["id"] for node in layout["nodes"]} <= seen


def test_two_fatos_at_each_end_make_a_flow_through_deck():
    """The asked-for case: departures leave one end and arrivals meet the other."""
    fatos = [{"role": "takeoff", "side": "front"}, {"role": "takeoff", "side": "front"},
             {"role": "landing", "side": "back"}, {"role": "landing", "side": "back"}]
    layout = generate_layout(validate_definition(definition(pattern="double", gates=6, fatos=fatos)))
    gate_ys = [g["center_m"][1] for g in layout["gates"]]
    front = [f for f in layout["fatos"] if f["side"] == "front"]
    back = [f for f in layout["fatos"] if f["side"] == "back"]
    assert [f["id"] for f in front] == ["F1", "F2"] and [f["id"] for f in back] == ["F3", "F4"]
    assert all(f["center_m"][1] > max(gate_ys) for f in front)
    assert all(f["center_m"][1] < min(gate_ys) for f in back)
    assert_clear(layout)
    # A loop: the taxiway network has a way round the block, so a stand is
    # reached from either end without backing out.
    degree = {}
    for edge in layout["edges"]:
        if edge["kind"] == "spine":
            for end in (edge["from"], edge["to"]):
                degree[end] = degree.get(end, 0) + 1
    assert sum(1 for count in degree.values() if count >= 2) >= 4, "spine junctions with a way on: a loop"
    # The same definition with every FATO at the front is the old, loop-less deck.
    plain = generate_layout(validate_definition(definition(pattern="double", gates=6, fatos=["takeoff", "takeoff", "landing", "landing"])))
    assert len(plain["edges"]) < len(layout["edges"])
    assert plain["platform"]["size_m"][1] < layout["platform"]["size_m"][1], "the loop and the back row make it longer"


def test_a_side_only_means_something_where_the_fatos_stand_off_an_edge():
    for pattern in ("flank", "radial", "court"):
        normalised = validate_definition(definition(pattern=pattern, fatos=[{"role": "both", "side": "left"}, {"role": "both", "side": "back"}]))
        assert [f["side"] for f in normalised["fatos"]] == ["front", "front"], f"{pattern} keeps its FATOs in the middle"
        layout = generate_layout(normalised)
        assert {f["side"] for f in layout["fatos"]} == {"center"}
    plain = validate_definition(definition(pattern="row", fatos=["both", "both"]))
    assert [f["side"] for f in plain["fatos"]] == ["front", "front"], "a record from before sides has them at the front"
    options = describe_options()
    assert [item["id"] for item in options["fato_sides"]] == list(FATO_SIDES)
    assert {item["id"]: item["fato_sides"] for item in options["patterns"]} == {key: key in SIDED_PATTERNS for key in PATTERNS}


def test_the_court_puts_the_fatos_in_the_middle_and_the_stands_round_the_outside():
    layout = generate_layout(validate_definition(definition(pattern="court", gates=8, fatos=["takeoff", "landing"])))
    assert_clear(layout)
    gates = {g["id"]: g["center_m"] for g in layout["gates"]}
    fato_xs = [f["center_m"][0] for f in layout["fatos"]]
    fato_ys = [f["center_m"][1] for f in layout["fatos"]]
    assert max(fato_ys) - min(fato_ys) < 0.01, "FATOs in one row across the middle"
    front = [gates[f"G{i}"] for i in (1, 5)]
    back = [gates[f"G{i}"] for i in (2, 6)]
    left = [gates[f"G{i}"] for i in (3, 7)]
    right = [gates[f"G{i}"] for i in (4, 8)]
    assert all(g[1] > max(fato_ys) for g in front) and all(g[1] < min(fato_ys) for g in back)
    assert all(g[0] < min(fato_xs) for g in left) and all(g[0] > max(fato_xs) for g in right)
    assert [g["id"] for g in layout["gates"]] == [f"G{i}" for i in range(1, 9)], "listed in order whichever side they went to"
    # Every stand's cabinet is on the outside, away from the loop and the FATOs.
    for gate, charger in zip(layout["gates"], layout["chargers"]):
        assert math.dist(charger["center_m"], (0.0, 0.0)) > math.dist(gate["center_m"], (0.0, 0.0))
    small = generate_layout(validate_definition(definition(pattern="court", gates=1, fatos=["both"])))
    assert_clear(small)
    assert len(small["gates"]) == 1 and small["gates"][0]["center_m"][1] > 0, "one stand goes to the front"


def test_patterns_arrange_gates_differently():
    row = generate_layout(validate_definition(definition(pattern="row", gates=4, fatos=["both"])))
    column = generate_layout(validate_definition(definition(pattern="column", gates=4, fatos=["both"])))
    double = generate_layout(validate_definition(definition(pattern="double", gates=4, fatos=["both"])))
    flank = generate_layout(validate_definition(definition(pattern="flank", gates=4, fatos=["both"])))
    ys = lambda layout: {round(g["center_m"][1], 1) for g in layout["gates"]}
    xs = lambda layout: {round(g["center_m"][0], 1) for g in layout["gates"]}
    assert len(ys(row)) == 1 and len(xs(row)) == 4, "row: gates side by side on one line"
    assert len(xs(column)) == 1 and len(ys(column)) == 4, "column: gates stacked along the spine"
    assert len(xs(double)) == 2 and len(ys(double)) == 2, "double: two gates per level, one each side"
    fato_x = flank["fatos"][0]["center_m"][0]
    assert sum(g["center_m"][0] < fato_x for g in flank["gates"]) == 2
    assert sum(g["center_m"][0] > fato_x for g in flank["gates"]) == 2, "flank: gates either side of the FATO"
    for layout in (row, column, double):
        assert min(f["center_m"][1] for f in layout["fatos"]) > max(g["center_m"][1] for g in layout["gates"]), "FATOs beyond the gates"


@pytest.mark.parametrize("pattern", sorted(PATTERNS))
def test_every_stand_is_charged_from_the_side_its_taxi_route_does_not_use(pattern):
    layout = generate_layout(validate_definition(definition(pattern=pattern, gates=7, fatos=["both"] * 3)))
    chargers = layout["chargers"]
    assert [c["gate"] for c in chargers] == [g["id"] for g in layout["gates"]], "one charging point per stand"
    assert [c["id"] for c in chargers] == [f"C{i}" for i in range(1, 8)]
    entry = {edge["from"]: edge["points_m"][1] for edge in layout["edges"] if edge["kind"] == "stand"}
    dims = layout["dimensions"]
    for gate, charger in zip(layout["gates"], chargers):
        assert charger["radius_m"] == pytest.approx(dims["charger_radius_m"], abs=0.01)
        assert math.dist(gate["center_m"], charger["center_m"]) == pytest.approx(dims["charger_offset_m"], abs=0.01)
        # Beside the stand, on the far side from where the taxiway meets it.
        towards = entry[gate["id"]]
        into = [towards[i] - gate["center_m"][i] for i in (0, 1)]
        out = [charger["center_m"][i] - gate["center_m"][i] for i in (0, 1)]
        assert into[0] * out[0] + into[1] * out[1] < 0, f"{charger['id']} sits on the route into {gate['id']}"
    assert_clear(layout)   # nothing paved reaches a charging point either


def test_the_name_is_painted_on_the_approach_side_of_the_deck():
    for pattern in sorted(PATTERNS):
        layout = generate_layout(validate_definition(definition(pattern=pattern, gates=6, fatos=["both"] * 2)))
        area = layout["name_area"]
        assert area["along"] == "x", f"{pattern}: the name reads across the deck, not up its side"
        top = max(centre[1] + radius for _, _, centre, radius in circles_of(layout))
        assert area["center_m"][1] > top, f"{pattern}: the name is beyond everything, on the FATO side"
    forward = generate_layout(validate_definition(definition(pattern="double", gates=6, fatos=["both"] * 2)))
    assert forward["name_area"]["center_m"][1] > max(f["center_m"][1] for f in forward["fatos"]), "past the FATOs"


def test_split_gives_a_second_way_round_and_two_blocks_of_stands():
    layout = generate_layout(validate_definition(definition(pattern="split", gates=6, fatos=["both"] * 2)))
    xs = sorted(gate["center_m"][0] for gate in layout["gates"])
    middle = (xs[0] + xs[-1]) / 2
    assert sum(x < middle for x in xs) == 3 and sum(x > middle for x in xs) == 3, "the stands split left and right"
    assert len(layout["edges"]) >= len(layout["nodes"]), "a loop, not a tree: every stand has a way round"
    column = generate_layout(validate_definition(definition(pattern="column", gates=6, fatos=["both"] * 2)))
    assert len(column["edges"]) == len(column["nodes"]) - 1, "one spine stays a tree by comparison"
    # Cutting any one taxiway still leaves every stand able to reach a FATO.
    for cut in (edge["id"] for edge in layout["edges"] if edge["kind"] == "spine"):
        neighbours = {}
        for edge in layout["edges"]:
            if edge["id"] == cut:
                continue
            neighbours.setdefault(edge["from"], set()).add(edge["to"])
            neighbours.setdefault(edge["to"], set()).add(edge["from"])
        seen, stack = set(), [layout["fatos"][0]["id"]]
        while stack:
            node = stack.pop()
            if node not in seen:
                seen.add(node)
                stack.extend(neighbours.get(node, ()))
        assert {gate["id"] for gate in layout["gates"]} <= seen, f"{cut} strands a stand"


def test_radial_rings_the_fatos_at_the_centre_and_stands_around_the_outside():
    layout = generate_layout(validate_definition(definition(pattern="radial", gates=8, fatos=["both"] * 3)))
    centre = [sum(gate["center_m"][i] for gate in layout["gates"]) / len(layout["gates"]) for i in (0, 1)]
    out = lambda point: math.dist(centre, point)
    gate_radii = [out(gate["center_m"]) for gate in layout["gates"]]
    fato_radii = [out(fato["center_m"]) for fato in layout["fatos"]]
    assert max(gate_radii) - min(gate_radii) < 1e-3, "the stands share one circle"
    assert max(fato_radii) - min(fato_radii) < 1e-3, "the FATOs share one circle"
    assert max(fato_radii) + layout["fatos"][0]["safety_radius_m"] < min(gate_radii), "the FATOs sit inside the stands"
    angles = sorted(math.atan2(g["center_m"][1] - centre[1], g["center_m"][0] - centre[0]) % (2 * math.pi)
                    for g in layout["gates"])
    gaps = [b - a for a, b in zip(angles, angles[1:])] + [angles[0] + 2 * math.pi - angles[-1]]
    assert max(gaps) == pytest.approx(2 * math.pi / 8, abs=1e-6), "evenly spaced the whole way round"
    ring = [edge for edge in layout["edges"] if edge["kind"] == "spine"]
    ends = {edge["from"] for edge in ring} | {edge["to"] for edge in ring}
    assert len(ring) == len(ends) >= 30, "the taxiway ring closes on itself"
    assert all(abs(out(point) - out(ring[0]["points_m"][0])) < 0.01 for edge in ring for point in edge["points_m"]), \
        "every ring corner is the same distance out"
    assert min(gate_radii) > out(ring[0]["points_m"][0]) > max(fato_radii), "the ring runs between them"
    single = generate_layout(validate_definition(definition(pattern="radial", gates=5, fatos=["both"])))
    assert len(single["fatos"]) == 1


def test_radial_asks_for_a_round_deck_and_the_others_do_not():
    radial = generate_layout(validate_definition(definition(pattern="radial", gates=6, fatos=["both"] * 2)))
    platform = radial["platform"]
    assert platform["corner_radius_m"] == pytest.approx(min(platform["size_m"]) / 2, abs=1e-3)
    for pattern in ("row", "column", "double", "flank", "split"):
        other = generate_layout(validate_definition(definition(pattern=pattern, gates=6, fatos=["both"] * 2)))
        assert "corner_radius_m" not in other["platform"], pattern


def test_single_fato_layout_is_centred_and_defaults_to_both():
    normalised = validate_definition(definition(fatos=None, gates=3))
    assert normalised["fatos"] == [{"id": "F1", "role": "both", "side": "front"}]
    assert validate_definition(definition(fatos=["takeoff"]))["fatos"] == [{"id": "F1", "role": "both", "side": "front"}], "one FATO serves both"
    assert [f["role"] for f in validate_definition(definition(fatos=["takeoff", "landing"]))["fatos"]] == ["takeoff", "landing"]
    layout = generate_layout(normalised)
    assert layout["fatos"][0]["center_m"][0] == pytest.approx(0, abs=1e-6), "a single FATO sits on the centreline"
    assert_clear(layout)


def test_dimensions_scale_with_the_design_aircraft():
    small = dimensions_for(8)
    large = dimensions_for(16)
    assert small["fato_radius_m"] == pytest.approx(6) and large["fato_radius_m"] == pytest.approx(12), "FATO diameter 1.5 D"
    assert small["gate_radius_m"] == pytest.approx(4.8) and large["gate_radius_m"] == pytest.approx(9.6), "stand diameter 1.2 D"
    assert small["safety_margin_m"] == pytest.approx(3) and large["safety_margin_m"] == pytest.approx(4), "safety area 0.25 D or 3 m"
    assert large["taxiway_width_m"] > small["taxiway_width_m"]
    assert dimensions_for(12, undercarriage_m=3)["taxiway_width_m"] == pytest.approx(6), "twice the undercarriage width"
    layout = generate_layout(validate_definition(definition(vehicle_d_m=16)))
    assert layout["dimensions"]["vehicle_d_m"] == 16 and layout["fatos"][0]["radius_m"] == pytest.approx(12)
    assert_clear(layout)


def test_vehicle_class_fills_the_design_size_and_custom_needs_a_number():
    medium = validate_definition(definition(vehicle_class="medium"))
    assert medium["vehicle_class"] == "medium"
    assert medium["vehicle_d_m"] == next(c["d_m"] for c in VEHICLE_CLASSES if c["id"] == "medium")
    custom = validate_definition(definition(vehicle_class="custom", vehicle_d_m=9.5))
    assert custom["vehicle_d_m"] == 9.5
    assert validate_definition(definition())["vehicle_d_m"] == 12, "the default is the medium class"
    with pytest.raises(ValueError, match="^vehicle_d_m:"):
        validate_definition(definition(vehicle_d_m=2))
    with pytest.raises(ValueError, match="^vehicle_class:"):
        validate_definition(definition(vehicle_class="jumbo"))
    with pytest.raises(ValueError, match="^pattern:"):
        validate_definition(definition(pattern="spiral"))
    with pytest.raises(ValueError, match="^platform_height_m:"):
        validate_definition(definition(platform_height_m=-1))


def test_platform_is_a_rectangle_that_holds_everything_and_is_centred_on_the_origin():
    layout = generate_layout(validate_definition(definition(pattern="double", heading_deg=25, platform_height_m=2.5)))
    platform = layout["platform"]
    assert len(platform["corners_m"]) == 4 and platform["height_m"] == 2.5
    centre = [sum(c[i] for c in platform["corners_m"]) / 4 for i in (0, 1)]
    assert centre == pytest.approx([0, 0], abs=1e-3), "the definition point is the platform centre"
    width, depth = platform["size_m"]
    assert width > 0 and depth > 0
    # every circle and taxiway lies inside the rectangle: check in the unrotated frame
    back = lambda p: rotate(p, -25)
    half = (width / 2, depth / 2)
    for _, cid, centre_m, radius in circles_of(layout):
        x, y = back(centre_m)
        assert abs(x) + radius <= half[0] + 1e-6 and abs(y) + radius <= half[1] + 1e-6, cid
    for edge in layout["edges"]:
        for point in edge["points_m"]:
            x, y = back(point)
            assert abs(x) + edge["width_m"] / 2 <= half[0] + 1e-6 and abs(y) + edge["width_m"] / 2 <= half[1] + 1e-6
    low, high = layout["bounds_m"]["min"], layout["bounds_m"]["max"]
    for corner in platform["corners_m"]:
        assert low[0] - 1e-6 <= corner[0] <= high[0] + 1e-6 and low[1] - 1e-6 <= corner[1] <= high[1] + 1e-6


def test_ground_reference_and_manual_altitude_are_validated():
    assert validate_definition(definition())["ground_reference"] == "highest", "the deck clears the highest ground by default"
    for reference in ("mean", "lowest"):
        assert validate_definition(definition(ground_reference=reference))["ground_reference"] == reference
    manual = validate_definition(definition(ground_reference="manual", altitude_m=52.5))
    assert manual["ground_reference"] == "manual" and manual["altitude_m"] == 52.5
    with pytest.raises(ValueError, match="^altitude_m:"):
        validate_definition(definition(ground_reference="manual"))
    with pytest.raises(ValueError, match="^ground_reference:"):
        validate_definition(definition(ground_reference="sky"))
    layout = generate_layout(manual)
    assert layout["ground_reference"] == "manual" and layout["frame"]["altitude_m"] == 52.5


@pytest.mark.parametrize("pattern", sorted(PATTERNS))
def test_every_pattern_reserves_an_empty_strip_on_the_platform_for_the_name(pattern):
    layout = generate_layout(validate_definition(definition(pattern=pattern, gates=5, fatos=["takeoff", "landing"], heading_deg=40)))
    area = layout["name_area"]
    assert area["along"] in ("x", "y") and area["length_m"] > 0 and area["height_m"] >= 4
    back = lambda p: rotate(p, -40)
    cx, cy = back(area["center_m"])
    half = (area["length_m"] / 2, area["height_m"] / 2) if area["along"] == "x" else (area["height_m"] / 2, area["length_m"] / 2)
    width, depth = layout["platform"]["size_m"]
    assert abs(cx) + half[0] <= width / 2 + 1e-6 and abs(cy) + half[1] <= depth / 2 + 1e-6, "the strip lies on the platform"
    # nothing paved or marked reaches into the strip
    for _, cid, centre, radius in circles_of(layout):
        x, y = back(centre)
        assert abs(x - cx) > half[0] + radius - 1e-6 or abs(y - cy) > half[1] + radius - 1e-6, cid
    for edge in layout["edges"]:
        for point in edge["points_m"]:
            x, y = back(point)
            assert abs(x - cx) > half[0] + edge["width_m"] / 2 - 1e-6 or abs(y - cy) > half[1] + edge["width_m"] / 2 - 1e-6, edge["id"]
    assert_clear(layout)


def test_options_describe_patterns_classes_and_defaults():
    options = describe_options()
    assert {p["id"] for p in options["patterns"]} == set(PATTERNS)
    assert all(p["label"] and p["description"] for p in options["patterns"])
    assert [c["id"] for c in options["vehicle_classes"]][-1] == "custom"
    assert options["defaults"]["pattern"] == "row" and options["defaults"]["vehicle_class"] == "medium"
    assert options["limits"]["vehicle_d_m"] == [4, 30]
    assert [g["id"] for g in options["ground_references"]] == ["highest", "mean", "lowest", "manual"]
    assert options["defaults"]["ground_reference"] == "highest"


def test_heading_rotates_the_whole_layout_clockwise_from_north():
    north = generate_layout(validate_definition(definition(gates=1, fatos=["both"], heading_deg=0)))
    east = generate_layout(validate_definition(definition(gates=1, fatos=["both"], heading_deg=90)))
    fato_north, fato_east = north["fatos"][0]["center_m"], east["fatos"][0]["center_m"]
    assert fato_north[1] > 0 and abs(fato_north[0]) < 1e-6, "unrotated, the FATO lies north of the stand"
    assert fato_east[0] == pytest.approx(fato_north[1], abs=1e-3) and abs(fato_east[1]) < 1e-3, "heading 90 turns north to east"
    assert rotate((0, 10), 180) == pytest.approx((0, -10), abs=1e-9)
    assert rotate((10, 0), 90) == pytest.approx((0, -10), abs=1e-9)


def test_bounds_enclose_every_circle():
    layout = generate_layout(validate_definition(definition(heading_deg=37)))
    low, high = layout["bounds_m"]["min"], layout["bounds_m"]["max"]
    for item in layout["gates"] + layout["fatos"]:
        for axis in (0, 1):
            assert low[axis] <= item["center_m"][axis] - item["radius_m"] + 1e-6
            assert high[axis] >= item["center_m"][axis] + item["radius_m"] - 1e-6


def test_records_persist_definitions_atomically_and_only_definitions(tmp_path):
    path = tmp_path / "simulation/vertiports.json"
    store = VertiportRecords(path)
    created = store.create(validate_definition(definition()))
    assert created["id"] == "VP001" and created["created_at"]
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == 1 and on_disk["vertiports"][0]["name"] == "김포 버티허브"
    assert "layout" not in on_disk["vertiports"][0]
    assert not path.with_suffix(".tmp").exists()
    updated = store.update(created["id"], validate_definition(definition(name="변경", gates=2)))
    assert updated["name"] == "변경" and updated["created_at"] == created["created_at"]
    assert VertiportRecords(path).list()[0]["gates"] == 2, "a fresh reader sees the saved change"
    assert store.update("VP404", validate_definition(definition())) is None
    assert store.delete(created["id"]) is True
    assert store.delete(created["id"]) is False
    assert store.list() == []


def test_records_saved_before_vehicle_sizes_and_patterns_still_list_with_a_layout(tmp_path):
    path = tmp_path / "simulation/vertiports.json"
    path.parent.mkdir(parents=True)
    legacy = {"id": "vp-legacy", "name": "옛 허브", "latitude": 37.5, "longitude": 127.0, "heading_deg": 30, "gates": 3,
              "fatos": [{"id": "F1", "role": "takeoff"}], "created_at": "2026-09-08T00:00:00+00:00", "updated_at": "2026-09-08T00:00:00+00:00"}
    path.write_text(json.dumps({"schema_version": 1, "vertiports": [legacy]}), encoding="utf-8")
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path), "tick_seconds": 10}, sources=[])
    with TestClient(app) as client:
        listed = client.get("/api/simulation/vertiports").json()["vertiports"]
        assert listed[0]["id"] == "vp-legacy" and listed[0]["pattern"] == "row" and listed[0]["vehicle_d_m"] == 12
        assert listed[0]["layout"]["platform"]["height_m"] == 1 and len(listed[0]["layout"]["gates"]) == 3
        assert listed[0]["created_at"] == "2026-09-08T00:00:00+00:00"


def test_corrupt_store_file_is_treated_as_empty_not_fatal(tmp_path):
    path = tmp_path / "vertiports.json"
    path.write_text("{not json", encoding="utf-8")
    assert VertiportRecords(path).list() == []


def test_vertiport_api_round_trip_with_layout_and_errors(tmp_path):
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": 10}, sources=[])
    with TestClient(app) as client:
        assert client.get("/api/simulation/vertiports").json() == {"schema_version": 1, "vertiports": []}
        options = client.get("/api/simulation/vertiports/options")
        assert options.status_code == 200 and {p["id"] for p in options.json()["patterns"]} == set(PATTERNS)
        preview = client.post("/api/simulation/vertiports/preview", json=definition(gates=3))
        assert preview.status_code == 200 and len(preview.json()["layout"]["gates"]) == 3
        assert client.get("/api/simulation/vertiports").json()["vertiports"] == [], "preview persists nothing"

        created = client.post("/api/simulation/vertiports", json=definition())
        assert created.status_code == 201
        record = created.json()["vertiport"]
        assert record["id"] == "VP001" and len(record["layout"]["fatos"]) == 2
        assert record["pattern"] == "row" and record["vehicle_d_m"] == 12 and record["layout"]["platform"]["height_m"] == 1
        assert record["layout"]["fatos"][0]["role"] == "takeoff"

        listed = client.get("/api/simulation/vertiports").json()["vertiports"]
        assert [item["id"] for item in listed] == [record["id"]]
        assert client.get(f"/api/simulation/vertiports/{record['id']}").json()["vertiport"]["name"] == "김포 버티허브"

        bad = client.post("/api/simulation/vertiports", json=definition(latitude=200))
        assert bad.status_code == 422 and bad.json()["field"] == "latitude"
        assert client.post("/api/simulation/vertiports", content="nope",
                           headers={"content-type": "application/json"}).status_code == 422

        updated = client.put(f"/api/simulation/vertiports/{record['id']}", json=definition(heading_deg=90, gates=2))
        assert updated.status_code == 200 and updated.json()["vertiport"]["layout"]["frame"]["heading_deg"] == 90
        assert client.put("/api/simulation/vertiports/vp-missing", json=definition()).status_code == 404
        assert client.delete(f"/api/simulation/vertiports/{record['id']}").status_code == 204
        assert client.delete(f"/api/simulation/vertiports/{record['id']}").status_code == 404
    saved = json.loads((tmp_path / "simulation/vertiports.json").read_text(encoding="utf-8"))
    assert saved["vertiports"] == []
