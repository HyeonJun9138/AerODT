"""User-managed data source settings: validation, storage, wire and live policy."""
import json

import pytest
from fastapi.testclient import TestClient

from data.settings.source_settings import SourceSettings
from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard.library_settings import (DEFAULTS, GROUPS, LIMITS, SOURCE_GROUPS,
                                                                  LibraryPolicy, describe_library, validate_settings)


def test_uam_comparison_visibility_migrates_without_changing_existing_model_and_persists(tmp_path):
    base = validate_settings({"sources": {"uam_prediction": {"enabled": True, "model": "constant_velocity_v1", "seconds": 30}}})
    assert base["sources"]["uam_prediction"] == {"enabled": True, "model": "constant_velocity_v1", "seconds": 30,
                                                   "short_enabled": True, "mid_enabled": True, "long_enabled": True}
    changed = validate_settings({"sources": {"uam_prediction": {"mid_enabled": False}}}, base=base)
    policy = LibraryPolicy(changed).estimation()
    assert policy["uam_prediction_short_enabled"] is True
    assert policy["uam_prediction_mid_enabled"] is False
    assert policy["uam_prediction_long_enabled"] is True
    store = SourceSettings(tmp_path / "sources.json")
    store.write(changed)
    restored = validate_settings(store.read())
    assert restored["sources"]["uam_prediction"]["mid_enabled"] is False
    assert restored["sources"]["uam_prediction"]["short_enabled"] is True
    assert restored["sources"]["uam_prediction"]["model"] == "constant_velocity_v1"
    for name in ("short_enabled", "mid_enabled", "long_enabled"):
        with pytest.raises(ValueError, match=name):
            validate_settings({"sources": {"uam_prediction": {name: "yes"}}})
    described = next(item for item in describe_library()["sources"] if item["id"] == "uam_prediction")
    assert {field["name"] for field in described["fields"] if field["kind"] == "toggle"} == {
        "enabled", "short_enabled", "mid_enabled", "long_enabled"}


def test_building_distance_migrates_old_settings_without_changing_provider_or_detail(tmp_path):
    old = {"sources": {"buildings": {"enabled": True, "provider": "vworld_3d", "quality": "wide", "opacity": .75}}}
    settings = validate_settings(old)
    # A setting that did not exist when this file was written arrives at its
    # default, and everything the operator did choose is left exactly as it was.
    assert settings["sources"]["buildings"] == {**old["sources"]["buildings"], "distance": "auto",
                                                "tint": "neutral", "brightness": 1.0}
    for distance in ("auto", "near", "city", "metro"):
        settings = validate_settings({"sources": {"buildings": {"distance": distance}}}, base=settings)
        store = SourceSettings(tmp_path / "sources.json")
        store.write(settings)
        assert store.read() == settings
        assert settings["sources"]["buildings"]["provider"] == "vworld_3d"
    with pytest.raises(ValueError, match="buildings.distance"):
        validate_settings({"sources": {"buildings": {"distance": "unlimited"}}})


def test_defaults_describe_every_source_the_operator_can_touch():
    described = describe_library()
    ids = [source["id"] for source in described["sources"]]
    assert ids == ["aircraft", "satellite", "weather", "clouds", "uam", "state_estimation", "trajectory_prediction",
                    "risk_prediction", "uam_prediction", "terrain", "buildings", "imagery"]
    for source in described["sources"]:
        assert source["label"] and isinstance(source["fields"], list)
        for field in source["fields"]:
            assert field["name"] and field["label"] and field["kind"] in ("toggle", "number", "bounds", "choice", "model")
            if field["kind"] == "model":
                # Which model does a job is chosen in the AI library, so the
                # field says which job it is for rather than carrying a list.
                assert field["job"] in ("estimation", "prediction", "uam_prediction", "risk_prediction")
                assert "choices" not in field
            if field["kind"] == "number":
                assert field["min"] < field["max"] and field["unit"]
    aircraft = next(s for s in described["sources"] if s["id"] == "aircraft")
    assert {field["name"] for field in aircraft["fields"]} == {"enabled", "poll_seconds", "retention_seconds", "follow_view", "bounds"}
    assert described["values"] == DEFAULTS
    uam = next(s for s in described["sources"] if s["id"] == "uam")
    assert uam['fields'] == [{'name':'enabled','kind':'toggle','label':'실시간 UAM 센서 수신'}]
    assert described['values']['uam']['enabled'] is True
    assert 'Simulation' in uam['note']


