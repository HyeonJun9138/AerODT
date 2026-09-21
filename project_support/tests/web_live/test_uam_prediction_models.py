"""The delivered UAM trajectory networks, and the third prediction job.

Predicting where an aircraft goes and predicting where a UAM goes are not the
same problem. One is tracked from outside with a position every few tens of
seconds; the other is being flown by the twin along a route the twin holds. So
they are chosen separately, and each is offered only the models that apply to
it. These tests fix that separation, and fix what is said about three networks
that are installed but cannot yet be run.
"""
import json

import pytest

from digital_twin.model_library import ai_models
from digital_twin.model_library import uam_prediction_catalog as uam


def package(tmp_path, models=uam.MODEL_IDS, weights=True, contract=None):
    """A package directory shaped like the importer writes one."""
    for model_id in models:
        folder = tmp_path / model_id
        folder.mkdir(parents=True, exist_ok=True)
        if weights:
            (folder / uam.WEIGHTS_FILE).write_bytes(b"not really tensors, but present")
        (folder / uam.MANIFEST_FILE).write_text(json.dumps({
            "schema_version": 1, "model_id": model_id,
            "contract": contract or {"effective_future_seconds": 10.0, "effective_input_seconds": 9.6,
                                     "input_steps": 25, "future_steps": 25, "route_max_segments": 48,
                                     "requires_route_context": True},
            "metrics": {"val": {"ade_xy_m": 3.47, "fde_xy_m": 5.93},
                        "test": {"ade_xy_m": 3.14, "fde_xy_m": 5.23}},
        }, ensure_ascii=False), encoding="utf-8")
    return tmp_path


def test_the_three_horizons_are_listed_even_when_nothing_is_installed(tmp_path):
    """Somebody looking for the model they were told about should find it and be
    told what is missing, rather than not find it."""
    described = uam.describe_models(tmp_path)
    assert [model["model_id"] for model in described] == list(uam.MODEL_IDS)
    assert [model["horizon_seconds"] for model in described] == [10.0, 90.0, 240.0]
    for model in described:
        assert model["installed"] is False and model["ready"] is False
        assert "import_uam_prediction_models" in model["reason"], "and how to install it"
    assert uam.installed(tmp_path) == 0


def test_an_installed_model_says_what_it_needs_and_why_it_still_cannot_run(tmp_path):
    """The weights arrived; how the pieces compose did not. Two readings of the
    same tensors give different answers, so it says so instead of guessing."""
    described = uam.describe_models(package(tmp_path))
    assert uam.installed(tmp_path) == 3
    short = described[0]
    assert short["installed"] is True
    assert short["ready"] is False
    assert "1,280" in short["reason"], "the gap is named, not hand-waved"
    assert "RouteMlpTrajectoryRegressor" in short["reason"], "and so is what would close it"
    # What it must be given, in the operator's words.
    requirement = uam.requirement_text(short)
    assert "25점" in requirement and "9.6초" in requirement and "48구간" in requirement
    assert "제어기 목표" in requirement, "the part a position history cannot supply"


def test_the_input_contract_is_carried_through_exactly():
    """Twenty-one values per step and thirteen per segment, in a fixed order.
    Rearranging either makes the answer meaningless, so the order is pinned."""
    assert len(uam.STATE_COLUMNS) == 21
    assert uam.STATE_COLUMNS[:4] == ("t", "x", "y", "z")
    assert uam.STATE_COLUMNS[-5:] == ("active_speed_target_mps", "cross_track_error_m",
                                      "wp1_rel_x", "wp1_rel_y", "wp1_rel_z")
    assert len(uam.ROUTE_COLUMNS) == 13
    assert uam.ROUTE_COLUMNS[0] == "end_body_forward_m" and uam.ROUTE_COLUMNS[-1] == "terminal"
    assert uam.MAX_ROUTE_SEGMENTS == 48 and uam.HISTORY_STEPS == uam.FUTURE_STEPS == 25


def test_a_split_that_was_never_run_is_not_reported_as_a_perfect_model(tmp_path):
    folder = package(tmp_path)
    (folder / uam.MODEL_IDS[0] / uam.MANIFEST_FILE).write_text(json.dumps({
        "schema_version": 1, "contract": {},
        "metrics": {"test": {"ade_xy_m": 0.0, "fde_xy_m": 0.0}, "val": {"ade_xy_m": 46.9, "fde_xy_m": 61.8}},
    }, ensure_ascii=False), encoding="utf-8")
    scores = uam.describe_model(uam.MODELS[0], folder)["scores"]
    assert scores["split"] == "val" and scores["ade_m"] == 46.9, "zero is a split nobody ran"
    # No metrics at all is no claim at all.
    (folder / uam.MODEL_IDS[0] / uam.MANIFEST_FILE).write_text('{"contract":{}}', encoding="utf-8")
    assert uam.describe_model(uam.MODELS[0], folder)["scores"] is None


def test_a_damaged_package_is_not_available_rather_than_an_error(tmp_path):
    folder = package(tmp_path)
    (folder / uam.MODEL_IDS[0] / uam.MANIFEST_FILE).write_text("{ not json", encoding="utf-8")
    described = uam.describe_model(uam.MODELS[0], folder)
    assert described["installed"] is False and described["ready"] is False
    assert uam.find_model("nothing_like_this", folder) is None
    assert uam.find_model(uam.MODEL_IDS[1], folder)["label"] == uam.MODELS[1]["label"]


