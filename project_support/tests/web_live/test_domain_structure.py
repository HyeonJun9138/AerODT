import importlib
import json
from pathlib import Path

from user_application.apps.web_dashboard.application import load_config


ROOT = Path(__file__).resolve().parents[3]


def test_live_twin_domains_do_not_import_each_other():
    domains = ROOT / "digital_twin/live_twin/domains"
    for owner in ("aircraft", "satellite", "uam"):
        text = "\n".join(path.read_text(encoding="utf-8") for path in (domains / owner).glob("*.py"))
        for other in {"aircraft", "satellite", "uam"} - {owner}:
            assert f"digital_twin.live_twin.domains.{other}" not in text


def test_historical_python_modules_resolve_to_owned_implementations():
    aliases = {
        "digital_twin.live_twin.model_setup": "digital_twin.live_twin.domains.aircraft.model_setup",
        "digital_twin.live_twin.satellite_visibility": "digital_twin.live_twin.domains.satellite.visibility",
        "digital_twin.live_twin.uam_sensor_fusion": "digital_twin.live_twin.domains.uam.sensor_fusion",
        "digital_twin.live_twin.state_synchronization": "digital_twin.live_twin.composition.state_synchronization",
        "user_application.apps.web_dashboard.physical_input":
            "user_application.apps.web_dashboard.domains.uam.input.physical_input",
        "user_application.apps.web_dashboard.operations_rehearsal":
            "user_application.apps.web_dashboard.domains.uam.operations.operations_rehearsal",
        "ai_pnp.uam_prediction": "ai_pnp.domains.uam.uam_prediction",
        "ai_pnp.risk_prediction": "ai_pnp.domains.uam.risk_prediction",
        "communication.web.manual_routes": "communication.web.domains.uam.manual_routes",
        "communication.web.scenario_routes": "communication.web.domains.uam.scenario_routes",
    }
    for historical, owned in aliases.items():
        assert importlib.import_module(historical) is importlib.import_module(owned)


def test_provider_implementations_are_separate_but_old_exports_remain():
    historical = importlib.import_module("communication.external.live_sources")
    aircraft = importlib.import_module("communication.external.aircraft.opensky_source")
    satellite = importlib.import_module("communication.external.satellite.celestrak_source")
    assert historical.OpenSkySource is aircraft.OpenSkySource
    assert historical.CelesTrakSource is satellite.CelesTrakSource
    assert historical.NotModified is satellite.NotModified


def test_default_settings_merge_disjoint_platform_and_domain_documents():
    directory = ROOT / "user_application/configs/web_dashboard"
    manifest = json.loads((directory / "default.json").read_text(encoding="utf-8"))
    assert manifest["includes"] == ["platform.json", "domains/satellite.json", "domains/uam.json"]
    documents = [json.loads((directory / relative).read_text(encoding="utf-8")) for relative in manifest["includes"]]
    keys = [set(document) for document in documents]
    assert not (keys[0] & keys[1] or keys[0] & keys[2] or keys[1] & keys[2])
    expected = {}
    for document in documents:
        expected.update(document)
    assert load_config() == expected


def test_production_composer_uses_owned_paths_not_compatibility_facades():
    source = (ROOT / "user_application/apps/web_dashboard/application.py").read_text(encoding="utf-8")
    forbidden = (
        "communication.external.live_sources",
        "digital_twin.live_twin.state_synchronization",
        "digital_twin.live_twin.model_setup",
        "user_application.apps.web_dashboard.physical_input",
        "communication.web.manual_routes",
        "communication.web.scenario_routes",
        "ai_pnp.uam_prediction",
        "ai_pnp.risk_prediction",
    )
    assert all(path not in source for path in forbidden)
