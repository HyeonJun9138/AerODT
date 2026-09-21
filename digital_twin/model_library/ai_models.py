"""Every model the twin can be told to think with, in one list.

Two kinds live here and an operator should see them side by side rather than in
two different places. The kinematic ones are arithmetic we wrote — constant
velocity, a coordinated turn — and they run on whatever observations arrive.
The learned ones were trained elsewhere and delivered as weights; they are far
more particular about what they are fed, and one of them cannot run at all
until the normalization from its training run arrives.

Each model says what job it does (estimation, prediction, or both), what it
needs to be given, and whether it can run right now. A model that cannot is
still listed with the reason: an operator looking for the model somebody told
them about should find it and be told why it is not available, rather than not
find it.

The columns follow the AI Model Library in the architecture drawing — function,
application, scope — so the same model reads the same way in both places.
"""
import json
from pathlib import Path

from digital_twin.model_library import uam_prediction_catalog
from digital_twin.model_library.uam_intent_model import MODEL as UAM_INTENT_MODEL
from digital_twin.model_library.prediction_catalog import describe_models as describe_learned

# The kinematic models are declared beside the parameters they share, in this
# layer's own catalogue; reading it here keeps the model library from having to
# ask the Live Twin what models exist.
MOTION_CATALOG = Path(__file__).resolve().parent / "motion_models/catalog.json"


def load_definitions(path=MOTION_CATALOG):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def aircraft_models(definitions):
    return [dict(model) for model in (definitions.get("aircraft_models") or []) if model.get("model_id")]

# What a model can be asked to do. Prediction is two jobs rather than one,
# because an aircraft and a UAM are not the same problem: one is tracked from
# outside with a position every few tens of seconds, the other is flown along a
# route we hold. A network trained on one is not a candidate for the other, so
# they are chosen separately and each is offered only what applies to it.
ESTIMATION = "estimation"
PREDICTION = "prediction"
RISK_PREDICTION = "risk_prediction"
UAM_PREDICTION = "uam_prediction"
# Which kind of object a job is about.
AIRCRAFT, UAM = "aircraft", "uam"
JOB_TARGET = {ESTIMATION: AIRCRAFT, PREDICTION: AIRCRAFT, UAM_PREDICTION: UAM}
APPLICATION_LABEL = {(AIRCRAFT,): "항공기", (UAM,): "UAM", (AIRCRAFT, UAM): "항공기 · UAM"}
JOBS = {
    RISK_PREDICTION: {"id":RISK_PREDICTION,"label":"주변 교통 위험 예측",
        "note":"PRISM 2D 다중 경로와 불확실성을 표시합니다. 경로 확률은 충돌 확률이 아니며 자동 회피를 지시하지 않습니다."},
    ESTIMATION: {"id": ESTIMATION, "label": "상태 추정",
                 "note": "관측과 관측 사이를 메워 지금 어디 있는지를 만듭니다. 트윈의 상태 자체가 됩니다."},
    PREDICTION: {"id": PREDICTION, "label": "항공기 예측정보 생성",
                 "note": "고른 항공기가 앞으로 어디로 갈지 그립니다. 화면에만 있고 트윈 상태에는 들어가지 않습니다."},
    UAM_PREDICTION: {"id": UAM_PREDICTION, "label": "UAM 예측정보 생성",
                     "note": "고른 UAM이 남은 임무 경로를 따라 어디로 갈지 그립니다. 경로를 알고 있으므로 "
                             "관측만 있는 항공기와는 다른 모델을 쓸 수 있습니다."},
}
# The model that follows whatever the estimator is running, so the drawn path
# and the moving aircraft agree unless someone deliberately parts them.
SAME_AS_ESTIMATION = "same_as_estimation"
FOLLOW_ESTIMATION = {
    "model_id": SAME_AS_ESTIMATION, "label": "추정 모델과 동일", "family": "follow",
    "function": "궤적 예측", "application": "항공기", "applies_to": [AIRCRAFT],
    "scope": "추정과 같음",
    "note": "상태 추정이 쓰는 모델을 그대로 씁니다. 화면의 기체와 그려진 경로가 같은 가정을 따릅니다.",
    "requires": "추가 조건 없음", "jobs": [PREDICTION], "ready": True, "reason": "",
}


def _kinematic(model):
    """A model we wrote: it runs on whatever the feed delivers, however sparse.

    Arithmetic does not care what it is moving. The same constant velocity that
    carries an airliner between two observations carries a UAM between two
    ticks, so these are offered for every job.
    """
    return {
        "model_id": model["model_id"],
        "label": model.get("label", model["model_id"]),
        "family": "kinematic",
        "function": "궤적 예측",
        "application": APPLICATION_LABEL[(AIRCRAFT, UAM)],
        "applies_to": [AIRCRAFT, UAM],
        "scope": "실시간",
        "note": model.get("note", ""),
        "requires": "관측 두 개 이상. 간격 제한 없음",
        "jobs": [ESTIMATION, PREDICTION, UAM_PREDICTION],
        "ready": True,
        "reason": "",
    }


