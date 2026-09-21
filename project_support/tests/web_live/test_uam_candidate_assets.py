"""UAM 후보 형상(KP-2A, Joby S4)의 반입 상태를 고정한다.

두 모델은 라이선스 파일 없이 들어왔고, 사용자가 각각 자체 소유와 Fab 구매임을
확인해 준 뒤에야 공개로 바뀌었다. 그 근거와 조건이 메타데이터에서 사라지지 않도록,
그리고 지도에 말이 되는 크기로 그려지도록 시험으로 묶어 둔다.
"""

import json
from pathlib import Path

from digital_twin.model_library.visual_catalog import read_visual_catalog

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = ROOT / "digital_twin/model_library/visual_assets"
CANDIDATES = ("kp2a", "joby_s4")
UAM_MODELS = ("projectairsim_airtaxi",) + CANDIDATES


def _asset(asset_id):
    return json.loads((LIBRARY / "aircraft/civilian" / asset_id / "asset.json").read_text(
        encoding="utf-8"))


def test_candidates_are_in_the_local_catalog():
    catalog = json.loads((LIBRARY / "catalog.json").read_text(encoding="utf-8"))
    assert set(CANDIDATES) <= {row["asset_id"] for row in catalog["assets"]}


def test_candidates_pass_the_container_and_renderer_checks():
    for asset_id in CANDIDATES:
        meta = _asset(asset_id)
        assert meta["validation"]["container"] == "passed", asset_id
        assert meta["validation"]["gltf_validator"] == "passed", asset_id
        assert meta["validation"]["gltf_errors"] == 0, asset_id
        assert meta["validation"]["browser"] == "passed", asset_id
        assert meta["geometry"]["required_extensions"] == [], asset_id


def test_every_uam_model_reaches_the_globe():
    published = {a["asset_id"]: a for a in read_visual_catalog(LIBRARY)["assets"]}
    for asset_id in UAM_MODELS:
        assert asset_id in published, asset_id
        assert (LIBRARY / published[asset_id]["uri"].removeprefix("/visual-assets/")).is_file()


def test_each_model_carries_the_terms_it_was_published_under():
    # Publication was a decision per model, not a default; the reason has to stay
    # readable next to the file.
    kp2a = _asset("kp2a")["rights"]
    assert kp2a["public_export"] is True
    assert kp2a["label"] == "operator-owned"
    assert "own asset" in kp2a["note"]

    joby = _asset("joby_s4")["rights"]
    assert joby["public_export"] is True
    assert "Fab" in joby["label"]
    # A purchased licence covers use, not redistribution of the file itself.
    assert "third parties" in joby["note"]
    assert joby["url"]

    for asset_id in CANDIDATES:
        assert (LIBRARY / "aircraft/civilian" / asset_id / "attribution.txt").is_file()


def test_models_are_drawn_at_a_plausible_vehicle_size():
    published = {a["asset_id"]: a for a in read_visual_catalog(LIBRARY)["assets"]}
    for asset_id in UAM_MODELS:
        # A UAM is a handful of metres across. The globe scales entities by this
        # number, so a model left in arbitrary source units draws as a speck.
        assert 5.0 < published[asset_id]["size_m"] < 15.0, asset_id


def test_scale_and_axis_claims_stay_honest():
    for asset_id in CANDIDATES:
        display = _asset(asset_id)["display"]
        assert display["up_axis"] == "+Y", asset_id
        # Nobody has confirmed which way either nose points.
        assert display["forward_axis"].startswith("unverified"), asset_id
        assert display["scale_basis"], asset_id
    # The Joby FBX has no real-world units; the display size is a stated choice.
    joby = _asset("joby_s4")["display"]
    assert joby["reference_extent_m"] == 10.7
    assert "display choice" in joby["scale_basis"]


def test_kp2a_is_exported_from_the_blueprint_the_operator_flies():
    meta = _asset("kp2a")
    note = meta["conversion"]["note"]
    # KP2StaticMesh carries placeholder Automotive Materials and renders blue;
    # the blueprint carries the real livery, white body and tinted canopy.
    assert "blueprint" in note.lower()
    assert "MI_CarPaint_White" in note
    assert "MI_Glass_Windshield_Tinted" in note
    assert meta["geometry"]["materials"] >= 15
    # Internal battery components are most of the source geometry and are never
    # seen from outside, so leaving them out has to stay a recorded decision.
    assert "battery" in note.lower()


def test_kp2a_records_every_repair_made_after_export():
    repairs = _asset("kp2a")["conversion"]["repairs"]
    assert any("emptied" in item for item in repairs)
    # Tangents are repaired rather than dropped: the materials still need a
    # tangent space, so removing the channel would fail validation instead.
    assert any("tangent" in item.lower() for item in repairs)
    assert any("unreferenced" in item for item in repairs)


def test_models_stay_small_enough_to_stream():
    for asset_id in UAM_MODELS:
        meta = _asset(asset_id)
        assert meta["model"]["bytes"] < 10 * 1024 * 1024, asset_id
        # Counted per placed node, so a mesh reused by several parts is counted
        # once per part - which is what a renderer actually draws.
        assert meta["geometry"]["rendered_triangles"] < 300_000, asset_id


def test_the_uam_binding_still_points_at_the_flown_airframe():
    from digital_twin.live_twin.model_setup import load_definitions, select_model
    # Candidates are catalogued, not selected; the simulator's own AirTaxi stays
    # the bound UAM until someone changes it deliberately.
    assert select_model("uam", load_definitions())[1] == "projectairsim_airtaxi"
