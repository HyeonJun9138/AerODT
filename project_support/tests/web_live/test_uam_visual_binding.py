"""Live twin에서 UAM이 AirSim AirTaxi 형상을 쓸 수 있는지 확인한다.

시뮬레이터가 쓰는 형상과 지구본이 그리는 형상이 갈라지지 않도록, model package가
선언한 Unreal 메시와 라이브러리에 등재된 GLB가 같은 출처임을 배포 자료 수준에서
묶어 둔다.
"""

import json
from pathlib import Path

from digital_twin.live_twin.model_setup import load_definitions, select_model
from digital_twin.model_library.visual_catalog import read_visual_catalog

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = ROOT / "digital_twin/model_library/visual_assets"
ASSET_ID = "projectairsim_airtaxi"


def _entry():
    catalog = read_visual_catalog(LIBRARY)
    return next(asset for asset in catalog["assets"] if asset["asset_id"] == ASSET_ID)


def test_uam_kind_selects_the_airtaxi_asset():
    definition, asset_id = select_model("uam", load_definitions())
    assert asset_id == ASSET_ID
    # The UAM's state is produced by the native runtime, so this entry must not
    # pretend to own an extrapolation model of its own.
    assert definition["state_source"] == "aerodt_native_runtime"


def test_airtaxi_is_published_to_the_browser():
    entry = _entry()
    assert entry["kind"] == "aircraft"
    assert (LIBRARY / entry["uri"].removeprefix("/visual-assets/")).is_file()
    assert "MIT" in entry["attribution"]
    # The globe scales entities by this value; an unmeasured default would draw
    # a 7 m air taxi at 32 m.
    assert 5.0 < entry["size_m"] < 12.0


def test_airtaxi_metadata_records_measured_geometry():
    meta = json.loads((LIBRARY / "aircraft/civilian" / ASSET_ID / "asset.json").read_text(encoding="utf-8"))
    display = meta["display"]
    assert meta["geometry"]["physical_dimensions_verified"] is True
    # Measured from the export, not declared: Unreal's forward and up axes map
    # onto these glTF axes, and every heading on the map depends on it.
    assert display["forward_axis"] == "+X"
    assert display["up_axis"] == "+Y"
    assert display["axis_mapping"]["unreal_to_gltf"] == {"X": "+X", "Y": "+Z", "Z": "+Y"}
    assert display["part_count"] == 9
    extent = display["extent_m"]
    assert 6.0 < extent["length"] < 7.5
    assert 7.5 < extent["width"] < 9.0
    assert 2.0 < extent["height"] < 3.5


def test_airtaxi_shares_the_simulator_s_source_meshes():
    meta = json.loads((LIBRARY / "aircraft/civilian" / ASSET_ID / "asset.json").read_text(encoding="utf-8"))
    package = ROOT / "digital_twin/model_library/packages/vehicles/air/tiltrotor_uam/aerodt_airtaxi/model.jsonc"
    assert package.as_posix().endswith(meta["source"]["note"].split(" and ")[0].split()[-1])
    assert meta["rights"]["label"] == "MIT"
    assert meta["rights"]["public_export"] is True
    assert (LIBRARY / "aircraft/civilian" / ASSET_ID / "attribution.txt").read_text(
        encoding="utf-8").startswith("Microsoft Corporation / ProjectAirSim")


def test_glb_container_and_validator_passed():
    meta = json.loads((LIBRARY / "aircraft/civilian" / ASSET_ID / "asset.json").read_text(encoding="utf-8"))
    assert meta["validation"]["container"] == "passed"
    assert meta["validation"]["gltf_validator"] == "passed"
    assert meta["validation"]["gltf_errors"] == 0
    assert meta["geometry"]["required_extensions"] == []


def test_dashboard_serves_the_airtaxi_to_the_globe():
    """카탈로그 API와 정적 경로가 실제로 이 모델을 내보내는지 확인한다."""
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app

    app = create_app({"celestrak_enabled": False, "opensky_enabled": False}, sources=[])
    with TestClient(app) as client:
        catalog = client.get("/api/visual-assets")
        assert catalog.status_code == 200
        entry = next(a for a in catalog.json()["assets"] if a["asset_id"] == ASSET_ID)
        model = client.get(entry["uri"])
        assert model.status_code == 200
        meta = json.loads((LIBRARY / "aircraft/civilian" / ASSET_ID / "asset.json").read_text(encoding="utf-8"))
        assert len(model.content) == meta["model"]["bytes"]
        # Attribution has to be reachable by the viewer, not just recorded.
        assert client.get(
            "/visual-assets/aircraft/civilian/%s/attribution.txt" % ASSET_ID).status_code == 200
