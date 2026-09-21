"""A whole flight: taxi out, lift off, fly, land, taxi in, charge — and what
the wire answers for it."""
import math

import pytest
from fastapi.testclient import TestClient

from communication.web.plan_routes import create_plan_router
from digital_twin.model_library import flight_plan as fp
from digital_twin.model_library import uam_operating_profile
from digital_twin.model_library.route_network import network as build_network
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition
from fastapi import FastAPI


def vertiport(identifier, name, latitude, longitude, **changes):
    definition = validate_definition({"name": name, "latitude": latitude, "longitude": longitude,
                                      "heading_deg": 0, "gates": 3, "platform_height_m": 20,
                                      "fatos": [{"role": "takeoff"}, {"role": "landing"}], **changes})
    return {**definition, "id": identifier, "layout": generate_layout(definition)}


VERTIPORTS = [vertiport("VP1", "여의도", 37.525, 126.920), vertiport("VP2", "봉천", 37.478, 126.941)]
NODES = [{"id": "WP1", "name": "영등포", "latitude": 37.515, "longitude": 126.925, "altitude_m": 304.8,
          "altitude_reference": "agl"},
         {"id": "WP2", "name": "신림동", "latitude": 37.490, "longitude": 126.933, "altitude_m": 304.8,
          "altitude_reference": "agl"}]
LINKS = [{"id": "L1", "from": "fato:VP1:F1", "to": "WP1", "segment": "C", "width_m": None, "name": "출발"},
         {"id": "L2", "from": "WP1", "to": "WP2", "segment": "F", "width_m": 300.0, "name": "순항"},
         {"id": "L3", "from": "WP2", "to": "fato:VP2:F2", "segment": "G", "width_m": None, "name": "도착"}]
NETWORK = build_network(NODES, LINKS, VERTIPORTS)


def options():
    return fp.plan_options(VERTIPORTS, NETWORK)


