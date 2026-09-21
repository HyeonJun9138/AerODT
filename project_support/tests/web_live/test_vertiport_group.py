"""What network a vertiport belongs to, and picking a whole network at once.

A study used to be nineteen separate choices. Once there is an 울산 site beside
the capital-area decks, "all of 수도권" is the usual request, and ticking
eighteen boxes to make it is the wrong way to ask. Every deck now carries the
group it belongs to, in the operator's own words rather than derived from its
coordinate: Seoul and Incheon are one capital-area network here, and a trial
site is its own however close it sits to a city.
"""
import pytest
from fastapi.testclient import TestClient

from data.simulation.vertiport_records import VertiportRecords
from digital_twin.model_library.vertiport_layout import (DEFAULT_GROUP, GROUP_MAX_LENGTH,
                                                         describe_options, validate_definition)
from user_application.apps.web_dashboard.application import create_app


def definition(**changes):
    base = dict(name="김포 버티허브", latitude=37.558, longitude=126.79, heading_deg=0,
                gates=6, fatos=[{"role": "takeoff"}, {"role": "landing"}])
    base.update(changes)
    return base


def test_a_deck_carries_the_group_it_was_filed_under():
    assert validate_definition(definition(group=" 수도권 "))["group"] == "수도권"
    assert validate_definition(definition(group="울산"))["group"] == "울산"


def test_a_deck_placed_without_one_is_still_placed():
    # Filing is not a precondition for existing; an unfiled deck is a to-do.
    for absent in ({}, {"group": ""}, {"group": "   "}, {"group": None}):
        assert validate_definition(definition(**absent))["group"] == DEFAULT_GROUP


def test_a_group_name_nobody_could_read_is_refused():
    with pytest.raises(ValueError, match="group"):
        validate_definition(definition(group="가" * (GROUP_MAX_LENGTH + 1)))
    assert validate_definition(definition(group="가" * GROUP_MAX_LENGTH))["group"]


def test_the_form_is_told_the_default_and_the_limit():
    options = describe_options()
    assert options["defaults"]["group"] == DEFAULT_GROUP
    assert options["limits"]["group"] == [1, GROUP_MAX_LENGTH]


def test_a_group_survives_being_saved_and_read_back(tmp_path):
    store = VertiportRecords(tmp_path / "vertiports.json")
    saved = store.create(validate_definition(definition(group="수도권")))
    assert store.get(saved["id"])["group"] == "수도권"
    moved = store.update(saved["id"], validate_definition(definition(group="울산")))
    assert moved["group"] == "울산"
    assert VertiportRecords(tmp_path / "vertiports.json").get(saved["id"])["group"] == "울산"


def test_a_deck_saved_before_there_were_groups_reads_as_unfiled(tmp_path):
    store = VertiportRecords(tmp_path / "vertiports.json")
    older = validate_definition(definition())
    older.pop("group")
    saved = store.create(older)
    # Validation fills the defaults on read, which is how the wire answers it.
    assert validate_definition(store.get(saved["id"]))["group"] == DEFAULT_GROUP


def test_the_options_offer_the_groups_already_in_use(tmp_path):
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": 10}, sources=[])
    with TestClient(app) as client:
        assert client.get("/api/simulation/vertiports/options").json()["groups"] == []
        for name, group in (("여의도", "수도권"), ("인천", "수도권"), ("울산 테스트", "울산")):
            made = client.post("/api/simulation/vertiports", json=definition(name=name, group=group))
            assert made.status_code == 201, made.text
        offered = client.get("/api/simulation/vertiports/options").json()["groups"]
        # Each one once, so a form offers 수도권 rather than 수도권 twice.
        assert offered == ["수도권", "울산"]