# ---- the third job ---------------------------------------------------------
def test_prediction_is_two_jobs_and_each_is_offered_only_what_applies():
    """A network trained on aircraft tracks is not a candidate for a UAM flying
    a route, and the other way round. Offering either would be offering a model
    that could only ever refuse."""
    aircraft = ai_models.models_for(ai_models.PREDICTION)
    uam_models = ai_models.models_for(ai_models.UAM_PREDICTION)
    aircraft_ids = {model["model_id"] for model in aircraft}
    uam_ids = {model["model_id"] for model in uam_models}
    assert "gru_direct_v1_1" in aircraft_ids and "gru_direct_v1_1" not in uam_ids
    assert set(uam.MODEL_IDS) <= uam_ids
    assert not set(uam.MODEL_IDS) & aircraft_ids
    # The arithmetic we wrote does not care what it is moving, so it is on both.
    assert {"constant_velocity_v1", "coordinated_turn_v1"} <= aircraft_ids & uam_ids
    # Only the aircraft prediction can follow the estimator: a UAM's estimator
    # is the same one, but its prediction is a different question.
    assert ai_models.SAME_AS_ESTIMATION in aircraft_ids
    assert ai_models.SAME_AS_ESTIMATION not in uam_ids


def test_every_model_says_which_kind_of_object_it_applies_to():
    for model in ai_models.describe_ai_models():
        assert model["applies_to"], model["model_id"]
        assert set(model["applies_to"]) <= {ai_models.AIRCRAFT, ai_models.UAM}
        # The label an operator reads matches the machine-readable list.
        assert model["application"] == ai_models.APPLICATION_LABEL[tuple(model["applies_to"])]
    assert ai_models.JOB_TARGET[ai_models.UAM_PREDICTION] == ai_models.UAM
    assert ai_models.JOB_TARGET[ai_models.PREDICTION] == ai_models.AIRCRAFT


def test_prediction_jobs_include_the_separate_risk_category():
    library = ai_models.describe_library()
    labels = {job["id"]: job["label"] for job in library["jobs"]}
    assert labels == {"estimation": "상태 추정",
                      "prediction": "항공기 예측정보 생성",
                      "uam_prediction": "UAM 예측정보 생성", "risk_prediction":"주변 교통 위험 예측"}
    # Every model in the library is under at least one of those jobs.
    known = set(labels)
    for model in library["models"]:
        assert set(model["jobs"]) <= known, model["model_id"]


def test_a_uam_model_carries_its_horizon_and_what_it_scored():
    models = {model["model_id"]: model for model in ai_models.models_for(ai_models.UAM_PREDICTION)}
    short = models["uam_route_mlp_short"]
    assert short["family"] == "learned" and short["application"] == "UAM"
    assert short["scope"] == "10초"
    assert models["uam_route_mlp_long"]["scope"] == "240초"
    installed = uam.find_model('uam_route_mlp_short')
    assert short["ready"] == installed['ready']
    assert "제어기 목표" in short["requires"]


def test_comparison_allows_partial_models_but_requires_fixed_tolerance_validation(tmp_path):
    import hashlib
    root=package(tmp_path)
    comparison=lambda:ai_models.find('uam_route_mlp_comparison',uam_root=root)
    assert comparison() is not None and comparison()['ready'] is False
    for mid in uam.MODEL_IDS:
        path=root/mid/uam.MANIFEST_FILE
        manifest=json.loads(path.read_text(encoding='utf-8'))
        manifest.update(runtime_contract='aerodt.uam_route_mlp.numpy.v1', validation={
            'status':'passed','basis':'original_forward_route_scaler_float64_equivalence_and_fixed_2mm_platform_compatibility',
            'compatibility_tolerance_m':.002,'max_absolute_error_m':.0011,
            'route_scaler_tensors_exact':True,'float64_body_max_absolute_error_m':0,
            'weights_sha256':hashlib.sha256((root/mid/uam.WEIGHTS_FILE).read_bytes()).hexdigest()})
        manifest['validation']['contract_sha256']=hashlib.sha256(json.dumps(
            {'contract':manifest['contract'],'scalers':manifest.get('scalers')},sort_keys=True,
            separators=(',',':'),ensure_ascii=False,allow_nan=False).encode('utf-8')).hexdigest()
        from pathlib import Path
        implementation=Path(uam.__file__).resolve().parents[2]/'ai_pnp/uam_route_model.py'
        manifest['validation']['implementation_sha256']=hashlib.sha256(implementation.read_bytes()).hexdigest()
        path.write_text(json.dumps(manifest),encoding='utf-8')
    assert comparison()['ready'] is True
    path=root/uam.MODEL_IDS[0]/uam.MANIFEST_FILE
    manifest=json.loads(path.read_text(encoding='utf-8'))
    del manifest['contract']
    assert uam.verified(manifest,uam.MODEL_IDS[0],root) is False
    path=root/uam.MODEL_IDS[0]/uam.MANIFEST_FILE
    manifest=json.loads(path.read_text(encoding='utf-8'))
    original=path.read_text(encoding='utf-8')
    manifest['contract']['effective_future_seconds']=20
    path.write_text(json.dumps(manifest),encoding='utf-8')
    assert uam.find_model(uam.MODEL_IDS[0],root)['ready'] is False,'contract mutation invalidates existing proof'
    assert comparison()['ready'] is True,'other verified models can still be compared'
    path.write_text(original,encoding='utf-8')
    (root/uam.MODEL_IDS[1]/uam.WEIGHTS_FILE).write_bytes(b'changed')
    assert uam.find_model(uam.MODEL_IDS[1],root)['ready'] is False,'verification belongs to these exact weights'
    assert comparison()['ready'] is True
