"""How a newly created record is named, and that the numbering carries on.

The stored sets are numbered (VP001, WP001). A record made in the application
must continue that numbering rather than starting a second, unreadable style
beside it, and must never take back the number of something deleted: a saved
flight whose `datum` reads `deck:VP007` would then point at a different place.
"""
import json

from data.simulation.identifiers import highest, number_of, numbered, random_id
from data.simulation.route_records import RouteRecords
from data.simulation.vertiport_records import VertiportRecords
from digital_twin.model_library.route_network import validate_link, validate_node
from digital_twin.model_library.vertiport_layout import validate_definition


def definition(**overrides):
    body = {"name": "김포 버티허브", "latitude": 37.55, "longitude": 126.79, "heading_deg": 30, "gates": 3,
            "pattern": "row", "vehicle_class": "medium", "platform_height_m": 1, "ground_reference": "highest",
            "fatos": [{"role": "both"}]}
    body.update(overrides)
    return validate_definition(body)


def test_the_next_number_is_above_every_one_in_use_and_above_every_one_issued():
    assert numbered("VP", []) == "VP001"
    assert numbered("VP", ["VP001", "VP002", "VP018"]) == "VP019"
    # VP002 was deleted. Handing it out again would make an old flight record
    # naming deck:VP002 point at a different vertiport.
    assert numbered("VP", ["VP001", "VP003"]) == "VP004"
    # A set imported with another style is passed over rather than confusing it.
    assert numbered("VP", ["vp-4f3a9c21", "VP007"]) == "VP008"
    assert numbered("VP", ["vp-4f3a9c21"]) == "VP001"
    assert numbered("WP", ["WP007", "rn-ae94cb2e", "WP135"]) == "WP136"
    # A set that outgrows the written width gets longer rather than renumbered.
    assert numbered("VP", ["VP0999"]) == "VP1000"
    assert numbered("VP", ["VP1000"]) == "VP1001"
    # Nothing should already hold the next number, but a hand-edited file could.
    assert numbered("VP", ["VP001", "VP003", "VP004"]) == "VP005"
    # The highest ever issued counts even when its record is gone.
    assert numbered("VP", ["VP001"], issued=9) == "VP010"
    assert numbered("VP", [], issued=9) == "VP010"
    assert numbered("VP", ["VP012"], issued=9) == "VP013", "the records still win when they are higher"
    assert number_of("VP", "VP007") == 7 and number_of("VP", "vp-4f3a9c21") == 0
    assert highest("VP", ["VP001", "vp-x", "VP018"]) == 18 and highest("VP", []) == 0
    assert random_id("rl").startswith("rl-") and len(random_id("rl")) == 11


def test_a_new_vertiport_carries_on_the_stored_numbering(tmp_path):
    path = tmp_path / "vertiports.json"
    store = VertiportRecords(path)
    assert store.create(definition())["id"] == "VP001"
    assert store.create(definition(name="두 번째"))["id"] == "VP002"
    # Deleting the last one does not free its number for the next: a flight
    # already saved against deck:VP002 must not come to mean somewhere else.
    assert store.delete("VP002") is True
    assert store.create(definition(name="세 번째"))["id"] == "VP003"
    # And that holds across a restart, so the count is on disk with the records.
    assert json.loads(path.read_text(encoding="utf-8"))["id_sequence"] == 3
    reopened = VertiportRecords(path)
    assert reopened.delete("VP003") is True
    assert reopened.create(definition(name="다시 열고 지운 뒤"))["id"] == "VP004"
    # A set imported under its own ids is joined, not renumbered.
    reopened.merge([{"id": "VP050", "name": "가져온 곳", **{k: v for k, v in definition().items() if k != "name"}}])
    assert reopened.create(definition(name="가져온 뒤"))["id"] == "VP051"
    # An imported number is spoken for even once its record goes again.
    assert reopened.delete("VP051") is True and reopened.delete("VP050") is True
    assert reopened.create(definition(name="가져온 것을 지운 뒤"))["id"] == "VP052"
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == 1


def test_waypoints_are_numbered_and_links_keep_the_style_they_have_always_had(tmp_path):
    store = RouteRecords(tmp_path / "routes.json")
    first = store.create_node(validate_node({"name": "진입", "latitude": 37.53, "longitude": 126.93,
                                             "altitude_m": 300, "altitude_reference": "agl"}, []))
    second = store.create_node(validate_node({"name": "순항점", "latitude": 37.54, "longitude": 126.95,
                                              "altitude_m": 600, "altitude_reference": "msl"}, ["진입"]))
    assert [first["id"], second["id"]] == ["WP001", "WP002"]
    # A deleted waypoint's number is not handed out again, here or after a restart.
    assert store.delete_node("WP002") == 0, "no links hung from it"
    third = store.create_node(validate_node({"name": "강하점", "latitude": 37.56, "longitude": 126.97,
                                             "altitude_m": 600, "altitude_reference": "msl"}, ["진입"]))
    assert third["id"] == "WP003"
    assert RouteRecords(tmp_path / "routes.json").create_node(
        validate_node({"name": "네 번째", "latitude": 37.57, "longitude": 126.98,
                       "altitude_m": 600, "altitude_reference": "msl"}, []))["id"] == "WP004"
    # Links are never named by hand and there are hundreds of them, so they keep
    # the random style rather than gaining a numbering nobody reads.
    nodes = {item["id"]: item for item in store.nodes()}
    link = store.create_link(validate_link({"name": "진입 → 강하점", "from": "WP001", "to": "WP003",
                                            "segment": "F", "width_m": 300}, nodes, {}))
    assert link["id"].startswith("rl-")
