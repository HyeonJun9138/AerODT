"""데크 아래 터미널 층: 평면이 어디서 오고, 계단이 어디로 내려놓는지.

Nothing in the terminal storey is authored. Its plan is the deck's own outline
set in by a constant, and the way down is the structure already standing beside
every charger. These are the properties that have to hold for a person to be
able to walk it, and the two that a shortcut would quietly break.
"""
import math

import pytest

from digital_twin.model_library import vertiport_layout as vl


def port(**changes):
    definition = vl.validate_definition({"name": "여의도", "latitude": 37.525, "longitude": 126.920,
                                         "heading_deg": 18, "gates": 3, "platform_height_m": 20,
                                         "fatos": [{"role": "takeoff"}, {"role": "landing"}], **changes})
    return vl.generate_layout(definition)


def offsets(corners, inset_ring):
    """How far each edge of `inset_ring` lies inside the matching edge of `corners`."""
    count = len(corners)
    area = sum(corners[i][0] * corners[(i + 1) % count][1] - corners[(i + 1) % count][0] * corners[i][1]
               for i in range(count))
    turn = 1.0 if area > 0 else -1.0
    found = []
    for i in range(count):
        (x0, y0), (x1, y1) = corners[i], corners[(i + 1) % count]
        length = math.hypot(x1 - x0, y1 - y0)
        normal = (-(y1 - y0) / length * turn, (x1 - x0) / length * turn)
        edge = (inset_ring[i], inset_ring[(i + 1) % count])
        found.append([(normal[0] * (p[0] - x0) + normal[1] * (p[1] - y0)) for p in edge])
    return found


def test_a_deck_on_the_ground_has_no_storey_under_it_rather_than_a_buried_one():
    # The key is absent rather than null: a layout without the room for a storey
    # does not carry an empty one, and every reader treats it as optional.
    assert "terminal" not in port(platform_height_m=2)
    assert "terminal" not in port(platform_height_m=vl.TERMINAL_STOREY_M + 0.5)
    assert port(platform_height_m=vl.TERMINAL_STOREY_M + 0.6)["terminal"]["cores"]


def test_the_floor_is_one_storey_under_the_deck_and_the_rest_is_still_air():
    layout = port(platform_height_m=20)
    terminal = layout["terminal"]
    # `platform_height_m` is how far the deck stands above the ground, not a
    # slab thickness. Reading it as a thickness put the floor underground.
    assert terminal["floor_drop_m"] == vl.TERMINAL_STOREY_M
    assert terminal["ground_clearance_m"] == pytest.approx(20 - vl.TERMINAL_STOREY_M)
    assert terminal["clear_height_m"] == vl.TERMINAL_CLEAR_M
    assert terminal["clear_height_m"] < terminal["storey_m"], "슬래브 두께가 남아야 한다"


@pytest.mark.parametrize("corners", [
    [[-40, -30], [40, -30], [40, 30], [-40, 30]],
    # The case a shortcut breaks: a long thin deck. Scaling the ring towards
    # its centroid sets the long sides in much further than the short ones,
    # and the overhang of a deck is a constant.
    [[-94, -30], [94, -30], [94, 30], [-94, 30]],
    # Turned, because a real deck is turned to its approach.
    [[-41.339, -23.674], [19.529, -43.452], [41.339, 23.674], [-19.529, 43.452]],
])
def test_the_plan_is_the_deck_set_in_by_the_same_overhang_on_every_edge(corners):
    terminal = vl._terminal(corners, [], 20)
    for edge in offsets(corners, terminal["outline_m"]):
        for distance in edge:
            assert distance == pytest.approx(vl.TERMINAL_INSET_M, abs=1e-3)


def test_every_boarding_point_on_the_floor_becomes_a_way_down_to_it():
    layout = port()
    terminal, boarding = layout["terminal"], layout["boarding_points"]
    assert len(terminal["cores"]) == len(boarding) > 0
    for core, point in zip(terminal["cores"], boarding):
        # Carried through rather than re-derived, so a gate renamed upstairs is
        # the same gate downstairs.
        assert (core["boarding"], core["gate"], core["charger"]) == (point["id"], point["gate"], point.get("charger"))
        assert core["size_m"] == list(point["size_m"])
        assert core["center_m"] == pytest.approx(point["center_m"], abs=1e-3)


def test_a_stair_never_puts_you_back_inside_the_stair_you_just_used():
    # Landing inside the shaft would send a walker straight back through it,
    # up and down for ever.
    layout = port()
    terminal = layout["terminal"]
    inside = vl._ring_contains(terminal["outline_m"])
    for core in terminal["cores"]:
        half = math.hypot(*core["size_m"]) / 2
        for landing in (core["landing_m"], core["deck_exit_m"]):
            reach = math.dist(landing, core["center_m"])
            assert reach > half, f"{core['id']} {landing} 이 계단 발밑"
        assert inside(core["landing_m"]), f"{core['id']} 아래층 착지점이 바닥 밖"
        # The two ends are on opposite sides of the shaft: down leads inward,
        # up leads out onto the deck away from the middle of the floor.
        assert math.dist(core["landing_m"], core["deck_exit_m"]) > half * 2


def test_a_boarding_point_out_over_the_overhang_gets_no_stair_rather_than_one_in_mid_air():
    corners = [[-40, -30], [40, -30], [40, 30], [-40, 30]]
    over = {"id": "B9", "gate": "G9", "charger": "C9", "center_m": [38.5, 0],
            "size_m": [3.6, 2.6], "height_m": 2.8}
    assert vl._terminal(corners, [over], 20)["cores"] == []