def plan(**changes):
    asked = {"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 3, **changes}
    return fp.build_plan(fp.validate_request(asked, options()), VERTIPORTS, NETWORK)


def test_the_options_say_which_vertiports_can_be_flown_between():
    described = options()
    assert [item["id"] for item in described["vertiports"]] == ["VP1", "VP2"]
    first = described["vertiports"][0]
    assert first["gates"] and first["takeoff_fato"] == "F1" and first["landing_fato"] == "F2"
    assert described["reachable"]["VP1"] == ["VP2"], "the links join them one way"
    assert described["reachable"]["VP2"] == [], "and not back, because no link runs that way"
    assert [stage["id"] for stage in described["stages"]] == list(fp.STAGE_IDS)
    assert described["aircraft"][0]["passenger_capacity"] == 4


def test_a_request_is_checked_against_what_exists():
    for changes, field in (({"from_vertiport": "VP9"}, "from_vertiport"),
                           ({"to_vertiport": "VP9"}, "to_vertiport"),
                           ({"to_vertiport": "VP1"}, "to_vertiport"),
                           ({"passengers": 9}, "passengers"),
                           ({"passengers": "셋"}, "passengers"),
                           ({"battery_start_pct": 140}, "battery_start_pct")):
        with pytest.raises(ValueError) as error:
            fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP2", **changes}, options())
        assert str(error.value).startswith(field + ":")
    asked = fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP2"}, options())
    assert asked["passengers"] == options()["defaults"]["passengers"]
    assert asked["battery_start_pct"] == 100.0


def test_the_flight_runs_gate_to_fato_to_air_to_fato_to_gate_to_charger():
    built = plan()
    assert [leg["stage"] for leg in built["legs"]] == \
        ["gate_out", "takeoff", "climb", "cruise", "descent", "landing", "gate_in", "charge"]
    assert built["departure"] == {"vertiport": "VP1", "name": "여의도", "gate": "G1", "fato": "F1",
                                  "deck_height_m": 20.0, "datum": "deck:VP1", "hover_m": 30.0}
    assert built["decks"] == ["VP1", "VP2"], "the display resolves these two decks before placing the flight"
    assert built["arrival"]["gate"] == "G1" and built["arrival"]["fato"] == "F2"
    assert built["arrival"]["charger"], "the stand it comes back to has a charging point"
    assert built["vehicle"]["passengers"] == 3 and built["vehicle"]["capacity"] == 4
    # The air legs follow the segments the operator drew on the links.
    air = {leg["stage"]: leg for leg in built["legs"] if leg["kind"] == "air"}
    assert air["climb"]["segment"] == "C" and air["cruise"]["segment"] == "F" and air["descent"]["segment"] == "G"
    assert air["cruise"]["waypoints"] == ["WP1", "WP2"]
    assert air["climb"]["waypoints"][0] == "fato:VP1:F1" and air["descent"]["waypoints"][-1] == "fato:VP2:F2"
    # The ground legs really run along the deck's own taxiways, gate to FATO.
    out = built["legs"][0]
    assert out["taxi_nodes"][0] == "G1" and out["taxi_nodes"][-1] == "F1"
    assert len(out["taxi_nodes"]) > 2, "through the junctions between them, not straight across"
    assert built["legs"][6]["taxi_nodes"][0] == "F2" and built["legs"][6]["taxi_nodes"][-1] == "G1"
    assert built["totals"]["ground_distance_m"] > 0 and built["totals"]["air_distance_m"] > 1000


def test_every_leg_is_placed_in_time_and_in_space_without_a_gap():
    built = plan()
    assert built["legs"][0]["start_s"] == 0.0
    for before, after in zip(built["legs"], built["legs"][1:]):
        assert before["end_s"] == pytest.approx(after["start_s"], abs=0.05), "no gap between stages"
        assert before["path"][-1][:2] == pytest.approx(after["path"][0][:2], abs=1e-4), "and none in space"
    assert built["legs"][-1]["end_s"] == pytest.approx(built["totals"]["duration_s"], abs=0.05)
    for leg in built["legs"]:
        assert len(leg["path"]) >= 2 and all(len(point) == 4 for point in leg["path"])
        assert leg["duration_s"] >= 0 and leg["distance_m"] >= 0
    # The vertical legs stand still and change height; the deck taxi holds it.
    takeoff = built["legs"][1]
    assert takeoff["path"][0][:2] == takeoff["path"][1][:2] and takeoff["path"][1][2] > takeoff["path"][0][2]
    landing = built["legs"][5]
    assert landing["path"][1][2] < landing["path"][0][2]
    assert built["legs"][0]["path"][0][2] == built["legs"][0]["path"][-1][2] == 0.0, "a taxi is on the deck"


def test_heights_are_left_as_they_were_designed_for_the_display_to_stand_on_the_ground():
    """Resolving here would put the aircraft at sea level over a hill: every
    point says what it was measured from instead."""
    built = plan()
    legs = {leg["stage"]: leg for leg in built["legs"]}
    # On the deck, and over the deck: the vertiport's own datum, not a number.
    for stage in ("gate_out", "takeoff", "landing", "gate_in", "charge"):
        assert all(point[3].startswith("deck:") for point in legs[stage]["path"]), stage
    assert legs["gate_out"]["path"][0][3] == "deck:VP1" and legs["gate_in"]["path"][0][3] == "deck:VP2"
    assert legs["takeoff"]["path"][0][2] == 0.0, "it starts on the deck"
    assert legs["takeoff"]["path"][1][2] == 30.0, "and rises the hover height above it"
    # A waypoint keeps the datum the operator drew it against.
    cruise = legs["cruise"]
    assert [point[3] for point in cruise["path"]] == ["agl", "agl"], "1,000 ft AGL is over the ground under it"
    assert all(point[2] == 304.8 for point in cruise["path"])
    # The FATO ends of the air legs are over their own decks.
    assert legs["climb"]["path"][0][3] == "deck:VP1" and legs["descent"]["path"][-1][3] == "deck:VP2"
    assert legs["climb"]["path"][0][2] == 30.0
    # An absolute waypoint stays absolute.
    absolute = [{**NODES[0], "altitude_reference": "msl"}, NODES[1]]
    other = build_network(absolute, LINKS, VERTIPORTS)
    flown = fp.build_plan(fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP2"},
                                              fp.plan_options(VERTIPORTS, other)), VERTIPORTS, other)
    climb = next(leg for leg in flown["legs"] if leg["stage"] == "climb")
    assert climb["path"][-1][3] == "msl"