def test_values_are_normalised_and_unknown_keys_are_ignored():
    settings = validate_settings({"sources": {"aircraft": {"poll_seconds": "60", "enabled": False},
                                              "nonsense": {"poll_seconds": 1}}})
    assert settings["sources"]["aircraft"]["poll_seconds"] == 60
    assert settings["sources"]["aircraft"]["enabled"] is False
    assert settings["sources"]["aircraft"]["retention_seconds"] == DEFAULTS["aircraft"]["retention_seconds"]
    assert "nonsense" not in settings["sources"]
    assert settings["schema_version"] == 1
    assert validate_settings({})["sources"] == DEFAULTS


@pytest.mark.parametrize("patch,field", [
    ({"aircraft": {"poll_seconds": 1}}, "aircraft.poll_seconds"),
    ({"aircraft": {"poll_seconds": 100000}}, "aircraft.poll_seconds"),
    ({"aircraft": {"retention_seconds": 5}}, "aircraft.retention_seconds"),
    ({"aircraft": {"bounds": {"lamin": 40, "lamax": 30, "lomin": 126, "lomax": 130}}}, "aircraft.bounds"),
    ({"aircraft": {"bounds": {"lamin": 0, "lamax": 60, "lomin": 0, "lomax": 60}}}, "aircraft.bounds"),
    ({"aircraft": {"bounds": {"lamin": -100, "lamax": 30, "lomin": 126, "lomax": 130}}}, "aircraft.bounds"),
    ({"satellite": {"poll_seconds": 60}}, "satellite.poll_seconds"),
    ({"aircraft": {"enabled": "yes"}}, "aircraft.enabled"),
])
def test_invalid_values_name_their_field(patch, field):
    with pytest.raises(ValueError) as error:
        validate_settings({"sources": patch})
    assert str(error.value).startswith(field + ":")


def test_request_frequency_has_a_floor_that_protects_the_provider_quota():
    assert LIMITS["aircraft"]["poll_seconds"][0] >= 30, "a floor below 30 s would burn the daily quota"
    assert LIMITS["satellite"]["poll_seconds"][0] >= 3600, "CelesTrak asks for hours between requests"
    assert DEFAULTS["aircraft"]["poll_seconds"] == 45 and DEFAULTS["satellite"]["enabled"] is False


def test_settings_survive_a_restart_and_a_corrupt_file_is_not_fatal(tmp_path):
    path = tmp_path / "settings/sources.json"
    store = SourceSettings(path)
    assert store.read()["sources"] == DEFAULTS
    saved = store.write(validate_settings({"sources": {"aircraft": {"poll_seconds": 90}}}))
    assert saved["sources"]["aircraft"]["poll_seconds"] == 90
    assert json.loads(path.read_text(encoding="utf-8"))["sources"]["aircraft"]["poll_seconds"] == 90
    assert SourceSettings(path).read()["sources"]["aircraft"]["poll_seconds"] == 90
    assert not path.with_suffix(".tmp").exists()
    path.write_text("{not json", encoding="utf-8")
    assert SourceSettings(path).read()["sources"] == DEFAULTS


def test_library_api_reports_state_and_applies_changes(tmp_path):
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": 10}, sources=[])
    with TestClient(app) as client:
        described = client.get("/api/library/sources").json()
        assert described["schema_version"] == 1
        assert [source["id"] for source in described["sources"]] == ["aircraft", "satellite", "weather", "clouds", "uam", "state_estimation", "trajectory_prediction",
                    "risk_prediction", "uam_prediction", "terrain", "buildings", "imagery"]
        assert described["values"]["aircraft"]["poll_seconds"] == 45
        states = {state["id"]: state for state in described["state"]}
        assert "aircraft" in states and "status" in states["aircraft"], "each source reports what it is doing now"

        applied = client.put("/api/library/sources", json={"sources": {"aircraft": {"poll_seconds": 120, "enabled": False}}})
        assert applied.status_code == 200
        assert applied.json()["values"]["aircraft"]["poll_seconds"] == 120
        assert client.get("/api/library/sources").json()["values"]["aircraft"]["enabled"] is False

        bad = client.put("/api/library/sources", json={"sources": {"aircraft": {"poll_seconds": 2}}})
        assert bad.status_code == 422 and bad.json()["field"] == "aircraft.poll_seconds"
        assert client.get("/api/library/sources").json()["values"]["aircraft"]["poll_seconds"] == 120, "a rejected change changes nothing"
    saved = json.loads((tmp_path / "settings/sources.json").read_text(encoding="utf-8"))
    assert saved["sources"]["aircraft"]["poll_seconds"] == 120


