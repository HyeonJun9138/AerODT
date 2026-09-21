"""Several people editing the same server: the address it answers on, and the
one short answer a second screen uses to notice the files moved."""
import json

import pytest
from fastapi.testclient import TestClient

from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard import launcher
from user_application.apps.web_dashboard.launcher import ANY_HOST, build_parser, lan_address, main, prepare_config


def definition(**changes):
    base = dict(name="공유 허브", latitude=37.5, longitude=127.0, heading_deg=0, gates=4,
                fatos=[{"role": "both"}])
    base.update(changes)
    return base


def app_for(tmp_path):
    return create_app({"workspace_directory": str(tmp_path), "celestrak_enabled": False,
                       "opensky_enabled": False, "buildings_enabled": False})


def revision_of(client):
    answer = client.get("/api/simulation/revision")
    assert answer.status_code == 200
    return answer.json()


def test_the_revision_moves_on_every_write_and_holds_still_otherwise(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        first = revision_of(client)
        assert first["schema_version"] == 1
        assert first == dict(first, vertiports=0, nodes=0, links=0), "an empty workspace counts nothing"
        assert revision_of(client)["revision"] == first["revision"], "reading changes nothing"

        created = client.post("/api/simulation/vertiports", json=definition()).json()["vertiport"]
        after_create = revision_of(client)
        assert after_create["revision"] != first["revision"]
        assert after_create["vertiports"] == 1

        edited = client.put(f"/api/simulation/vertiports/{created['id']}", json=definition(gates=6))
        assert edited.status_code == 200
        after_edit = revision_of(client)
        assert after_edit["revision"] != after_create["revision"], "an edit moves it, not just a count"
        assert after_edit["vertiports"] == 1, "though nothing was added"

        node = client.post("/api/simulation/routes/nodes",
                           json={"name": "지점", "latitude": 37.5, "longitude": 127.01}).json()["node"]
        after_node = revision_of(client)
        assert after_node["revision"] != after_edit["revision"] and after_node["nodes"] == 1

        client.delete(f"/api/simulation/routes/nodes/{node['id']}")
        after_delete = revision_of(client)
        assert after_delete["revision"] != after_node["revision"] and after_delete["nodes"] == 0
        client.delete(f"/api/simulation/vertiports/{created['id']}")
        assert revision_of(client)["revision"] == first["revision"], "back to where it started"


def test_two_clients_see_each_other_through_the_revision(tmp_path):
    application = app_for(tmp_path)
    with TestClient(application) as designer, TestClient(application) as router:
        # Both screens note where the data stands.
        start = revision_of(router)["revision"]
        assert revision_of(designer)["revision"] == start
        # One of them saves a vertiport; the other's next look differs, which is
        # all it needs to reload the list it shows.
        designer.post("/api/simulation/vertiports", json=definition(name="여의도"))
        assert revision_of(router)["revision"] != start
        assert [item["name"] for item in router.get("/api/simulation/vertiports").json()["vertiports"]] == ["여의도"]


def test_the_revision_is_short_enough_to_ask_for_often(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        for index in range(5):
            client.post("/api/simulation/vertiports", json=definition(name=f"허브 {index}"))
        answer = client.get("/api/simulation/revision")
        assert len(answer.content) < 200, "a poll is a few dozen bytes, not the whole network"
        assert len(json.loads(answer.content)["revision"]) <= 32


def test_the_launcher_takes_an_address_and_falls_back_to_this_machine(tmp_path, monkeypatch):
    parser = build_parser()
    # The deployment config owns the address; the command line overrides one run
    # and an absent setting still means this machine only.
    assert parser.parse_args([]).host is None, "no command-line address: the config file decides"
    assert parser.parse_args(["--host", "0.0.0.0"]).host == "0.0.0.0"
    assert prepare_config.__defaults__[-1] is None
    monkeypatch.setattr(launcher, "load_config", lambda: {"port": 8766})
    assert launcher.configured_host() == "127.0.0.1"
    assert "0.0.0.0" in ANY_HOST and "::" in ANY_HOST
    # The address to hand to somebody else, when there is a route out at all.
    address = lan_address(8766)
    assert address is None or (address.startswith("http://") and address.endswith(":8766/"))
    assert lan_address(8766, probe="") is None, "no route, no address to offer"


def test_a_bad_port_is_refused_before_anything_binds():
    with pytest.raises(SystemExit):
        main(["--port", "0", "--no-browser"])