def test_the_rotors_tilt_forward_through_the_climb_and_back_through_the_descent():
    built = plan()
    tilts = {leg["stage"]: (leg["tilt_start_deg"], leg["tilt_end_deg"]) for leg in built["legs"]}
    assert tilts["gate_out"] == (0.0, 0.0) and tilts["takeoff"] == (0.0, 0.0), "a hover has its rotors up"
    assert tilts["climb"] == (0.0, 90.0), "the transition to wing-borne flight"
    assert tilts["cruise"] == (90.0, 90.0)
    assert tilts["descent"] == (90.0, 0.0), "and back to a hover before it lands"
    assert tilts["landing"] == (0.0, 0.0) and tilts["charge"] == (0.0, 0.0)
    assert built["aircraft"]["asset_id"] == "projectairsim_airtaxi", "drawn with the tiltrotor it is"


def test_the_battery_falls_through_the_flight_and_is_charged_back_at_the_stand():
    built = plan(battery_start_pct=95, charge_target_pct=100)
    legs = built["legs"]
    assert legs[0]["battery_start_pct"] == 95.0
    for before, after in zip(legs, legs[1:]):
        assert before["battery_end_pct"] == pytest.approx(after["battery_start_pct"], abs=0.01)
    flight = [leg for leg in legs if leg["stage"] != "charge"]
    assert all(leg["battery_end_pct"] <= leg["battery_start_pct"] for leg in flight), "flying only spends"
    # A hover costs far more per second than a cruise.
    per_second = lambda leg: leg["energy_kwh"] / leg["duration_s"]
    assert per_second(legs[1]) > per_second(legs[3]) * 2, "take-off draws much more than cruise"
    charge = legs[-1]
    assert charge["stage"] == "charge" and charge["duration_s"] > 0
    assert charge["battery_end_pct"] == 100.0 and charge["energy_kwh"] < 0, "the only leg that puts energy back"
    assert charge["charge_kwh"] == pytest.approx((100 - charge["battery_start_pct"]) / 100 * 110, abs=.01)
    assert built["totals"]["battery_landing_pct"] == charge["battery_start_pct"]
    assert built["totals"]["flight_duration_s"] == charge["start_s"], "the flight ends where charging begins"
    # Empty flight and nothing left to put back: no charge or passenger hold time.
    full = plan(battery_start_pct=100, charge_target_pct=10, passengers=0)
    assert full["legs"][-1]["duration_s"] == 0.0


def test_a_pair_the_network_does_not_join_is_refused_by_name():
    lonely = [*VERTIPORTS, vertiport("VP3", "외딴곳", 37.60, 127.10)]
    network = build_network(NODES, LINKS, lonely)
    asked = fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP3"},
                                fp.plan_options(lonely, network))
    with pytest.raises(ValueError, match="route network does not join"):
        fp.build_plan(asked, lonely, network)


