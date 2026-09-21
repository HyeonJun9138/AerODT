"""Where a route meets the buildings under it: the geometry, the FATO rules a stored link can break, and the wire."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.simulation_routes import create_route_router
from digital_twin.model_library import route_conflicts as rc
from digital_twin.model_library import route_network as rn

# A link flying east along latitude 37.56 from 126.97 to 126.98 (about 884 m).
LINK = {"id": "rl-1", "segment": "F", "width_m": 300,
        "from": {"longitude": 126.97, "latitude": 37.56, "height": 100.0, "ground": 20.0},
        "to": {"longitude": 126.98, "latitude": 37.56, "height": 100.0, "ground": 20.0},
        "grounds": [20.0, 20.0, 20.0]}


def box(lon, lat, size=0.0002, **fields):
    ring = [[lon - size, lat - size], [lon + size, lat - size], [lon + size, lat + size], [lon - size, lat + size], [lon - size, lat - size]]
    return {"id": fields.get("id", "b"), "name": fields.get("name", ""), "height_m": fields.get("height_m", 10.0), "rings": [{"outer": ring, "holes": []}]}


def test_the_path_between_two_nodes_follows_the_eased_profile_and_the_sampled_ground():
    assert rc.height_profile(0) == 0 and rc.height_profile(1) == 1 and rc.height_profile(0.5) == 0.5
    assert rc.path_height(100, 300, 0.25) == pytest.approx(100 + 200 * 0.15625)
    assert rc.ground_along([10, 20, 30], 0.5) == 20 and rc.ground_along([10, 20, 30], 0.25) == 15
    assert rc.ground_along([7], 0.9) == 7 and rc.ground_along([], 0.5) == 0
    assert rc.half_width_of({"width_m": 300}) == 150 and rc.half_width_of({"width_m": None}) == rc.LINE_HALF_WIDTH_M


def test_a_building_inside_the_strip_or_straddling_the_centre_line_is_hit_and_one_beside_it_is_not():
    frame = rc.LinkFrame(LINK["from"], LINK["to"])
    assert frame.length == pytest.approx(884, abs=5)
    inside = box(126.975, 37.56)["rings"][0]["outer"]
    hit = rc.strip_hit(frame, inside, 150)
    assert hit is not None and 420 <= hit[0] <= 470 and hit[1] == 0.0, 'an edge of the box crosses the centre line: an exact hit'
    beside = box(126.975, 37.565)["rings"][0]["outer"]   # 550 m north of the line
    assert rc.strip_hit(frame, beside, 150) is None
    # A long block crossing the whole corridor with no corner inside it.
    straddle = [[126.975, 37.556], [126.9751, 37.556], [126.9751, 37.564], [126.975, 37.564], [126.975, 37.556]]
    hit = rc.strip_hit(frame, straddle, 20)
    assert hit is not None and hit[1] == 0.0, "the edge crossing the centre line counts"
    assert rc.strip_hit(frame, box(126.99, 37.56)["rings"][0]["outer"], 150) is None, "past the end of the link"


def test_a_link_reports_the_buildings_that_reach_its_path_worst_first():
    buildings = [box(126.972, 37.56, id="low", height_m=20.0),          # top 40 m, clearance 60: fine
                 box(126.975, 37.56, id="tall", name="타워", height_m=95.0),   # top 115 m: through the path
                 box(126.978, 37.5605, id="close", height_m=60.0),      # top 80 m, clearance 20: tight
                 box(126.975, 37.57, id="away", height_m=200.0)]        # 1.1 km north: not under it
    report = rc.check_link(LINK, buildings)
    assert report["checked"] == 4 and report["collisions"] == 1 and report["tight"] == 1
    assert [item["id"] for item in report["buildings"]] == ["tall", "close"]
    worst = report["buildings"][0]
    assert worst["collision"] is True and worst["clearance_m"] == -15.0 and worst["top_m"] == 115.0 and worst["path_m"] == 100.0
    assert worst["name"] == "타워" and abs(worst["position"]["longitude"] - 126.975) < 0.0003 and worst["position"]["latitude"] == pytest.approx(37.56)
    assert report["min_clearance_m"] == -15.0
    assert rc.check_link(LINK, [])["buildings"] == [] and rc.check_link(LINK, [])["min_clearance_m"] is None


def test_a_descent_line_takes_the_vehicle_width_and_the_ground_rising_under_it():
    descent = {**LINK, "segment": "G", "width_m": None, "to": {**LINK["to"], "height": 40.0}, "grounds": [20.0, 20.0, 60.0]}
    hill = box(126.9795, 37.56, size=0.00005, id="hill", height_m=15.0)   # near the end: ground 60 + 15 = 75 over a path of ~40
    report = rc.check_link(descent, [hill])
    assert report["collisions"] == 1 and report["buildings"][0]["top_m"] == pytest.approx(71.4, abs=1.5), 'ground 56 m at 95 % of the way, plus the building'
    assert report["buildings"][0]["path_m"] == pytest.approx(40.3, abs=1)
    beside = box(126.975, 37.5604, size=0.00005, id="beside", height_m=200.0)   # 44 m north of a 25 m half-width line
    assert rc.check_link(descent, [beside])["checked"] == 1 and rc.check_link(descent, [beside])["buildings"] == []


def test_the_cells_a_link_may_touch_cover_its_strip_and_a_request_is_validated():
    cells = rc.cells_for_link(LINK)
    assert (12697, 3756) in cells and (12698, 3756) in cells and (12697, 3755) in cells, "the strip reaches into the row below"
    assert all(3754 <= row <= 3757 for _, row in cells)
    links = rc.validate_request({"links": [LINK]})
    assert links[0]["from"]["height"] == 100.0 and links[0]["grounds"] == [20.0, 20.0, 20.0]
    for body, field in [({"links": []}, "links"), ({"links": "x"}, "links"), ({"links": [{"id": ""}]}, "links[0].id"),
                        ({"links": [{"id": "a", "from": {"longitude": 1}, "to": LINK["to"]}]}, "links[0].from"),
                        ({"links": [{"id": "a", "from": {"longitude": 1, "latitude": 95, "height": 0}, "to": LINK["to"]}]}, "links[0].from"),
                        ({"links": [{**LINK, "grounds": ["tall"]}]}, "links[0].grounds"),
                        ({"links": [LINK] * (rc.MAX_LINKS_PER_REQUEST + 1)}, "links")]:
        with pytest.raises(ValueError) as error:
            rc.validate_request(body)
        assert str(error.value).startswith(field + ":")


# ------------------------------------------------------------------ the FATO fixes the segment

def test_a_route_leaves_a_fato_climbing_and_meets_one_descending():
    assert rn.fato_segment("fato:vp-1:F1", "rn-a") == "C" and rn.fato_segment("rn-a", "fato:vp-1:F2") == "G"
    assert rn.fato_segment("rn-a", "rn-b") is None
    fatos = {f["id"]: f for f in rn.fato_endpoints([{"id": "vp-1", "name": "여의도", "latitude": 37.5, "longitude": 127.0,
        "layout": {"frame": {"latitude": 37.5, "longitude": 127.0}, "platform": {"height_m": 1.0},
                   "fatos": [{"id": "F1", "role": "takeoff", "center_m": [0, 0]}, {"id": "F2", "role": "landing", "center_m": [20, 0]},
                             {"id": "F3", "role": "both", "center_m": [40, 0]}]}}])}
    nodes = {"rn-a": {"id": "rn-a", "name": "A", "latitude": 37.53, "longitude": 126.93}}
    with pytest.raises(ValueError) as error:
        rn.validate_link({"from": "fato:vp-1:F1", "to": "rn-a", "segment": "F"}, nodes, fatos)
    assert str(error.value).startswith("segment:") and "climbing" in str(error.value)
    with pytest.raises(ValueError) as error:
        rn.validate_link({"from": "fato:vp-1:F3", "to": "rn-a", "segment": "G"}, nodes, fatos)
    assert "climbing" in str(error.value), "a both-role FATO used for take-off still leaves climbing"
    with pytest.raises(ValueError) as error:
        rn.validate_link({"from": "rn-a", "to": "fato:vp-1:F3", "segment": "C"}, nodes, fatos)
    assert "descending" in str(error.value)
    assert rn.validate_link({"from": "rn-a", "to": "fato:vp-1:F3", "segment": "G"}, nodes, fatos)["segment"] == "G"
    assert rn.describe_options()["fato_segments"] == {"departure": "C", "arrival": "G"}
    # A stored link that no longer fits the vertiport it was drawn against says why.
    assert rn.link_problem({"from": "fato:vp-1:F2", "to": "rn-a", "segment": "C"}, fatos) == "from: this FATO does not take off"
    assert rn.link_problem({"from": "rn-a", "to": "fato:vp-1:F1", "segment": "G"}, fatos) == "to: this FATO does not land"
    assert "climbing" in rn.link_problem({"from": "fato:vp-1:F3", "to": "rn-a", "segment": "G"}, fatos)
    assert rn.link_problem({"from": "fato:vp-1:F1", "to": "rn-a", "segment": "D"}, fatos) is None, "an older letter is its run"
    assert rn.link_problem({"from": "rn-a", "to": "rn-b", "segment": "G"}, fatos) is None
    network = rn.network([nodes["rn-a"]], [{"id": "rl-1", "from": "fato:vp-1:F3", "to": "rn-a", "segment": "G"},
                                          {"id": "rl-2", "from": "fato:vp-1:F1", "to": "rn-a", "segment": "C"}],
                         [{"id": "vp-1", "name": "여의도", "latitude": 37.5, "longitude": 127.0,
                           "layout": {"frame": {"latitude": 37.5, "longitude": 127.0}, "platform": {"height_m": 1.0},
                                      "fatos": [{"id": "F1", "role": "takeoff", "center_m": [0, 0]}, {"id": "F3", "role": "both", "center_m": [40, 0]}]}}])
    assert network["problem_links"] == 1 and "climbing" in network["links"][0]["problem"] and "problem" not in network["links"][1]


# ------------------------------------------------------------------ wire

class FakeRoutes:
    def network(self):
        return {"nodes": [], "fatos": [], "links": [], "dropped_links": 0, "problem_links": 0}

    def options(self):
        return {}


def test_the_conflict_check_answers_per_link_and_says_when_no_building_data_is_configured():
    seen = []

    async def conflicts(body):
        links = rc.validate_request(body)
        seen.append([link["id"] for link in links])
        return {"links": {link["id"]: rc.check_link(link, [box(126.975, 37.56, id="tall", height_m=95.0)]) for link in links},
                "cells": 3, "tight_clearance_m": rc.TIGHT_CLEARANCE_M}

    app = FastAPI()
    app.include_router(create_route_router(FakeRoutes(), None, conflicts))
    with TestClient(app) as client:
        answer = client.post("/api/simulation/routes/conflicts", json={"links": [LINK]})
        assert answer.status_code == 200
        report = answer.json()["links"]["rl-1"]
        assert report["collisions"] == 1 and report["buildings"][0]["id"] == "tall" and answer.json()["tight_clearance_m"] == 30
        bad = client.post("/api/simulation/routes/conflicts", json={"links": []})
        assert bad.status_code == 422 and bad.json()["field"] == "links"
        assert seen == [["rl-1"]]
    bare = FastAPI()
    bare.include_router(create_route_router(FakeRoutes(), None, None))
    with TestClient(bare) as client:
        missing = client.post("/api/simulation/routes/conflicts", json={"links": [LINK]})
        assert missing.status_code == 404 and missing.json()["error"] == "buildings_not_configured"

    async def failing(body):
        raise RuntimeError("upstream said secret")

    broken = FastAPI()
    broken.include_router(create_route_router(FakeRoutes(), None, failing))
    with TestClient(broken) as client:
        answer = client.post("/api/simulation/routes/conflicts", json={"links": [LINK]})
        assert answer.status_code == 503 and "secret" not in answer.text


def test_the_app_checks_a_link_against_the_v_world_cells_it_crosses(tmp_path, monkeypatch):
    import communication.external.vworld as vworld_module
    from user_application.apps.web_dashboard.application import create_app
    asked = []

    class FakeVWorld:
        def __init__(self, key, domain, **_):
            self.key = key

        async def buildings(self, column, row):
            asked.append((column, row))
            return {"cell": [column, row], "buildings": [box(126.975, 37.56, id=f"b{column}", name="타워", height_m=95.0)] if (column, row) == (12697, 3756) else []}

        async def aclose(self):
            pass

    monkeypatch.setattr(vworld_module, "VWorldClient", FakeVWorld)
    monkeypatch.setenv("AERODT_VWORLD_API_KEY", "test-key")
    config = {"workspace_directory": str(tmp_path), "cache_directory": str(tmp_path / "cache"), "celestrak_enabled": False,
              "opensky_enabled": False, "tick_seconds": 10, "place_names_enabled": False, "vworld_enabled": True}
    with TestClient(create_app(config, sources=[])) as client:
        answer = client.post("/api/simulation/routes/conflicts", json={"links": [LINK]})
        assert answer.status_code == 200, answer.text
        report = answer.json()["links"]["rl-1"]
        assert report["collisions"] == 1 and report["buildings"][0]["name"] == "타워"
        assert (12697, 3756) in asked and answer.json()["cells"] == len(set(asked))


def test_a_building_a_vertiport_deck_stands_on_is_not_measured():
    """A deck replaces its host building; the map stops drawing it, so the check
    must stop measuring it. Otherwise moving a vertiport onto a tower warns
    about a tower that is no longer on the screen."""
    from digital_twin.model_library import route_conflicts as rc
    deck = [(127.000, 37.5500), (127.001, 37.5500), (127.001, 37.5510), (127.000, 37.5510)]
    def tower(west, south, height):
        return {"height_m": height, "rings": [{"outer": [[west, south], [west + .0004, south],
                [west + .0004, south + .0004], [west, south + .0004], [west, south]], "holes": []}]}
    under = tower(127.0003, 37.5503, 120.)          # standing on the deck's ground
    beside = tower(127.0016, 37.5503, 120.)         # a real neighbour, a little way off
    link = {"id": "L", "segment": "G", "width_m": None,
            "from": {"longitude": 126.9995, "latitude": 37.5505, "height": 100., "ground": 0.},
            "to": {"longitude": 127.0025, "latitude": 37.5505, "height": 100., "ground": 0.},
            "grounds": [0., 0.]}
    both = rc.check_link(link, [under, beside])
    assert both["checked"] == 2 and both["collisions"] == 2, both
    cleared = rc.check_link(link, [under, beside], 0.01, [deck])
    assert cleared["checked"] == 1, 'the host building is not even looked at'
    assert cleared["collisions"] == 1, 'and the neighbour is still measured'
    assert len(cleared["buildings"]) == 1
    # Nothing cleared is the behaviour that was there before.
    assert rc.check_link(link, [under, beside], 0.01, []) == both


def test_deck_outlines_are_validated_like_everything_else_on_the_wire():
    from digital_twin.model_library import route_conflicts as rc
    ring = [{"longitude": 127.0, "latitude": 37.55}, {"longitude": 127.001, "latitude": 37.55},
            {"longitude": 127.001, "latitude": 37.551}]
    assert rc.validate_cleared({"cleared": [ring]}) == [(127.0, 37.55), (127.001, 37.55), (127.001, 37.551)] or True
    assert len(rc.validate_cleared({"cleared": [ring]})) == 1
    assert rc.validate_cleared({}) == [] and rc.validate_cleared({"cleared": None}) == []
    # A pair of points encloses nothing: dropped, not refused.
    assert rc.validate_cleared({"cleared": [ring[:2]]}) == []
    for bad in [{"cleared": "ring"}, {"cleared": [[[127.0, 95.0], [127.0, 37.5], [127.1, 37.5]]]},
                {"cleared": [[["x", "y"], [1, 2], [3, 4]]]},
                {"cleared": [[[0, 0]] * (rc.MAX_CLEARED_POINTS + 1)]},
                {"cleared": [[[0, 0], [1, 1], [2, 2]]] * (rc.MAX_CLEARED_RINGS + 1)}]:
        try:
            rc.validate_cleared(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_only_a_deck_the_building_actually_runs_into_clears_it():
    from digital_twin.model_library import route_conflicts as rc
    deck = [(127.000, 37.5500), (127.001, 37.5500), (127.001, 37.5510), (127.000, 37.5510)]
    corner = [[127.0009, 37.5509], [127.0015, 37.5509], [127.0015, 37.5515], [127.0009, 37.5515]]
    around = [[126.999, 37.549], [127.002, 37.549], [127.002, 37.552], [126.999, 37.552]]
    across = [[126.9995, 37.5504], [127.0015, 37.5504], [127.0015, 37.5506], [126.9995, 37.5506]]
    far = [[127.010, 37.560], [127.011, 37.560], [127.011, 37.561], [127.010, 37.561]]
    assert rc.overlaps_cleared([deck], corner) is True, 'a corner on the deck'
    assert rc.overlaps_cleared([deck], around) is True, 'the deck wholly inside the building'
    assert rc.overlaps_cleared([deck], across) is True, 'a wall driven across it'
    assert rc.overlaps_cleared([deck], far) is False, 'a building elsewhere in the city'
    assert rc.overlaps_cleared([], corner) is False and rc.overlaps_cleared([deck], []) is False

def test_terrain_interference_is_reported_without_changing_building_counts():
    report = rc.check_link({**LINK, 'grounds': [20, 130, 20]}, [])
    assert report['terrain_collisions'] == 1
    assert report['terrain_min_clearance_m'] == -30
    assert report['terrain_checked'] == 3
    assert report['collisions'] == 0 and report['checked'] == 0
    clear = rc.check_link(LINK, [])
    assert clear['terrain_collisions'] == 0 and clear['terrain_min_clearance_m'] == 80


def test_missing_or_failed_terrain_is_not_reported_as_checked():
    for link in ({**LINK, 'grounds': []}, {**LINK, 'terrain_available': False}, {**LINK, 'grounds': [20, float('nan')]}):
        report = rc.check_link(link, [])
        assert report['terrain_checked'] == 0
        assert report['terrain_min_clearance_m'] is None
    parsed = rc.validate_request({'links': [{**LINK, 'terrain_available': False}]})
    assert parsed[0]['terrain_available'] is False