def test_live_policy_drives_the_collector_without_a_restart(tmp_path):
    from user_application.apps.web_dashboard.library_settings import LibraryPolicy
    policy = LibraryPolicy(validate_settings({}))
    assert policy.enabled("opensky") is True
    assert policy.interval("opensky") == 45
    assert policy.enabled("celestrak") is False, "saved orbits stay in use until the operator asks otherwise"
    assert policy.interval("celestrak") == DEFAULTS["satellite"]["poll_seconds"]
    assert policy.bounds()["lamin"] == DEFAULTS["aircraft"]["bounds"]["lamin"]
    assert policy.retention() == DEFAULTS["aircraft"]["retention_seconds"]
    changed = []
    policy.subscribe(lambda values: changed.append(values))
    policy.apply(validate_settings({"sources": {"aircraft": {"poll_seconds": 300, "enabled": False,
                                                             "bounds": {"lamin": 35, "lamax": 36, "lomin": 127, "lomax": 128}},
                                                "satellite": {"enabled": True}}}))
    assert policy.interval("opensky") == 300 and policy.enabled("opensky") is False
    assert policy.enabled("celestrak") is True
    assert policy.bounds() == {"lamin": 35.0, "lamax": 36.0, "lomin": 127.0, "lomax": 128.0}
    assert len(changed) == 1 and changed[0]["aircraft"]["poll_seconds"] == 300
    assert policy.interval("unknown-source") is None, "a source with no policy runs as its binding says"


def test_every_source_belongs_to_a_declared_group_so_the_panel_can_fold_them():
    described = describe_library()
    groups = {group["id"]: group for group in described["groups"]}
    assert [group["id"] for group in described["groups"]] == [group["id"] for group in GROUPS]
    assert {group["kind"] for group in described["groups"]} == {"sources", "exports", "models"}
    assert all(group["label"] and group["note"] for group in described["groups"]), "each fold says what it holds"
    for source in described["sources"]:
        assert source["group"] in groups, f'{source["id"]} has nowhere to be drawn'
        assert groups[source["group"]]["kind"] == "sources"
    # A source nobody placed still lands somewhere rather than falling off.
    assert set(SOURCE_GROUPS) <= {source["id"] for source in described["sources"]}
    placed = {source["id"]: source["group"] for source in described["sources"]}
    # A live feed is grouped by the twin model it fills, not by the provider it
    # comes from: other traffic under 교통·공역, our own assets under 자산 상태.
    assert placed["aircraft"] == "asset_states"
    assert placed["satellite"] == "asset_states" and placed["uam"] == "asset_states"
    assert placed["weather"] == "environment" and placed["clouds"] == "environment"
    assert placed["terrain"] == "display"
    assert {"exports", "models"} <= set(groups), "the downloads and the model shelf are folds of their own"


def test_the_exports_are_offered_over_the_wire_with_the_name_the_file_will_have(tmp_path):
    with TestClient(create_app({"fixture_mode": True, "workspace_directory": str(tmp_path)})) as client:
        listed = client.get("/api/library/exports")
        assert listed.status_code == 200
        items = {item["id"]: item for item in listed.json()["exports"]}
        assert {"vertiports", "routes", "network"} <= set(items)
        assert items["routes"]["filename"].startswith("aerodt-routes-") and items["routes"]["filename"].endswith(".json")
        # An empty workspace has nothing to give but still says what the file is.
        assert items["vertiports"]["available"] is False and items["vertiports"]["note"]
        download = client.get("/api/library/exports/network")
        assert download.status_code == 200
        assert download.headers["content-disposition"].startswith("attachment;")
        body = download.json()
        assert body["kind"] == "network" and body["counts"] == {"vertiports": 0, "nodes": 0, "links": 0, "fatos": 0}
        assert body["segments"]["segments"], "the rules travel with the data"
        assert client.get("/api/library/exports/nothing").status_code == 404