def test_the_shortest_taxi_and_air_paths_are_really_the_shortest():
    layout = VERTIPORTS[0]["layout"]
    taxi = fp.taxi_path(layout, "G1", "F1")
    nodes, edges = fp.deck_graph(layout)
    assert taxi["nodes"][0] == "G1" and taxi["nodes"][-1] == "F1"
    # Every step is a real edge of the deck graph, and none repeats.
    for start, end in zip(taxi["nodes"], taxi["nodes"][1:]):
        assert any(target == end for target, _ in edges[start])
    assert len(set(taxi["nodes"])) == len(taxi["nodes"])
    assert fp.taxi_path(layout, "G1", "G9") is None
    air = fp.air_path(NETWORK, "fato:VP1:F1", "fato:VP2:F2")
    assert air["nodes"] == ["fato:VP1:F1", "WP1", "WP2", "fato:VP2:F2"]
    assert air["distance_m"] == pytest.approx(sum(fp.haversine_m(a, b)
                                                  for a, b in zip(air["points"], air["points"][1:])), abs=.01)
    assert fp.air_path(NETWORK, "fato:VP2:F2", "fato:VP1:F1") is None, "C/G remain one way"


def test_cruise_is_bidirectional_without_rewriting_any_source_link():
    import copy
    saved = copy.deepcopy(NETWORK)
    forward = fp.air_path(NETWORK, "WP1", "WP2")
    reverse = fp.air_path(NETWORK, "WP2", "WP1")
    assert reverse["nodes"] == ["WP2", "WP1"]
    assert reverse["distance_m"] == pytest.approx(forward["distance_m"])
    assert reverse["links"][0]["id"] == "L2"
    assert (reverse["links"][0]["from"], reverse["links"][0]["to"]) == ("WP2", "WP1")
    assert NETWORK == saved
    assert fp.air_path(NETWORK, "WP1", "fato:VP1:F1") is None
    assert fp.air_path(NETWORK, "fato:VP2:F2", "WP2") is None


@pytest.mark.parametrize("changes", [{"direction": "forward"}, {"segment": "C"}, {"segment": "G"}])
def test_only_an_ordinary_f_corridor_gets_a_reverse_arc(changes):
    links = [dict(link, **changes) if link["id"] == "L2" else dict(link) for link in LINKS]
    net = build_network(NODES, links, VERTIPORTS)
    assert fp.air_path(net, "WP1", "WP2") is not None
    assert fp.air_path(net, "WP2", "WP1") is None


def test_a_reported_invalid_link_cannot_be_used_to_bypass_a_missing_route():
    net = {**NETWORK, "links": [dict(link, problem="invalid") if link["id"] == "L2"
                                else dict(link) for link in LINKS]}
    assert fp.air_path(net, "WP1", "WP2") is None
    assert fp.air_path(net, "WP2", "WP1") is None


def client():
    class Plans:
        @staticmethod
        def options():
            return fp.plan_options(VERTIPORTS, NETWORK)

        @staticmethod
        def build(body):
            return fp.build_plan(fp.validate_request(body, fp.plan_options(VERTIPORTS, NETWORK)),
                                 VERTIPORTS, NETWORK)

    app = FastAPI()
    app.include_router(create_plan_router(Plans()))
    return TestClient(app)


