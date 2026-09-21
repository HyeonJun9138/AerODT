"""Route network: waypoint and link validation, FATO endpoints, storage, wire and naming."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from communication.external.place_names import PlaceNameLookup, pick_locality
from data.simulation.route_records import RouteRecords
from digital_twin.model_library import route_network as rn
from user_application.apps.web_dashboard.application import create_app

SEOUL = {"latitude": 37.53, "longitude": 126.93}


def vertiport(identifier="vp-1", name="여의도", roles=("takeoff", "landing")):
    fatos = [{"id": f"F{i}", "role": role, "center_m": [20.0 * i, 40.0]} for i, role in enumerate(roles, start=1)]
    return {"id": identifier, "name": name, "latitude": 37.5, "longitude": 127.0,
            "layout": {"frame": {"latitude": 37.5, "longitude": 127.0, "heading_deg": 0}, "fatos": fatos,
                       "platform": {"height_m": 1.0}}}


def test_a_waypoint_defaults_to_a_thousand_feet_above_ground():
    node = rn.validate_node({"name": " 여의도 진입 ", **SEOUL})
    assert node == {"name": "여의도 진입", "latitude": 37.53, "longitude": 126.93, "altitude_m": 304.8, "altitude_reference": "agl"}
    absolute = rn.validate_node({"name": "n", **SEOUL, "altitude_m": "500", "altitude_reference": "MSL"})
    assert absolute["altitude_m"] == 500 and absolute["altitude_reference"] == "msl"


@pytest.mark.parametrize("changes,field", [
    ({"latitude": 91}, "latitude"), ({"longitude": None}, "longitude"), ({"altitude_m": -1}, "altitude_m"),
    ({"altitude_m": "high"}, "altitude_m"), ({"altitude_reference": "ground"}, "altitude_reference"), ({"name": "x" * 81}, "name")])
def test_invalid_waypoints_name_the_field(changes, field):
    with pytest.raises(ValueError) as error:
        rn.validate_node({"name": "n", **SEOUL, **changes})
    assert str(error.value).startswith(field + ":")


def test_an_unnamed_waypoint_takes_the_nearby_place_name_numbered_to_be_unique():
    assert rn.validate_node({**SEOUL, "place_name": "여의도동"}, [])["name"] == "여의도동"
    assert rn.validate_node({**SEOUL, "place_name": "여의도동"}, ["여의도동"])["name"] == "여의도동 2"
    assert rn.validate_node({**SEOUL, "place_name": "여의도동"}, ["여의도동", "여의도동 2"])["name"] == "여의도동 3"
    assert rn.validate_node({**SEOUL}, ["지점"])["name"] == "지점 2", "no place known: the default, still unique"
    assert rn.validate_node({**SEOUL, "name": "여의도동", "place_name": "강남"}, ["여의도동"])["name"] == "여의도동", "a typed name is kept as typed"


def test_fato_endpoints_come_from_the_vertiport_layout_with_their_roles():
    endpoints = rn.fato_endpoints([vertiport()])
    assert [e["id"] for e in endpoints] == ["fato:vp-1:F1", "fato:vp-1:F2"]
    assert [e["role"] for e in endpoints] == ["takeoff", "landing"]
    assert endpoints[0]["name"] == "여의도 F1" and endpoints[0]["kind"] == "fato"
    assert endpoints[0]["latitude"] == pytest.approx(37.5 + 40 / 111320, abs=1e-7), "the FATO centre, not the deck centre"
    assert endpoints[1]["longitude"] > endpoints[0]["longitude"]
    assert endpoints[0]["hover_m"] == rn.FATO_HOVER_M and endpoints[0]["platform_height_m"] == 1.0
    assert rn.fato_endpoints([{"id": "vp-2", "name": "no layout"}]) == []


def network_fixture():
    nodes = {"rn-a": {"id": "rn-a", "name": "A", **SEOUL}, "rn-b": {"id": "rn-b", "name": "B", **SEOUL}}
    fatos = {f["id"]: f for f in rn.fato_endpoints([vertiport()])}
    return nodes, fatos


def test_a_link_joins_two_endpoints_with_a_width_and_a_segment_and_is_named_after_them():
    nodes, fatos = network_fixture()
    link = rn.validate_link({"from": "rn-a", "to": "rn-b", "segment": "f"}, nodes, fatos)
    assert link == {"name": "A → B", "from": "rn-a", "to": "rn-b", "width_m": 300.0, "segment": "F"}
    departure = rn.validate_link({"from": "fato:vp-1:F1", "to": "rn-a", "segment": "C", "width_m": 150, "name": "출발"}, nodes, fatos)
    assert departure["name"] == "출발" and departure["width_m"] is None, "only the cruise segment is a corridor"
    assert rn.validate_link({"from": "rn-a", "to": "rn-b", "segment": "F", "width_m": 450}, nodes, fatos)["width_m"] == 450
    arrival = rn.validate_link({"from": "rn-b", "to": "fato:vp-1:F2", "segment": "I"}, nodes, fatos)
    assert arrival["segment"] == "G", "the letters the descent absorbed still read"
    assert arrival["name"] == "B → 여의도 F2"


@pytest.mark.parametrize("body,field,reason", [
    ({"from": "rn-a", "to": "rn-a", "segment": "F"}, "to", "differ"),
    ({"from": "rn-a", "to": "rn-zz", "segment": "F"}, "to", "unknown node"),
    ({"from": "fato:vp-9:F1", "to": "rn-a", "segment": "C"}, "from", "unknown FATO"),
    ({"from": "fato:vp-1:F2", "to": "rn-a", "segment": "C"}, "from", "does not take off"),
    ({"from": "rn-a", "to": "fato:vp-1:F1", "segment": "I"}, "to", "does not land"),
    ({"from": "fato:vp-1:F1", "to": "fato:vp-1:F2", "segment": "F"}, "to", "waypoint between"),
    ({"from": "rn-a", "to": "rn-b", "segment": "B"}, "segment", "one of"),
    ({"from": "rn-a", "to": "rn-b", "segment": "L"}, "segment", "one of"),
    ({"from": "rn-a", "to": "rn-b", "segment": "F", "width_m": 5}, "width_m", "between"),
])
def test_links_that_break_the_profile_are_refused_with_the_field_named(body, field, reason):
    nodes, fatos = network_fixture()
    with pytest.raises(ValueError) as error:
        rn.validate_link(body, nodes, fatos)
    assert str(error.value).startswith(field + ":") and reason in str(error.value)


def test_the_same_pair_is_not_linked_twice_in_one_direction_but_the_return_is_allowed():
    nodes, fatos = network_fixture()
    existing = [{"id": "rl-1", "from": "rn-a", "to": "rn-b", "segment": "F"}]
    with pytest.raises(ValueError, match="already linked"):
        rn.validate_link({"from": "rn-a", "to": "rn-b", "segment": "F"}, nodes, fatos, existing)
    with pytest.raises(ValueError, match="already linked"):
        rn.validate_link({"from": "rn-b", "to": "rn-a", "segment": "F"}, nodes, fatos, existing)
    # A FATO is the exception: one direction is the vertiport's departure and
    # the other its arrival, so both may exist between the same two endpoints.
    departure = [{"id": "rl-2", "from": "fato:vp-1:F1", "to": "rn-a", "segment": "C"}]
    rn.validate_link({"from": "rn-a", "to": "fato:vp-1:F2", "segment": "G"}, nodes, fatos, departure)
    assert rn.pair_key("rn-a", "rn-b") == rn.pair_key("rn-b", "rn-a")
    assert rn.pair_key("fato:vp-1:F1", "rn-a") != rn.pair_key("rn-a", "fato:vp-1:F1")
    rn.validate_link({"id": "rl-1", "from": "rn-a", "to": "rn-b", "segment": "G"}, nodes, fatos, existing), "editing itself is fine"


def test_the_suggested_segment_follows_the_profile():
    links = [{"from": "fato:vp-1:F1", "to": "rn-a", "segment": "C"}]
    assert rn.suggest_segment("fato:vp-1:F1", "rn-a", []) == "C"
    assert rn.suggest_segment("rn-a", "fato:vp-1:F2", links) == "G"
    assert rn.suggest_segment("rn-a", "rn-b", links) == "F", "what follows the climb that arrived"
    assert rn.suggest_segment("rn-b", "rn-c", []) == "F", "nothing known: cruise"
    older = [{"from": "rn-a", "to": "rn-b", "segment": "E"}]
    assert rn.suggest_segment("rn-b", "rn-c", older) == "F", "an older letter is read as its run"


def test_a_network_drops_links_whose_endpoint_is_gone():
    nodes = [{"id": "rn-a", "name": "A", **SEOUL}]
    links = [{"id": "rl-1", "from": "rn-a", "to": "fato:vp-1:F2", "segment": "I"},
             {"id": "rl-2", "from": "rn-gone", "to": "rn-a", "segment": "F"}]
    result = rn.network(nodes, links, [vertiport()])
    assert [link["id"] for link in result["links"]] == ["rl-1"] and result["dropped_links"] == 1
    assert len(result["fatos"]) == 2
    without = rn.network(nodes, links, [])
    assert without["links"] == [] and without["fatos"] == [], "a deleted vertiport takes its links with it"


def test_options_list_the_three_selectable_runs_in_profile_order():
    options = rn.describe_options()
    assert [s["id"] for s in options["segments"]] == ["C", "F", "G"], "climb-out, cruise, descent"
    assert [s["covers"] for s in options["segments"]] == ["C–E", "F", "G–I"]
    assert options["merged_segments"] == {"D": "C", "E": "C", "H": "G", "I": "G"}
    assert set(options["profile"]) == {"A", "B", "J", "K"}, "what the vertiport owns at either end"
    assert options["defaults"]["altitude_ft"] == 1000 and options["defaults"]["altitude_m"] == 304.8
    assert options["defaults"]["width_m"] == 300 and options["defaults"]["corridor_segment"] == "F"
    assert all(s["color"].startswith("#") and s["label"] for s in options["segments"])


def test_records_store_nodes_and_links_and_a_deleted_node_takes_its_links(tmp_path):
    records = RouteRecords(tmp_path / "routes.json")
    a = records.create_node({"name": "A", **SEOUL})
    b = records.create_node({"name": "B", **SEOUL})
    assert a["id"] == "WP001" and a["created_at"]
    link = records.create_link({"name": "A → B", "from": a["id"], "to": b["id"], "segment": "F", "width_m": 300})
    assert link["id"].startswith("rl-")
    other = records.create_link({"name": "B → A", "from": b["id"], "to": a["id"], "segment": "F", "width_m": 300})
    assert records.update_link(link["id"], {"name": "A → B", "from": a["id"], "to": b["id"], "segment": "G", "width_m": 200})["segment"] == "G"
    assert records.update_node("rn-missing", {"name": "x"}) is None
    reloaded = RouteRecords(tmp_path / "routes.json")
    assert [n["name"] for n in reloaded.nodes()] == ["A", "B"] and len(reloaded.links()) == 2
    assert reloaded.delete_node(b["id"]) == 2, "both links touched B"
    assert reloaded.nodes()[0]["id"] == a["id"] and reloaded.links() == []
    assert reloaded.delete_node(b["id"]) is None
    assert reloaded.delete_link(other["id"]) is False
    (tmp_path / "routes.json").write_text("not json", encoding="utf-8")
    assert RouteRecords(tmp_path / "routes.json").nodes() == [], "a damaged file is an empty network"


def client_for(tmp_path):
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": 5, "stream_seconds": 5, "place_names_enabled": False}, sources=[])
    return TestClient(app)


def test_the_wire_builds_a_route_from_a_take_off_fato_to_a_landing_fato(tmp_path):
    with client_for(tmp_path) as client:
        created = client.post("/api/simulation/vertiports", json={"name": "여의도", "latitude": 37.53, "longitude": 126.93,
                                                                  "gates": 2, "fatos": [{"role": "takeoff"}, {"role": "landing"}]})
        assert created.status_code == 201
        vertiport_id = created.json()["vertiport"]["id"]
        network = client.get("/api/simulation/routes").json()
        assert [f["id"] for f in network["fatos"]] == [f"fato:{vertiport_id}:F1", f"fato:{vertiport_id}:F2"]
        assert network["nodes"] == [] and network["links"] == []
        node = client.post("/api/simulation/routes/nodes", json={"latitude": 37.55, "longitude": 126.95, "place_name": "여의도동"})
        assert node.status_code == 201 and node.json()["node"]["name"] == "여의도동"
        second = client.post("/api/simulation/routes/nodes", json={"latitude": 37.56, "longitude": 126.99, "place_name": "여의도동"})
        assert second.json()["node"]["name"] == "여의도동 2"
        a, b = node.json()["node"]["id"], second.json()["node"]["id"]
        climb = client.post("/api/simulation/routes/links", json={"from": f"fato:{vertiport_id}:F1", "to": a, "segment": "C"})
        assert climb.status_code == 201 and climb.json()["link"]["name"] == "여의도 F1 → 여의도동"
        wrong = client.post("/api/simulation/routes/links", json={"from": f"fato:{vertiport_id}:F2", "to": a, "segment": "C"})
        assert wrong.status_code == 422 and wrong.json()["field"] == "from"
        cruise = client.post("/api/simulation/routes/links", json={"from": a, "to": b, "segment": "F", "width_m": 400}).json()["link"]
        assert cruise["width_m"] == 400 and climb.json()["link"]["width_m"] is None
        arrival = client.post("/api/simulation/routes/links", json={"from": b, "to": f"fato:{vertiport_id}:F2", "segment": "I"}).json()["link"]
        assert arrival["segment"] == "G"
        network = client.get("/api/simulation/routes").json()
        assert [link["segment"] for link in network["links"]] == ["C", "F", "G"]
        edited = client.put(f"/api/simulation/routes/links/{cruise['id']}", json={**cruise, "segment": "E"})
        assert edited.status_code == 200 and edited.json()["link"]["segment"] == "C" and edited.json()["link"]["width_m"] is None
        assert client.put("/api/simulation/routes/nodes/rn-missing", json={"name": "x", **SEOUL}).status_code == 404
        renamed = client.put(f"/api/simulation/routes/nodes/{a}", json={"name": "여의도 진입", "latitude": 37.55, "longitude": 126.95,
                                                                        "altitude_m": 400, "altitude_reference": "msl"})
        assert renamed.json()["node"]["altitude_m"] == 400
        # The vertiport goes: its FATOs and the links that used them go with it.
        assert client.delete(f"/api/simulation/vertiports/{vertiport_id}").status_code == 204
        network = client.get("/api/simulation/routes").json()
        assert network["fatos"] == [] and [link["id"] for link in network["links"]] == [cruise["id"]] and network["dropped_links"] == 2
        removed = client.delete(f"/api/simulation/routes/nodes/{a}")
        # The cruise link and the stored climb link that was already dangling.
        assert removed.status_code == 200 and removed.json()["removed_links"] == 2
        # The arrival link lost its FATO but is still stored until it is deleted.
        assert client.delete(f"/api/simulation/routes/links/{arrival['id']}").status_code == 204
        assert client.delete(f"/api/simulation/routes/links/{arrival['id']}").status_code == 404
        assert client.get("/api/simulation/routes/options").json()["defaults"]["width_m"] == 300
        place = client.get("/api/simulation/routes/place", params={"latitude": 37.5, "longitude": 127})
        assert place.status_code == 200 and place.json()["name"] is None, "lookups switched off answer no name"
        assert client.get("/api/simulation/routes/place", params={"latitude": 95, "longitude": 127}).status_code == 422
        saved = json.loads((tmp_path / "simulation/routes.json").read_text(encoding="utf-8"))
        assert saved["schema_version"] == 1 and len(saved["nodes"]) == 1


def test_a_locality_below_city_level_is_picked_from_the_address():
    assert pick_locality({"quarter": "여의도동", "suburb": "여의동", "borough": "영등포구", "city": "서울특별시"}) == "여의도동"
    assert pick_locality({"suburb": "여의동", "city": "서울특별시"}) == "여의동"
    assert pick_locality({"city": "서울특별시", "country": "대한민국"}) is None, "a whole city names nothing"
    assert pick_locality(None) is None


def test_the_lookup_asks_once_per_place_and_answers_none_when_the_service_fails():
    asked = []

    def handle(request):
        asked.append(dict(request.url.params))
        if request.url.params["lat"].startswith("0."):
            return httpx.Response(503)
        return httpx.Response(200, json={"address": {"quarter": "여의도동", "city": "서울특별시"}})

    lookup = PlaceNameLookup(transport=httpx.MockTransport(handle), clock=lambda: 0.0)

    async def scenario():
        assert await lookup.lookup(37.5304, 126.9294) == "여의도동"
        assert await lookup.lookup(37.5304, 126.9294) == "여의도동"
        assert await lookup.lookup(37.53041, 126.92941) == "여의도동", "inside the same grid cell"
        assert await lookup.lookup(37.5321, 126.9312) == "여의도동", "a few hundred metres away: the same locality, answered from memory"
        assert await lookup.lookup(0.1, 0.1) is None
        assert await lookup.lookup(0.1, 0.1) is None, "a failure is not cached as a name"

        await lookup.close()

    asyncio.run(scenario())
    assert len(asked) == 3, "one request per place, plus the failure twice"
    assert asked[0]["User-Agent"] if "User-Agent" in asked[0] else True
    assert asked[0]["zoom"] == "14" and asked[0]["accept-language"] == "ko"
