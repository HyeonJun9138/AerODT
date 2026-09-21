"""Deck-relative terminal heights remain directional on shared FATOs."""
from copy import deepcopy

import pytest

from digital_twin.model_library import flight_plan as fp
from digital_twin.model_library import route_network as rn
from digital_twin.model_library import vertiport_layout as vl


def record(identifier, latitude, **changes):
    definition = vl.validate_definition({"name": identifier, "latitude": latitude, "longitude": 127,
                                         "gates": 2, "fatos": [{"role": "both"}], **changes})
    return dict(definition, id=identifier, layout=vl.generate_layout(definition))


def test_default_and_explicit_terminal_heights_reach_layout_and_options():
    for changes, expected in [({}, (30, 30)),
                              ({"takeoff_height_m": 45, "landing_height_m": 70}, (45, 70))]:
        port = record("A", 37, **changes)
        for key, value in zip(("takeoff_height_m", "landing_height_m"), expected):
            assert port[key] == port["layout"][key] == value
            assert vl.describe_options()["defaults"][key] == 30
            assert vl.describe_options()["limits"][key] == [1, 300]


@pytest.mark.parametrize("key", ["takeoff_height_m", "landing_height_m"])
@pytest.mark.parametrize("value", [0, -1, 301, float("nan"), float("inf"), "bad", True])
def test_invalid_terminal_height_is_rejected(key, value):
    with pytest.raises(ValueError, match=key):
        record("A", 37, **{key: value})


@pytest.mark.parametrize("direct", [False, True])
def test_shared_fato_uses_departure_and_arrival_heights_without_path_mutation(direct):
    ports = [record("A", 37, takeoff_height_m=45, landing_height_m=65),
             record("B", 37.05, takeoff_height_m=80, landing_height_m=55)]
    nodes = [dict(id="W", name="W", latitude=37.025, longitude=127,
                  altitude_m=300, altitude_reference="agl")]
    links = [dict(id="L1", **{"from": "fato:A:F1", "to": "W", "segment": "C"}),
             dict(id="L2", **{"from": "W", "to": "fato:B:F1", "segment": "G"})]
    network = rn.network(nodes, [] if direct else links, ports)
    assert network["fatos"][1]["landing_height_m"] == 55
    assert network["fatos"][1]["hover_m"] == 80
    path = (fp.direct_path if direct else fp.air_path)(network, "fato:A:F1", "fato:B:F1")
    assert path["ground"][0]["altitude_m"] == 45
    assert path["ground"][-1]["altitude_m"] == 55
    reverse = fp.direct_path(network, "fato:B:F1", "fato:A:F1")
    assert [reverse["ground"][i]["altitude_m"] for i in (0, -1)] == [80, 65]
    # A supplied candidate may have been made before an editor changed heights.
    path["ground"][0]["altitude_m"] = 30
    path["ground"][-1]["altitude_m"] = 30
    original = deepcopy(path)
    request = fp.validate_request(dict(from_vertiport="A", to_vertiport="B"), fp.plan_options(ports, network))
    plan = fp.build_plan(request, ports, network, supplied_air_path=path)
    assert path == original
    legs = {leg["stage"]: leg for leg in plan["legs"]}
    assert legs["takeoff"]["path"][-1][2:] == [45, "deck:A"]
    assert legs["landing"]["path"][0][2:] == [55, "deck:B"]
    assert legs["takeoff"]["path"][-1] == legs["climb"]["path"][0]
    assert legs["descent"]["path"][-1] == legs["landing"]["path"][0]
    for stage in ("takeoff", "landing"):
        leg = legs[stage]
        assert leg["path"][0][:2] == leg["path"][-1][:2]
        assert leg["duration_s"] == pytest.approx(leg["climb_m"] / leg["speed_mps"], abs=0.1)


def test_legacy_endpoint_hover_height_is_preserved():
    network = {"nodes": [], "links": [], "fatos": [
        dict(id="fato:A:F1", vertiport="A", latitude=37, longitude=127, hover_m=42),
        dict(id="fato:B:F1", vertiport="B", latitude=37.05, longitude=127, hover_m=53)]}
    path = fp.direct_path(network, "fato:A:F1", "fato:B:F1")
    assert [path["ground"][i]["altitude_m"] for i in (0, -1)] == [42, 53]


def test_landing_only_compatibility_alias_and_old_layout_defaults():
    port = record("A", 37, fatos=[{"role": "takeoff"}, {"role": "landing"}],
                  takeoff_height_m=45, landing_height_m=60)
    assert [point["hover_m"] for point in rn.fato_endpoints([port])] == [45, 60]
    for source in (port, port["layout"]):
        source.pop("takeoff_height_m")
        source.pop("landing_height_m")
    assert [point["hover_m"] for point in rn.fato_endpoints([port])] == [30, 30]