def _learned(model):
    """A delivered network: particular about its input, and possibly not runnable."""
    contract = model.get("contract") or {}
    rate = contract.get("rate_hz")
    points = contract.get("input_points")
    seconds = contract.get("input_seconds")
    horizon = contract.get("output_seconds")
    requires = "입력 계약 미상"
    if rate and points and seconds:
        requires = f"{rate:g} Hz로 {points}점({seconds:g}초) 연속 이력"
    return {
        "model_id": model["model_id"],
        "label": model.get("label", model["model_id"]),
        "family": "learned",
        "function": "궤적 예측",
        # Trained on aircraft tracks, so that is what it is offered for. A UAM
        # flying a route we hold is a different problem with its own models.
        "application": APPLICATION_LABEL[(AIRCRAFT,)],
        "applies_to": [AIRCRAFT],
        "scope": f"단기 ({horizon:g}초)" if horizon else "단기",
        "note": model.get("note", ""),
        "requires": requires,
        # A network trained to answer the next N seconds is a predictor. It does
        # not fuse a new observation into a running state, so it is not offered
        # for estimation.
        "jobs": [PREDICTION],
        "ready": bool(model.get("ready")),
        "reason": model.get("reason", ""),
    }


def _uam(model):
    """A delivered route-following network: it needs the mission as well as the state."""
    horizon = model.get("horizon_seconds") or 0
    scores = model.get("scores")
    note = model.get("note", "")
    if scores:
        note = (f"{note} 학습 당시 {scores['split']} 평균 오차 {scores['ade_m']:g} m, "
                f"마지막 점 {scores['fde_m']:g} m.")
    return {
        "model_id": model["model_id"],
        "label": model["label"],
        "family": "learned",
        "function": "궤적 예측",
        "application": APPLICATION_LABEL[(UAM,)],
        "applies_to": [UAM],
        "scope": f"{horizon:g}초" if horizon else "임무 경로",
        "note": note,
        "requires": uam_prediction_catalog.requirement_text(model),
        "jobs": [UAM_PREDICTION],
        "ready": bool(model.get("ready")),
        "reason": model.get("reason", ""),
    }


def describe_ai_models(definitions=None, *, uam_root=None):
    """Every model, kinematic and learned, in the order an operator meets them."""
    definitions = definitions if definitions is not None else load_definitions()
    models = [_kinematic(model) for model in aircraft_models(definitions)]
    models.append(dict(UAM_INTENT_MODEL))
    models.extend(_learned(model) for model in describe_learned())
    delivered = uam_prediction_catalog.describe_models(uam_root)
    models.append({
        'model_id':uam_prediction_catalog.COMPARISON_ID,'label':'UAM 3개 모델 동시 비교',
        'family':'learned','function':'궤적 예측','application':'UAM','applies_to':[UAM],
        'scope':'10 / 90 / 240초','jobs':[UAM_PREDICTION],
        'note':'동일한 현재 상태에서 단기(청록), 중기(주황), 장기(보라) 예측을 함께 비교합니다. 입력 근사와 학습 제어기 차이가 있는 연구용 예측입니다.',
        'requires':'실제 비행 상태 이력 9.6초 / 28.8초와 활성 임무 경로',
        'ready':any(m['ready'] for m in delivered),
        'reason':'' if any(m['ready'] for m in delivered) else '실행할 모델의 원본 구현과 입출력 검증 패키지를 먼저 준비해야 합니다.'})
    models.extend(_uam(model) for model in delivered)
    from digital_twin.model_library.prism_2d.catalog import describe_model
    models.append(describe_model())
    return models


def models_for(job, definitions=None, *, include_follow=True, uam_root=None):
    """The models that can do one job, and that apply to what the job is about.

    A network trained on aircraft tracks is not a candidate for a UAM flying a
    route, and the other way round. Filtering by both keeps a picker from
    offering a model that could only ever refuse.
    """
    target = JOB_TARGET.get(job)
    models = [model for model in describe_ai_models(definitions, uam_root=uam_root)
              if job in model["jobs"] and (target is None or target in model.get("applies_to", []))]
    if job == PREDICTION and include_follow:
        return [dict(FOLLOW_ESTIMATION)] + models
    return models


def find(model_id, definitions=None, *, uam_root=None):
    if model_id == SAME_AS_ESTIMATION:
        return dict(FOLLOW_ESTIMATION)
    return next((model for model in describe_ai_models(definitions, uam_root=uam_root)
                 if model["model_id"] == model_id), None)


def choices_for(job, definitions=None, *, uam_root=None):
    """The ids a setting may hold for that job."""
    return [model["model_id"] for model in models_for(job, definitions, uam_root=uam_root)]


def describe_library(definitions=None, *, uam_root=None):
    """What the model picker draws: the jobs, and every model under them."""
    return {
        "jobs": [dict(JOBS[ESTIMATION]), dict(JOBS[PREDICTION]), dict(JOBS[UAM_PREDICTION]), dict(JOBS[RISK_PREDICTION])],
        "models": describe_ai_models(definitions, uam_root=uam_root),
        "same_as_estimation": SAME_AS_ESTIMATION,
    }
