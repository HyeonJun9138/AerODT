"""The real-time models the twin keeps, and which panel each feed appears on.

The point of naming models rather than providers is that where a feed's state
comes from can change without anything else moving. These fix that: a feed says
which model it fills and where it comes from, every model the architecture draws
is listed whether or not it is built, and the two panels between them show every
source exactly once.
"""
import pytest

from digital_twin.contracts.live import CAPABILITIES
from digital_twin.live_twin.twin_models import (FEEDS, MODEL_IDS, ORIGINS, TWIN_MODELS, describe_models,
                                                describe_origin, model_of, origin_of)
from user_application.apps.web_dashboard.library_settings import GROUPS, describe_library


def test_every_model_the_architecture_draws_is_named():
    assert MODEL_IDS == ("asset_states", "mission_resources", "environment",
                         "traffic_airspace", "events_alerts")
    for model in TWIN_MODELS:
        assert model["label"] and model["note"], f"{model['id']} says what it is"
        capability = model["capability"]
        assert capability is None or capability in CAPABILITIES, (
            f"{model['id']} waits on a capability the contracts do not name")


def test_state_arriving_and_conclusions_drawn_from_it_are_told_apart():
    described = {model["id"]: model for model in describe_models(CAPABILITIES)}
    assert list(described) == list(MODEL_IDS), "all of them, filled or not"
    # 환경 is filled today and nothing concludes from it yet; both are said.
    assert described["environment"]["filled"] is True
    assert described["environment"]["assessed"] is False
    assert described["environment"]["waiting"], "and it says what is missing"
    # 임무·자원 has nothing arriving at all, which is a different sentence.
    assert described["mission_resources"]["filled"] is False
    assert described["mission_resources"]["waiting"]
    # 자산 상태 needs no judgement on top, so it is complete as it stands.
    assert described["asset_states"]["filled"] is True
    assert described["asset_states"]["assessed"] is True
    assert described["asset_states"]["waiting"] == ""
    # Building the capability is all it takes for the sentence to change.
    turned_on = {m["id"]: m for m in describe_models({**CAPABILITIES, "environment": True})}
    assert turned_on["environment"]["assessed"] is True
    assert turned_on["environment"]["waiting"] == ""


def test_a_feed_says_which_model_it_fills_and_where_its_state_comes_from():
    # Everything whose state is tracked as an object is one model, whoever owns
    # it; the airspace those objects fly through is a different one.
    assert model_of("uam") == "asset_states" and model_of("satellite") == "asset_states"
    assert model_of("aircraft") == "asset_states"
    assert model_of("airspace") == "traffic_airspace"
    assert model_of("weather") == "environment" and model_of("clouds") == "environment"
    # The UAM acquisition source now comes from a separately executing publisher.
    assert origin_of("uam") == "physical_emulation"
    assert origin_of("aircraft") == "external_api"
    assert describe_origin("uam")["label"] == ORIGINS["physical_emulation"]["label"]
    # A feed nobody has placed still lands somewhere rather than disappearing.
    assert model_of("something_new") in MODEL_IDS
    assert origin_of("something_new") in ORIGINS


def test_a_physical_feed_has_somewhere_to_land_before_one_exists():
    # The whole reason for naming models: an aircraft reporting its own state
    # joins the model its simulated stand-in already fills. Nothing about the
    # grouping has to change when it does.
    assert "physical" in ORIGINS and ORIGINS["physical"]["label"]
    assert model_of("uam") == "asset_states", "which is where a real one would report"
    assert all(feed["model"] in MODEL_IDS for feed in FEEDS.values())
    assert all(feed["origin"] in ORIGINS for feed in FEEDS.values())


# ---------------------------------------------------------------- the two panels

def test_the_live_panel_holds_the_twin_models_and_the_library_holds_the_workspace():
    described = describe_library()
    sections = {}
    for group in described["groups"]:
        sections.setdefault(group["section"], []).append(group["id"])
    # The twin models in the order they are drawn, and after them what the twin
    # *does* with them: the estimator and the prediction are not a model the
    # twin holds, they are the work over the models it holds.
    assert sections["live"] == list(MODEL_IDS) + ["ai_models"]
    assert "display" in sections["library"] and "exports" in sections["library"]
    assert "live" not in sections["library"], "the old real-time fold is gone from the Library"


def test_every_source_appears_on_exactly_one_panel():
    described = describe_library()
    section_of = {group["id"]: group["section"] for group in described["groups"]}
    for source in described["sources"]:
        assert source["group"] in section_of, f"{source['id']} has nowhere to be drawn"
    live = [s["id"] for s in described["sources"] if section_of[s["group"]] == "live"]
    library = [s["id"] for s in described["sources"] if section_of[s["group"]] == "library"]
    assert set(live) & set(library) == set(), "no source is on both"
    assert set(live) | set(library) == {s["id"] for s in described["sources"]}
    # The real-time feeds moved; what the workspace holds stayed. The estimator
    # and the prediction are on the live panel too: they are not feeds, they are
    # what the twin does with the feeds, so they have a group of their own and
    # the asset-states group stays the three kinds of tracked object.
    jobs = {"state_estimation", "trajectory_prediction", "uam_prediction", "risk_prediction"}
    assert set(live) == (set(FEEDS) | jobs) & {s["id"] for s in described["sources"]}
    grouped = {source["id"]: source["group"] for source in described["sources"]}
    # Estimation, trajectories and the read-only nearby risk model share one group.
    assert {grouped[job] for job in jobs} == {"ai_models"}
    assert {source for source, group in grouped.items() if group == "asset_states"} == {"aircraft", "satellite", "uam"}
    assert {"terrain", "buildings", "imagery"} <= set(library)


def test_a_live_feed_carries_its_origin_and_a_library_source_does_not():
    described = describe_library()
    by_id = {source["id"]: source for source in described["sources"]}
    assert by_id["aircraft"]["origin"]["label"] == ORIGINS["external_api"]["label"]
    assert by_id["aircraft"]["group"] == "asset_states"
    assert by_id["uam"]["origin"]["label"] == ORIGINS["physical_emulation"]["label"]
    assert "origin" not in by_id["terrain"], "a map setting has no feed origin to report"


def test_a_model_with_no_feed_yet_is_still_a_group_and_says_what_it_waits_on():
    groups = {group["id"]: group for group in describe_library()["groups"]}
    for model_id in ("mission_resources", "events_alerts"):
        group = groups[model_id]
        assert group["always"] is True, "it is drawn even with nothing in it"
        assert group["waiting"], "and says why it is empty"
    assert not any(source["group"] == "mission_resources" for source in describe_library()["sources"])


@pytest.mark.parametrize("group", GROUPS)
def test_every_group_says_which_panel_it_is_on_and_what_it_holds(group):
    assert group["section"] in ("live", "library")
    assert group["kind"] in ("sources", "exports", "models")
    assert group["label"] and group["note"]
