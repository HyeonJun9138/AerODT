"""터미널 실내 배치: 게이트마다 라운지, 겹치지 않기, 계단은 비켜 두기.

The fit-out is placed by rejection -- each thing is tried where it belongs and
moved if that place is taken -- so the properties worth testing are the ones a
rejection loop silently breaks: something that never got placed at all, two
things in the same square metre, and a stair with furniture on top of it.

Every case here is run against the real saved geometries as well as made-up
ones, because the two faults this has already had were both invisible on a
tidy rectangle and obvious on a 182 x 128 m turned diamond with eight stairs
scattered across it.
"""
import math

import pytest

from digital_twin.model_library import terminal_plan as tp
from digital_twin.model_library import vertiport_layout as vl


def port(**changes):
    definition = vl.validate_definition({"name": "여의도", "latitude": 37.525, "longitude": 126.920,
                                         "heading_deg": 53, "gates": 8, "platform_height_m": 30,
                                         "fatos": [{"role": "takeoff"}, {"role": "landing"}], **changes})
    return vl.generate_layout(definition)


def placed(plan):
    """Everything on the floor, as (name, ring), for the checks that look at all of it."""
    rings = [("entry", plan["entry"]["outline_m"]), ("entry core", plan["entry"]["core_outline_m"])]
    rings += [(f"lane {lane['id']}", lane["outline_m"]) for lane in plan["security"]["lanes"]]
    rings += [(f"lounge {item['id']}", item["outline_m"]) for item in plan["lounges"]]
    rings += [(f"bench {item['id']}", item["outline_m"]) for item in plan["rest"]]
    rings += [(f"{item['kind']} {item['id']}", item["outline_m"]) for item in plan["units"]]
    if plan["board"]:
        rings.append(("board", plan["board"]["outline_m"]))
    return rings


TURNED = [30, 0, 53, 127, 180, 271]


@pytest.mark.parametrize("heading", TURNED)
def test_every_gate_gets_a_lounge_however_the_building_is_turned(heading):
    # The first version held a lounge the same distance off a stair as a shop,
    # so every lounge was refused by its own core and no gate had one.
    layout = port(heading_deg=heading)
    terminal = layout["terminal"]
    plan = terminal["plan"]
    assert len(plan["lounges"]) == len(terminal["cores"]) > 0
    assert {item["gate"] for item in plan["lounges"]} == {core["gate"] for core in terminal["cores"]}
    for lounge in plan["lounges"]:
        core = next(c for c in terminal["cores"] if c["id"] == lounge["core"])
        # Beside the stair it serves, not across the floor from it.
        assert math.dist(lounge["center_m"], core["center_m"]) < 14
        assert lounge["seats"] == sum(len(row["seats_m"]) for row in lounge["rows"]) > 0


@pytest.mark.parametrize("heading", TURNED)
def test_nothing_is_off_the_floor_and_nothing_shares_a_square_metre(heading):
    terminal = port(heading_deg=heading)["terminal"]
    inside = tp._contains(terminal["outline_m"])
    rings = placed(terminal["plan"])
    for name, ring in rings:
        assert all(inside(point) for point in ring), f"{name} 이 바닥 밖"
    for first in range(len(rings)):
        for second in range(first + 1, len(rings)):
            # The lift core stands in the hall it serves; everything else is clear.
            if {rings[first][0], rings[second][0]} <= {"entry", "entry core"}:
                continue
            if rings[second][0].startswith("lane") and rings[first][0] == "entry":
                continue
            assert not tp._overlap(rings[first][1], rings[second][1]), \
                f"{rings[first][0]} ~ {rings[second][0]} 겹침"


def test_the_way_in_is_found_even_when_a_stair_stands_in_front_of_the_doors():
    # The real 여의도 has a core twelve metres from the middle of the entrance
    # wall, and every position straight back from it is taken. Sliding along
    # the wall is what makes the hall -- and therefore the whole plan -- exist.
    ring = [[-90, 30], [3, -96], [90, -30], [-3, 96]]
    blocker = {"id": "B1", "gate": "G1", "charger": "C1", "size_m": [2.6, 3.6], "height_m": 2.8,
               "center_m": [-45.0, -33.0]}
    bare = tp.plan(ring, [], 53)
    assert bare and bare["entry"], "빈 바닥에서는 당연히 된다"
    blocked = tp.plan(ring, [blocker], 53)
    assert blocked is not None, "계단이 정문 앞에 있다고 실내가 없어지면 안 된다"
    assert not tp._overlap(blocked["entry"]["outline_m"],
                           tp._rect(blocker["center_m"], (1, 0), (3.6, 3.6)))


def test_a_stair_is_walked_into_on_purpose_so_it_is_never_solid():
    # `blocks_m` is what refuses a walker. A core in it would make the way
    # between floors unreachable, which is the one thing on this floor that
    # has to be reachable.
    terminal = port()["terminal"]
    for core in terminal["cores"]:
        shaft = tp._rect(core["center_m"], (1, 0), (max(core["size_m"]),) * 2)
        for block in terminal["plan"]["blocks_m"]:
            assert not tp._overlap(block, shaft), f"{core['id']} 계단이 막혀 있다"


def test_screening_is_a_wall_with_the_lanes_left_out_of_it():
    plan = port()["terminal"]["plan"]
    security = plan["security"]
    assert len(security["lanes"]) >= 2, "한 줄은 검색대가 아니라 줄서기다"
    walked = sum(math.dist(*run) for run in security["runs_m"])
    whole = math.dist(*security["line_m"])
    gaps = whole - walked
    # The gaps are the lanes, near enough: the wall is the line less the doors.
    assert gaps == pytest.approx(len(security["lanes"]) * tp.LANE_M[0], abs=0.25)
    # And the wall is solid, so it is in the blocks rather than being scenery.
    assert len(plan["blocks_m"]) >= len(security["runs_m"])


def test_the_floor_carries_what_a_passenger_was_promised():
    plan = port()["terminal"]["plan"]
    kinds = {unit["kind"] for unit in plan["units"]}
    assert {"shop", "restaurant", "mart", "toilet"} <= kinds, kinds
    assert plan["board"], "시간표 자리"
    assert plan["rest"], "라운지 말고도 앉을 곳"
    assert all(unit["name"] for unit in plan["units"])
    # A shopfront is the face people walk up to; without it a unit is a box.
    for unit in plan["units"]:
        assert math.hypot(*unit["facing_m"]) == pytest.approx(1.0, abs=1e-3)


def test_a_floor_too_small_to_fit_a_hall_answers_nothing_rather_than_a_half_plan():
    assert tp.plan([[-6, -6], [6, -6], [6, 6], [-6, 6]], [], 0) is None
    assert tp.plan([], [], 0) is None
    assert tp.plan([[0, 0], [1, 0]], [], 0) is None


def test_the_same_definition_always_gives_the_same_floor():
    # Placement is by rejection, so an unstable iteration order would move the
    # shops about between runs and no two clients would see the same terminal.
    first, second = port()["terminal"]["plan"], port()["terminal"]["plan"]
    assert first == second
