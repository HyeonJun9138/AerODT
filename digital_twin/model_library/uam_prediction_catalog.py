"""Model Library: the delivered UAM trajectory networks, and what they need.

Three of them, one per horizon: ten seconds, ninety, four minutes. They were
trained on a UAV following a route under a controller, and that is what they
expect to be fed — not a position history, but the aircraft's attitude, rates,
wind, and what its controller is currently aiming at, plus the route it has left
to fly. Twenty-one values per step of history and thirteen per route segment.

They are not in the repository. Each is fifty-seven megabytes, and the delivery
is a PyTorch pickle; `project_support/tools/import_uam_prediction_models.py`
reads them once and writes safetensors and a manifest into the workspace. This
module reads that, so the dashboard opens no pickle and needs no torch. With no
package installed it answers three models that are not available and says why,
which is the same thing it does when a package is there but incomplete.

The forward implementation and worked examples were subsequently delivered.
Availability now requires a numerical verification proof bound to the weights,
contract, scalers and implementation. Old incomplete packages stay unavailable.
The proof establishes numerical portability, not live UAM prediction accuracy.
"""
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

SCHEMA_VERSION = 1
# Where the imported package lives. It is a workspace package like the terrain
# one: large, delivered, and not something the repository carries.
DEFAULT_PACKAGE = Path("data/workspace/prediction/uam_route_mlp")
PACKAGE_FILE = "package.json"
MANIFEST_FILE = "manifest.json"
WEIGHTS_FILE = "model.safetensors"

# The three horizons, in the order an operator meets them. Kept here so the
# models are listed even when no package has been imported: somebody looking for
# the model they were told about should find it and be told what is missing.
MODELS = (
    {"model_id": "uam_route_mlp_short", "label": "UAM 단기 예측 (10초)", "horizon_s": 10.0,
     "history_s": 9.6, "step_s": 0.4,
     "note": "최근 9.6초의 비행 상태와 남은 경로로 앞 10초를 0.4초 간격으로 예측합니다."},
    {"model_id": "uam_route_mlp_mid", "label": "UAM 중기 예측 (90초)", "horizon_s": 90.0,
     "history_s": 28.8, "step_s": 3.6,
     "note": "최근 28.8초의 비행 상태와 남은 경로로 앞 90초를 3.6초 간격으로 예측합니다."},
    {"model_id": "uam_route_mlp_long", "label": "UAM 장기 예측 (240초)", "horizon_s": 240.0,
     "history_s": 28.8, "step_s": 9.6,
     "note": "최근 28.8초의 비행 상태와 남은 경로로 앞 240초를 9.6초 간격으로 예측합니다."},
)
MODEL_IDS = tuple(model["model_id"] for model in MODELS)
COMPARISON_ID = 'uam_route_mlp_comparison'

# What has to be given per step of history and per route segment. Both orders
# are fixed by the training run and neither may be rearranged.
STATE_COLUMNS = ("t", "x", "y", "z", "roll", "pitch", "yaw", "u", "v", "w", "p", "q", "r",
                 "wind_body_u", "wind_body_v", "wind_body_w",
                 "active_speed_target_mps", "cross_track_error_m",
                 "wp1_rel_x", "wp1_rel_y", "wp1_rel_z")
ROUTE_COLUMNS = ("end_body_forward_m", "end_body_right_m", "end_body_up_m",
                 "direction_body_forward", "direction_body_right", "direction_body_up",
                 "segment_length_m", "path_start_m", "path_end_m",
                 "turn_after_sin", "turn_after_cos", "turn_after_valid", "terminal")
MAX_ROUTE_SEGMENTS = 48
HISTORY_STEPS = 25
FUTURE_STEPS = 25

MISSING_PACKAGE = ("모델 파일이 아직 들어와 있지 않습니다. "
                   "project_support/tools/import_uam_prediction_models.py 로 한 번 옮기면 됩니다.")
MISSING_FORWARD = ("전달된 가중치만으로는 각 부분이 어떤 순서로 이어지는지 정해지지 않습니다. "
                   "출력단 입력 1,280 = 상태 1,024 + 128 + 128인데, 그 두 128이 무엇인지와 "
                   "경로 문맥이 25개 출력에 공통인지 출력마다 다른지가 가중치만으로는 갈리지 않습니다. "
                   "원 프로젝트의 RouteMlpTrajectoryRegressor 구현이나, 확인용 입출력 예제 한 쌍이 "
                   "있으면 바로 돌릴 수 있습니다.")


def package_path(root=None):
    return Path(root) if root else DEFAULT_PACKAGE


def read_manifest(model_id, root=None):
    """One model's manifest from the imported package, or None."""
    path = package_path(root) / model_id / MANIFEST_FILE
    try:
        value=json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value,dict) else None
    except (OSError, ValueError):
        return None


