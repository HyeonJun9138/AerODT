"""How fast a UAM is flown, as the pilot sets it.

Speeds only. Where a flight goes and how high belongs to the route network and
the aircraft follows it, so nothing here touches altitude — that is the point of
the split and these tests hold it.
"""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.operating_profile_routes import create_operating_profile_router
from data.settings.operating_profile_settings import OperatingProfileSettings
from digital_twin.model_library import uam_operating_profile as profile


def test_the_defaults_are_the_operating_figures():
    values = profile.defaults()
    assert values["cruise_kt"] == 130.0
    assert values["vertical_speed_fpm"] == 500.0
    assert values["taxi_out_kt"] == 2.6 and values["taxi_in_kt"] == 3.0
    assert values["transition_factor"] == 1.2
    assert profile.transition_speed_kt(values) == pytest.approx(54.0), "1.2 x Vstall"
    # Vstall is ours, not theirs, and the description says so.
    assert profile.OURS == ("stall_kt",)
    assert any(field["ours"] for field in profile.describe()["fields"])


def test_the_speeds_reach_the_metres_a_second_a_plan_is_built_with():
    flown = profile.speeds()
    assert flown["cruise_mps"] == pytest.approx(66.88, abs=0.01), "130 kt"
    assert flown["vertical_mps"] == pytest.approx(2.54, abs=0.01), "500 ft/min"
    assert flown["landing_vertical_mps"] == pytest.approx(1.52, abs=0.01), "300 ft/min, slower down"
    assert flown["taxi_out_mps"] == pytest.approx(1.34, abs=0.01)
    assert flown["taxi_in_mps"] > flown["taxi_out_mps"], "the figures differ out and in"
    # Climbing and descending are flown between the transition and the cruise.
    assert flown["transition_mps"] < flown["climb_mps"] < flown["cruise_mps"]
    assert flown["climb_mps"] == flown["descent_mps"]


def test_nothing_here_says_where_a_flight_goes():
    """The altitudes and the stage-by-stage procedure came from older material.
    Where a flight goes is the route network's, and the aircraft climbs and
    descends along the route it was assigned."""
    for name in profile.FIELD_NAMES:
        assert "altitude" not in name and "_ft" not in name.replace("fpm", ""), name
    assert "고도" in profile.NOT_TAKEN and "항로" in profile.NOT_TAKEN
    assert "not_taken" in profile.describe()


def test_a_setting_is_held_to_its_range_and_to_being_flyable():
    assert profile.validate({"cruise_kt": 120})["cruise_kt"] == 120
    assert profile.validate(None) == profile.defaults()
    for bad, says in [({"cruise_kt": 500}, "cruise_kt"), ({"cruise_kt": 5}, "cruise_kt"),
                      ({"vertical_speed_fpm": 5}, "vertical_speed_fpm"),
                      ({"stall_kt": "fast"}, "stall_kt"), ({"nonsense": 1}, "nonsense")]:
        with pytest.raises(ValueError) as error:
            profile.validate(bad)
        assert says in str(error.value)
    # A cruise slower than the transition speed is each value in range and a
    # flight nobody can fly.
    with pytest.raises(ValueError) as error:
        profile.validate({"cruise_kt": 45, "stall_kt": 60})
    assert "천이 속도보다" in str(error.value)
    with pytest.raises(ValueError):
        profile.validate("not a mapping")


def test_one_change_keeps_the_rest():
    settled = profile.validate({"cruise_kt": 110}, base=profile.validate({"taxi_in_kt": 4.0}))
    assert settled["cruise_kt"] == 110 and settled["taxi_in_kt"] == 4.0
    assert settled["vertical_speed_fpm"] == profile.DEFAULTS["vertical_speed_fpm"]


def test_each_phase_of_a_flight_reads_out_in_both_units():
    rows = {row["phase"]: row for row in profile.by_phase()}
    assert set(rows) == {"gate_out", "takeoff", "climb", "cruise", "descent", "landing", "gate_in"}
    assert rows["cruise"]["knots"] == pytest.approx(130.0, abs=0.1)
    assert rows["takeoff"]["fpm"] == pytest.approx(500, abs=1)
    assert rows["landing"]["fpm"] == pytest.approx(300, abs=1)
    assert rows["gate_out"]["knots"] == pytest.approx(2.6, abs=0.1)
    assert rows["cruise"]["mps"] > rows["climb"]["mps"] > rows["gate_out"]["mps"]


