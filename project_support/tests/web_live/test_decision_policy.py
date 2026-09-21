from digital_twin.simulation import decision_policy
from data.settings.decision_settings import DecisionSettings
from communication.web.decision_routes import create_decision_router
from fastapi import FastAPI
from fastapi.testclient import TestClient


def client(tmp_path):
    app = FastAPI()
    store = DecisionSettings(tmp_path / "decisions.json")
    app.include_router(create_decision_router(store, on_change=lambda: "다음 재생"))
    return TestClient(app), store


def test_charts_and_values_arrive_together(tmp_path):
    api, _ = client(tmp_path)
    body = api.get("/api/decisions").json()
    assert [c["id"] for c in body["charts"]] == ["psu", "pilot", "airline", "vertiport"]
    assert body["values"]["psu"]["fato_landing_separation_s"] == 90.0
    assert body["applies_to"] == "다음 재생"


def test_a_saved_value_survives_and_out_of_range_is_clamped_not_refused(tmp_path):
    api, store = client(tmp_path)
    saved = api.put("/api/decisions", json={"values": {"psu": {
        "fato_landing_separation_s": 45, "arrival_request_lead_s": 99999}}}).json()
    assert saved["values"]["psu"]["fato_landing_separation_s"] == 45
    assert saved["values"]["psu"]["arrival_request_lead_s"] == 1800.0
    assert store.read()["psu"]["fato_landing_separation_s"] == 45
    assert api.get("/api/decisions").json()["values"]["psu"]["fato_landing_separation_s"] == 45


def test_a_shared_value_is_kept_once(tmp_path):
    api, _ = client(tmp_path)
    body = api.put("/api/decisions", json={"values": {
        "psu": {"release_pad_at_touchdown": False},
        "vertiport": {"release_pad_at_touchdown": True}}}).json()
    assert body["values"]["vertiport"]["release_pad_at_touchdown"] is False


def test_reset_removes_the_file_so_a_later_default_reaches_it(tmp_path):
    api, store = client(tmp_path)
    api.put("/api/decisions", json={"values": {"psu": {"minimum_hold_s": 60}}})
    assert store.read()
    body = api.post("/api/decisions/reset").json()
    assert body["values"]["psu"]["minimum_hold_s"] == 20.0
    assert store.read() == {}


def test_a_damaged_file_is_nothing_saved_rather_than_a_dead_server(tmp_path):
    (tmp_path / "decisions.json").write_text("{not json", encoding="utf-8")
    api, _ = client(tmp_path)
    assert api.get("/api/decisions").json()["values"]["psu"]["minimum_hold_s"] == 20.0


def test_the_engine_reads_what_was_saved(tmp_path):
    values = decision_policy.validate({"psu": {"fato_landing_separation_s": 45,
                                               "reassign_stand": False}})
    from digital_twin.simulation import psu_sequencing
    tuning = psu_sequencing.Tuning(**values["psu"])
    assert tuning.landing_separation_s == 45
    assert tuning.reassign_stand is False
    pad = psu_sequencing.PadTimeline("x", tuning)
    pad.hold(0, 45, "F1", psu_sequencing.ARRIVAL)
    assert pad.earliest(0, psu_sequencing.ARRIVAL, 45) == 45


def test_the_browser_fixture_is_still_the_charts_the_engine_describes():
    # The drawing is checked in Node against a copy of these charts. A copy kept
    # by hand agrees for a week and then quietly stops; this fails loudly.
    from project_support.tools.web_visualization.export_decision_charts import FIXTURE, content
    assert FIXTURE.read_text(encoding="utf-8") == content(), (
        "decision_charts.json is stale - run project_support/tools/web_visualization/"
        "export_decision_charts.py")


def test_every_branch_and_parameter_points_somewhere_real():
    for chart in decision_policy.CHARTS:
        nodes = {node["id"] for node in chart["nodes"]}
        assert chart["entry"] in nodes
        for node in chart["nodes"]:
            for key in ("next", "yes", "no"):
                assert node.get(key) in nodes or key not in node, (chart["id"], node["id"], key)
        for parameter in chart["parameters"]:
            assert parameter["node"] in nodes, (chart["id"], parameter["id"])
            # A shared value has to be kept somewhere, and that somewhere has to
            # be a chart that actually declares it.
            if parameter.get("source"):
                owner = next(c for c in decision_policy.CHARTS if c["id"] == parameter["source"])
                assert any(p["id"] == parameter["id"] and not p.get("source")
                           for p in owner["parameters"]), (chart["id"], parameter["id"])


def test_each_chart_names_the_role_that_opens_it():
    roles = {chart["role"] for chart in decision_policy.CHARTS}
    assert roles == {"psu", "pilot", "operator", "vertiport"}


def test_approach_horizontal_speed_and_descent_rate_are_saved_independently(tmp_path):
    api, _ = client(tmp_path)
    before = api.get('/api/decisions').json()['values']['pilot']
    assert before.get('approach_horizontal_speed_mps') == 10.0
    assert before['descent_rate_mps'] == 2.54  # 500 ft/min, not a horizontal speed.
    saved = api.put('/api/decisions', json={'values': {'pilot': {
        **before, 'approach_horizontal_speed_mps': 12.0}}}).json()['values']['pilot']
    assert saved['approach_horizontal_speed_mps'] == 12.0
    assert saved['descent_rate_mps'] == 2.54
    assert saved['landing_rate_mps'] == before['landing_rate_mps']