def test_the_wire_offers_the_pairs_and_answers_one_whole_flight():
    with client() as http:
        described = http.get("/api/simulation/plans/options").json()
        assert described["reachable"]["VP1"] == ["VP2"]
        built = http.post("/api/simulation/plans/preview",
                          json={"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 2})
        assert built.status_code == 200
        body = built.json()["plan"]
        assert len(body["legs"]) == len(fp.STAGE_IDS) and body["vehicle"]["passengers"] == 2
        refused = http.post("/api/simulation/plans/preview",
                            json={"from_vertiport": "VP1", "to_vertiport": "VP1"})
        assert refused.status_code == 422 and refused.json()["field"] == "to_vertiport"
        assert http.post("/api/simulation/plans/preview", json={"passengers": 1}).status_code == 422

@pytest.mark.parametrize('identifier', [model['id'] for model in fp.VISUAL_MODELS])
def test_visual_selection_keeps_airtaxi_dynamics_and_route(identifier):
    from digital_twin.simulation.native_flight_engine import waypoints_of
    selected = plan(visual_asset_id=identifier)
    baseline = plan()
    assert selected['aircraft']['asset_id'] == identifier
    assert selected['aircraft']['id'] == fp.AIRCRAFT['id']
    # Which model it is drawn with changes nothing about how it flies: every
    # value is the one the baseline flight was built with. The speeds now come
    # from the operating profile rather than from the module constant, which is
    # the point of the profile, so the two plans are compared with each other.
    for key, value in baseline['aircraft'].items():
        # The visual choice is the asset and its name; everything else is how it flies.
        if key not in ('asset_id', 'visual_label'): assert selected['aircraft'][key] == value
    flown = uam_operating_profile.speeds()
    assert selected['aircraft']['cruise_speed_mps'] == pytest.approx(flown['cruise_mps'])
    assert selected['aircraft']['vertical_speed_mps'] == pytest.approx(flown['vertical_mps'])
    assert selected['legs'] == baseline['legs']
    assert waypoints_of(selected) == waypoints_of(baseline)
    assert selected['boarding'] == baseline['boarding']


def test_unknown_visual_is_refused_and_old_requests_default_to_airtaxi():
    assert plan()['aircraft']['asset_id'] == 'projectairsim_airtaxi'
    with pytest.raises(ValueError, match='visual_asset_id'):
        plan(visual_asset_id='../../outside')
    # Every offered shape must be one the library actually publishes, or the
    # picker names a model the map cannot load.
    import json as _json
    from pathlib import Path as _Path
    root = _Path(fp.__file__).resolve().parent / 'visual_assets'
    published = {entry['asset_id'] for entry in _json.loads((root / 'catalog.json').read_text(encoding='utf-8'))['assets']}
    offered = [model['id'] for model in options()['visual_models']]
    assert len(offered) == len(set(offered))
    assert set(offered) <= published, set(offered) - published
    assert 'projectairsim_airtaxi' in offered and 'nasa_lift_cruise' in offered


def test_a_shared_pad_wired_one_way_is_used_the_way_the_network_joins_it():
    """Two 'both' pads, the drawing leaving from one and arriving at the other:
    a flight into the deck lands on the pad the network reaches, not on the
    first pad in the list, which the network only ever leaves from."""
    shared = vertiport("VP3", "천호", 37.540, 127.120, fatos=[{"role": "both"}, {"role": "both"}])
    ports = [*VERTIPORTS, shared]
    links = [*LINKS,
             {"id": "L4", "from": "WP2", "to": "fato:VP3:F2", "segment": "G", "width_m": None, "name": "천호 도착"},
             {"id": "L5", "from": "fato:VP3:F1", "to": "WP2", "segment": "C", "width_m": None, "name": "천호 출발"}]
    network = build_network(NODES, links, ports)
    assert fp.linked_fatos(network, "VP3", "landing") == {"F2"}
    assert fp.linked_fatos(network, "VP3", "takeoff") == {"F1"}
    options = fp.plan_options(ports, network)
    deck = next(item for item in options["vertiports"] if item["id"] == "VP3")
    assert (deck["takeoff_fato"], deck["landing_fato"]) == ("F1", "F2")
    inbound = fp.build_plan(fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP3", "passengers": 3}, options),
                            ports, network)
    assert inbound["arrival"]["fato"] == "F2"
    outbound = fp.build_plan(fp.validate_request({"from_vertiport": "VP3", "to_vertiport": "VP2", "passengers": 3}, options),
                             ports, network)
    assert outbound["departure"]["fato"] == "F1"
    # Asking outright for the pad the network does not reach is still refused by name.
    asked = dict(fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP3", "passengers": 3}, options),
                 to_fato="F1")
    with pytest.raises(ValueError, match="does not join"):
        fp.build_plan(asked, ports, network)