def test_a_plan_is_built_at_the_profiles_speeds():
    """The whole point: change the number and the flight is built to it."""
    from digital_twin.model_library.route_network import network as build_network
    from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition
    from digital_twin.model_library import flight_plan

    def vertiport(identifier, name, latitude, longitude):
        definition = validate_definition({"name": name, "latitude": latitude, "longitude": longitude,
                                          "heading_deg": 0, "gates": 3, "platform_height_m": 20,
                                          "fatos": [{"role": "takeoff"}, {"role": "landing"}]})
        return {**definition, "id": identifier, "layout": generate_layout(definition)}

    places = [vertiport("VP1", "여의도", 37.525, 126.920), vertiport("VP2", "봉천", 37.478, 126.941)]
    nodes = [{"id": "WP1", "name": "영등포", "latitude": 37.515, "longitude": 126.925,
              "altitude_m": 304.8, "altitude_reference": "agl"}]
    links = [{"id": "L1", "from": "fato:VP1:F1", "to": "WP1", "segment": "C", "width_m": None, "name": "출발"},
             {"id": "L2", "from": "WP1", "to": "fato:VP2:F2", "segment": "G", "width_m": None, "name": "도착"}]
    network = build_network(nodes, links, places)
    request = {"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 2,
               "visual_asset_id": "projectairsim_airtaxi",
               "battery_start_pct": 100.0, "charge_target_pct": 100.0}

    plan = flight_plan.build_plan(request, places, network)
    legs = {leg["stage"]: leg for leg in plan["legs"]}
    flown = profile.speeds()
    assert legs["gate_out"]["speed_mps"] == pytest.approx(flown["taxi_out_mps"], abs=0.01)
    assert legs["gate_in"]["speed_mps"] == pytest.approx(flown["taxi_in_mps"], abs=0.01)
    assert legs["takeoff"]["speed_mps"] == pytest.approx(flown["vertical_mps"], abs=0.01)
    assert legs["landing"]["speed_mps"] == pytest.approx(flown["landing_vertical_mps"], abs=0.01)
    assert plan["aircraft"]["operating_profile"]["cruise_kt"] == 130.0

    # A slower cruise makes the same corridor take longer, and moves nothing else.
    slower = flight_plan.build_plan(request, places, network, profile={"cruise_kt": 65})
    heights = lambda built: [point[2] for leg in built["legs"] if leg["kind"] == "air"
                             for point in leg["path"]]
    assert heights(slower) == heights(plan), "the route decides the height, not the speed"
    assert slower["totals"]["air_distance_m"] == plan["totals"]["air_distance_m"]
    assert slower["totals"]["flight_duration_s"] > plan["totals"]["flight_duration_s"]


# ---- the store and the wire ------------------------------------------------
def client(tmp_path):
    settings = OperatingProfileSettings(tmp_path / "operating_profile.json")
    app = FastAPI()
    app.include_router(create_operating_profile_router(settings))
    return TestClient(app), settings


def test_nothing_written_yet_reads_as_the_operating_figures(tmp_path):
    settings = OperatingProfileSettings(tmp_path / "missing.json")
    assert settings.read() == profile.defaults()
    # A damaged file is "nothing set yet" rather than a dashboard that will not start.
    broken = tmp_path / "broken.json"
    broken.write_text("{ not json", encoding="utf-8")
    assert OperatingProfileSettings(broken).read() == profile.defaults()


def test_the_pilot_sets_it_and_it_stays_set(tmp_path):
    api, settings = client(tmp_path)
    with api:
        described = api.get("/api/simulation/operating-profile").json()
        assert described["values"]["cruise_kt"] == 130.0
        assert [field["name"] for field in described["fields"]] == list(profile.FIELD_NAMES)
        assert described["phases"][0]["phase"] == "gate_out"
        assert "고도" in described["not_taken"]

        answer = api.put("/api/simulation/operating-profile", json={"values": {"cruise_kt": 110}})
        assert answer.status_code == 200
        assert answer.json()["values"]["cruise_kt"] == 110.0
        assert answer.json()["derived"]["cruise_mps"] == pytest.approx(56.6, abs=0.1)
        assert settings.read()["cruise_kt"] == 110.0, "and it is on disk"
        assert json.loads((tmp_path / "operating_profile.json").read_text(encoding="utf-8"))["cruise_kt"] == 110.0

        # A bare object works too, so a caller need not wrap it.
        assert api.put("/api/simulation/operating-profile", json={"taxi_in_kt": 3.5}).json()["values"]["taxi_in_kt"] == 3.5
        assert settings.read()["cruise_kt"] == 110.0, "and the earlier change is still there"

        refused = api.put("/api/simulation/operating-profile", json={"values": {"cruise_kt": 900}})
        assert refused.status_code == 422 and "cruise_kt" in refused.json()["message"]
        assert settings.read()["cruise_kt"] == 110.0, "a refused change changes nothing"
        assert api.put("/api/simulation/operating-profile", content=b"not json").status_code == 422

        back = api.post("/api/simulation/operating-profile/reset")
        assert back.status_code == 200 and back.json()["values"] == profile.defaults()