def weights_present(model_id, root=None):
    path = package_path(root) / model_id / WEIGHTS_FILE
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


@lru_cache(maxsize=24)
def _weights_hash(path, size, modified_ns):
    # Descriptor refreshes must not re-read 171 MB every UI poll.
    digest=hashlib.sha256()
    with open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            digest.update(block)
    return digest.hexdigest()


def verified(manifest, model_id, root=None):
    proof=(manifest or {}).get('validation') or {}
    try:
        error=float(proof.get('max_absolute_error_m',float('inf')))
        if not (manifest.get('runtime_contract')=='aerodt.uam_route_mlp.numpy.v1'
                and proof.get('status')=='passed'
                and proof.get('basis')=='original_forward_route_scaler_float64_equivalence_and_fixed_2mm_platform_compatibility'
                and proof.get('compatibility_tolerance_m')==.002
                and math.isfinite(error) and 0<=error<=.002
                and proof.get('route_scaler_tensors_exact') is True
                and proof.get('float64_body_max_absolute_error_m')==0):
            return False
        path=(package_path(root)/model_id/WEIGHTS_FILE).resolve()
        stat=path.stat()
        contract_hash=hashlib.sha256(json.dumps(
            {'contract':manifest['contract'],'scalers':manifest.get('scalers')},sort_keys=True,
            separators=(',',':'),ensure_ascii=False,allow_nan=False).encode('utf-8')).hexdigest()
        implementation=Path(__file__).resolve().parents[2]/'ai_pnp/uam_route_model.py'
        code=implementation.stat()
        return (proof.get('weights_sha256')==_weights_hash(str(path),stat.st_size,stat.st_mtime_ns)
                and proof.get('contract_sha256')==contract_hash
                and proof.get('implementation_sha256')==_weights_hash(str(implementation),code.st_size,code.st_mtime_ns))
    except (OSError,ValueError,TypeError,AttributeError,KeyError):
        return False


def _scores(manifest):
    """What the training run itself measured, so the horizons can be compared."""
    metrics = (manifest or {}).get("metrics") or {}
    for split in ("test", "val"):
        values = metrics.get(split) or {}
        # A split that was never run comes back as zeros; say nothing rather than
        # claiming a perfect model.
        if values.get("ade_xy_m"):
            return {"split": split, "ade_m": round(float(values["ade_xy_m"]), 2),
                    "fde_m": round(float(values.get("fde_xy_m") or 0.0), 2)}
    return None


def describe_model(model, root=None):
    """One model as the library shows it: what it is, what it needs, whether it runs."""
    manifest = read_manifest(model["model_id"], root)
    present = weights_present(model["model_id"], root) and manifest is not None
    contract = (manifest or {}).get("contract") or {}
    ready = bool(present and verified(manifest, model['model_id'], root))
    described = {
        "model_id": model["model_id"],
        "label": model["label"],
        "note": model["note"],
        "horizon_seconds": contract.get("effective_future_seconds", model["horizon_s"]),
        "history_seconds": contract.get("effective_input_seconds", model["history_s"]),
        "step_seconds": contract.get("effective_output_dt", model["step_s"]),
        "history_steps": contract.get("input_steps", HISTORY_STEPS),
        "future_steps": contract.get("future_steps", FUTURE_STEPS),
        "state_columns": list(contract.get("feature_columns") or STATE_COLUMNS),
        "route_columns": list(contract.get("route_feature_columns") or ROUTE_COLUMNS),
        "route_max_segments": contract.get("route_max_segments", MAX_ROUTE_SEGMENTS),
        "requires_route": bool(contract.get("requires_route_context", True)),
        "origin": contract.get("feature_position_reference") or {},
        "installed": present,
        "scores": _scores(manifest),
        "ready": ready,
        "reason": '' if ready else (MISSING_PACKAGE if not present else (
            '원본 입출력 및 현재 가중치 검증이 필요합니다.' if (manifest or {}).get('validation') else MISSING_FORWARD)),
    }
    return described


def describe_models(root=None):
    return [describe_model(model, root) for model in MODELS]


def find_model(model_id, root=None):
    model = next((item for item in MODELS if item["model_id"] == model_id), None)
    return None if model is None else describe_model(model, root)


def installed(root=None):
    """How many of the three are actually in the workspace."""
    return sum(1 for model in MODELS if weights_present(model["model_id"], root))


def requirement_text(model):
    """The one line the picker shows under a model: what it must be given."""
    history = model.get("history_seconds") or 0
    steps = model.get("history_steps") or HISTORY_STEPS
    segments = model.get("route_max_segments") or MAX_ROUTE_SEGMENTS
    return (f"비행 상태 {steps}점({history:g}초) 21개 값과 남은 경로 최대 {segments}구간. "
            "자세·각속도·바람과 제어기 목표까지 필요합니다")
