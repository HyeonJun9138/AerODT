"""What the operator may decide about each data source, and the live policy the
collector reads.

The application, not the collector, owns acquisition policy: which sources run,
how often they are asked, how wide a window is requested and how long a state is
kept. This module is pure - validation, defaults and description - plus a small
policy object the running collector reads on every cycle so a change applies
without a restart. It holds no credentials and performs no requests.

Floors are provider protection, not preference: a request rate below them would
burn the daily quota of a shared public service.
"""
from copy import deepcopy

from digital_twin.contracts.live import CAPABILITIES
from digital_twin.model_library import ai_models
from digital_twin.model_library.uam_intent_model import MODEL_ID as UAM_INTENT_MODEL_ID
from digital_twin.live_twin.twin_models import FEEDS, describe_models, describe_origin

# Which model may be chosen for which job. Static definitions from the model
# library, read once; the picker draws the same list.
ESTIMATION_MODELS = ai_models.models_for(ai_models.ESTIMATION)
PREDICTION_MODELS = ai_models.models_for(ai_models.PREDICTION)
UAM_PREDICTION_MODELS = ai_models.models_for(ai_models.UAM_PREDICTION)
MODEL_CHOICES = {"risk_prediction": ["prism_2d_v1"],"state_estimation": [model["model_id"] for model in ESTIMATION_MODELS],
                 "trajectory_prediction": [model["model_id"] for model in PREDICTION_MODELS],
                 "uam_prediction": [model["model_id"] for model in UAM_PREDICTION_MODELS]}

SCHEMA_VERSION = 1

DEFAULTS = {
    "risk_prediction": {"enabled": True,"model":"prism_2d_v1","radius_m":3000,"altitude_band_m":150,"horizon_s":15},
    "aircraft": {"enabled": True, "poll_seconds": 45, "retention_seconds": 300, "follow_view": True,
                 "bounds": {"lamin": 33.0, "lamax": 38.6, "lomin": 126.0, "lomax": 130.0}},
    # Saved orbits are used until the operator asks for live requests. The
    # catalogue is whole either way; follow_view decides how much of it is
    # propagated and drawn each second.
    "satellite": {"enabled": False, "poll_seconds": 7200, "follow_view": True},
    "weather": {"enabled": True, "poll_seconds": 900},
    # Imagery is not fetched until it is asked for.
    "clouds": {"enabled": False, "product": "himawari_infrared", "opacity": 0.9, "refresh_seconds": 600},
    "uam": {"enabled": True},
    # Two different jobs, kept apart because they are: filling the gap between
    # observations is what the twin's own state is made of, and drawing where
    # something is going next is a picture of one selected object. A model that
    # can do one cannot always do the other.
    "state_estimation": {"enabled": True, "model": "constant_velocity_v1"},
    "trajectory_prediction": {"enabled": True, "model": ai_models.SAME_AS_ESTIMATION, "seconds": 15},
    # A UAM is flown along a route the twin holds, so its prediction starts from
    # arithmetic that needs nothing extra and can be moved to a delivered network
    # once one runs.
    "uam_prediction": {"enabled": True, "model": UAM_INTENT_MODEL_ID, "seconds": 60,
                       "short_enabled": True, "mid_enabled": True, "long_enabled": True},
    "terrain": {"enabled": True, "provider": "world_terrain"},
    "buildings": {"enabled": True, "provider": "osm", "quality": "balanced", "opacity": 0.9, "distance": "auto",
                  "tint": "neutral", "brightness": 1.0},
    # Which imagery draws Korea; the world imagery stays underneath either way.
    "imagery": {"provider": "world_imagery"},
}
LIMITS = {
    "risk_prediction": {"radius_m":(500,10000),"altitude_band_m":(0,3000),"horizon_s":(5,15)},
    "aircraft": {"poll_seconds": (30, 3600), "retention_seconds": (60, 3600), "bounds_span": (0.05, 25.0)},
    "satellite": {"poll_seconds": (3600, 86400)},
    "weather": {"poll_seconds": (300, 86400)},
    "clouds": {"opacity": (0.1, 1.0), "refresh_seconds": (300, 21600)},
    "trajectory_prediction": {"seconds": (5, 120)},
    "uam_prediction": {"seconds": (10, 240)},
    # The old floor was 0.35 because nobody expected less to be wanted. An
    # operator who wants a hint of a city rather than a city is entitled to ask.
    "buildings": {"opacity": (0.1, 1.0), "brightness": (0.35, 1.6)},
}
# The hues the building layers offer. Kept beside the other building choices so
# the wire describes them; the drawing itself is in building_appearance.js, and
# the two lists have to say the same thing.
BUILDING_TINTS = [
    {"id": "neutral", "label": "중립 회색"},
    {"id": "slate", "label": "푸른 회색"},
    {"id": "sand", "label": "모래"},
    {"id": "warm", "label": "따뜻한 석재"},
    {"id": "teal", "label": "청록"},
    {"id": "violet", "label": "보라"},
    {"id": "ink", "label": "짙은 청색"},
]
BUILDING_QUALITIES = [
    {"id": "compact", "label": "가볍게 (96 MB)", "note": "표시 거리는 유지하고 원거리 상세도와 타일 캐시를 줄입니다."},
    {"id": "balanced", "label": "균형 (192 MB)", "note": "가까운 건물은 선명하게, 먼 건물은 낮은 상세도로 표시합니다. 권장 설정입니다."},
    {"id": "wide", "label": "정밀 (256 MB)", "note": "더 선명한 모델과 큰 타일 캐시를 사용합니다. 표시 거리는 따로 선택합니다."},
]
BUILDING_DISTANCES = [
    {"id": "auto", "label": "자동 (높이·시야에 맞춤)", "note": "확대하면 8 km, 축소하면 최대 40 km 반경으로 점진적으로 넓어집니다."},
    {"id": "near", "label": "주변 8 km", "note": "화면이 향하는 지표 주변의 최대 반경입니다."},
    {"id": "city", "label": "도시 20 km", "note": "도시 전체를 낮은 상세도와 거리 안개로 표시합니다."},
    {"id": "metro", "label": "광역 40 km", "note": "넓은 시야용입니다. 먼 곳은 단순화하며 최초 로딩이 길어질 수 있습니다."},
]
CLOUD_PRODUCTS = [
    {"id": "himawari_infrared", "label": "Himawari 적외 (동아시아 · 10분 · 주야)",
     "note": "밤에도 구름이 보입니다. 위성이 보는 반구만 덮습니다."},
    {"id": "himawari_visible", "label": "Himawari 가시 (동아시아 · 10분 · 주간)",
     "note": "낮에는 더 또렷하지만 해가 진 쪽은 보이지 않습니다."},
    {"id": "modis", "label": "MODIS 구름량 (전 지구 · 일별)",
     "note": "극궤도 위성이 하루에 만든 전 지구 합성이라 실시간은 아닙니다."},
]
# Display providers the operator may choose. V-World imagery and footprints
# need the local vworld.json key; the separate public textured tiles do not.
PROVIDERS = {
    "terrain": [
        {"id": "world_terrain", "label": "Cesium World Terrain", "note": "기존 전 세계 지형"},
        {"id": "conditioned_dem", "label": "보정 DEM 사용",
         "note": "공항·수면·완만한 지면의 요철을 사전 보정한 30m급 지형입니다. 범위 밖은 Cesium을 사용하며 물리 지면 판정은 변경하지 않습니다."},
        {"id": "local_dem", "label": "로컬 DEM 우선 + 범위 밖 Cesium",
         "note": "사용자 30m급 DEM. EGM96 높이 기준 가정으로 보정하며 범위 경계는 혼합합니다. 원자료 정확도 개선을 보장하지 않습니다."},
    ],
    "buildings": [
        {"id": "osm", "label": "Cesium OSM Buildings (전 세계)",
         "note": "OpenStreetMap 건물을 3D 타일로 받습니다. Cesium ion 인증이 필요합니다."},
        {"id": "vworld", "label": "브이월드 건물 (국토교통부 · 국내)",
         "note": "건축물 도형과 층수·높이로 세웁니다. 브이월드 키가 필요하며 국내만 덮습니다."},
        {"id": "vworld_3d", "label": "브이월드 정밀 3D (실사 텍스처)",
          "note": "외벽 사진이 있는 정밀 건물과 교량입니다. 사진 해상도와 표시 범위를 제한하며 지역별 구축 범위와 촬영 시점이 다릅니다."},
        {"id": "vworld_hybrid", "label": "브이월드 혼합 (가까이 실사 · 멀리 단순)",
         "note": "가까운 곳은 공개 실사 3D로, 먼 곳과 실사 미구축 지역은 도형·높이 기반 단순 건물로 표시합니다. 단순 건물에는 브이월드 키가 필요합니다."},
    ],
    "imagery": [
        {"id": "world_imagery", "label": "Esri World Imagery (전 세계)",
         "note": "지금까지의 위성 영상입니다."},
        {"id": "vworld_satellite", "label": "브이월드 위성영상 (국내)",
         "note": "국내는 브이월드 항공·위성 영상, 밖은 World Imagery입니다."},
        {"id": "vworld_hybrid", "label": "브이월드 위성 + 지명 (국내)",
         "note": "위성영상 위에 브이월드의 도로·지명을 겹칩니다."},
        {"id": "vworld_base", "label": "브이월드 일반지도 (국내)",
         "note": "도로·지명 중심의 지도입니다."},
        {"id": "vworld_midnight", "label": "브이월드 야간지도 (국내)",
         "note": "어두운 배경의 지도라 항로와 기체가 잘 보입니다."},
    ],
}
# Which collector each source drives. A binding with no policy runs unchanged.
BINDINGS = {"opensky": "aircraft", "celestrak": "satellite", "open_meteo": "weather"}

_BOUND_RANGE = {"lamin": (-90, 90), "lamax": (-90, 90), "lomin": (-180, 180), "lomax": (-180, 180)}


# How the two panels are divided. `section` says which panel a group belongs to:
# Live Twinning holds the real-time picture the twin keeps, one group per model
# the architecture names, and the Library holds what this workspace has — how the
# map is drawn, what was designed here, and what can be taken away as a file.
#
# The live groups are the twin models, not the providers. A feed says which
# model it fills, so an aircraft reporting its own state over a link later lands
# in the same group its simulated stand-in is in now, and nothing else moves.
# `always` keeps a model on screen even with nothing in it yet: an operator
# looking for the mission picture should be told it is not built, not left to
# wonder which panel it is on.
GROUPS = [
    *[{"id": model["id"], "section": "live", "kind": "sources", "always": True,
       "label": model["label"], "note": model["note"], "waiting": model["waiting"],
       "filled": model["filled"], "assessed": model["assessed"]}
      for model in describe_models(CAPABILITIES)],
    # Not a twin model but what the twin does with them: the estimator that
    # fills the gaps between observations, and the prediction drawn for one
    # selected object. Which model does each is chosen from the AI library.
    {"id": "ai_models", "section": "live", "kind": "sources", "always": True,
     "label": "AI 모델 · 추정과 예측",
     "note": "관측 사이를 메우는 상태 추정과, 앞길을 그리는 예측정보 생성. 추정은 트윈의 상태 자체가 되고 "
             "예측은 화면에만 있습니다. 예측은 항공기와 UAM을 따로 고릅니다. 항공기는 관측만으로 앞을 "
             "내다보고, UAM은 남은 임무 경로를 알고 있어 쓸 수 있는 모델이 다릅니다."},
    {"id": "display", "section": "library", "kind": "sources", "label": "지도 표시",
     "note": "지구를 어떻게 그릴지. 수집이 아니라 표시 설정이라 끄면 요청도 멈춥니다."},
    {"id": "simulation", "section": "library", "kind": "sources", "label": "시뮬레이션",
     "note": "이 작업공간에서 직접 만든 것."},
    {"id": "exports", "section": "library", "kind": "exports", "label": "데이터 추출",
     "note": "지금 저장된 설계를 파일로 내려받습니다. 접속한 컴퓨터에 저장됩니다."},
    {"id": "models", "section": "library", "kind": "models", "label": "3D 모델",
     "note": "표시에 쓰는 모델 목록. 훑어보는 용도이며 내려받지 않습니다."},
]
# Which group each source belongs to. A live source is grouped by the twin model
# it fills; a display source by what it draws. Anything unlisted falls to the
# last library group, so a new source is never lost off both panels.
SOURCE_GROUPS = {"terrain": "display", "buildings": "display", "imagery": "display",
                 "state_estimation": "ai_models", "trajectory_prediction": "ai_models",
                 "uam_prediction": "ai_models", "risk_prediction":"ai_models"}
DEFAULT_GROUP = "simulation"


def _model_label(source, values):
    """The label of the model a source is set to, for its card head."""
    chosen = (values.get(source) or {}).get("model", DEFAULTS[source]["model"])
    found = ai_models.find(chosen)
    return found["label"] if found else chosen


def _provider_label(source, values):
    chosen = (values.get(source) or {}).get("provider", DEFAULTS[source]["provider"])
    return next((item["label"] for item in PROVIDERS[source] if item["id"] == chosen), PROVIDERS[source][0]["label"])


def describe_library(values=None):
    """Every source, its fields and the current values, for a form to render."""
    values = deepcopy(values or DEFAULTS)
    aircraft, satellite = LIMITS["aircraft"], LIMITS["satellite"]
    sources = [
        {"id": "aircraft", "label": "항공기", "provider": "OpenSky Network",
         "note": "요청 주기를 짧게 하면 하루 사용량이 빨리 소진됩니다. '지도 화면 따라가기'를 끄면 아래 범위로만 받습니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "수집"},
             {"name": "poll_seconds", "kind": "number", "label": "수신 주기", "unit": "초",
              "min": aircraft["poll_seconds"][0], "max": aircraft["poll_seconds"][1], "step": 5},
             {"name": "retention_seconds", "kind": "number", "label": "상태 보관", "unit": "초",
              "min": aircraft["retention_seconds"][0], "max": aircraft["retention_seconds"][1], "step": 10},
             {"name": "follow_view", "kind": "toggle", "label": "지도 화면 따라가기"},
             {"name": "bounds", "kind": "bounds", "label": "수신 범위",
              "span": {"min": aircraft["bounds_span"][0], "max": aircraft["bounds_span"][1]}},
         ]},
        {"id": "satellite", "label": "위성", "provider": "CelesTrak GP",
         "note": "꺼져 있으면 저장된 궤도 자료로 계산합니다. 켜면 실제 요청을 보냅니다. "
                 "'지도 화면 따라가기'를 켜면 화면에서 보이는 하늘에 뜬 위성만 계산해 보냅니다"
                 "(궤도 자료는 전부 그대로 두고 계산량만 줄입니다). 끄면 전 궤도를 매 초 계산합니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "실시간 요청"},
             {"name": "poll_seconds", "kind": "number", "label": "수신 주기", "unit": "초",
              "min": satellite["poll_seconds"][0], "max": satellite["poll_seconds"][1], "step": 600},
             {"name": "follow_view", "kind": "toggle", "label": "지도 화면 따라가기"},
         ]},
        {"id": "weather", "label": "기상", "provider": "Open-Meteo",
         "note": "인증키 없이 현재 수신 범위의 중심과 네 모서리를 한 번의 요청으로 받습니다. 구름량·시정·바람·기온입니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "수집"},
             {"name": "poll_seconds", "kind": "number", "label": "수신 주기", "unit": "초",
              "min": LIMITS["weather"]["poll_seconds"][0], "max": LIMITS["weather"]["poll_seconds"][1], "step": 60},
         ]},
        {"id": "clouds", "label": "구름 영상", "provider": "NASA EOSDIS GIBS",
         "note": "지도 위에 덮는 위성 영상입니다. 표시 설정이며 켜야 타일을 받습니다. 설정에서도 켜고 끌 수 있습니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "표시"},
             {"name": "product", "kind": "choice", "label": "자료", "choices": [dict(item) for item in CLOUD_PRODUCTS]},
             {"name": "opacity", "kind": "number", "label": "진하기", "unit": "0~1",
              "min": LIMITS["clouds"]["opacity"][0], "max": LIMITS["clouds"]["opacity"][1], "step": 0.05},
             {"name": "refresh_seconds", "kind": "number", "label": "갱신 주기", "unit": "초",
              "min": LIMITS["clouds"]["refresh_seconds"][0], "max": LIMITS["clouds"]["refresh_seconds"][1], "step": 60},
         ]},
        {"id": "uam", "label": "UAM Physical 센서", "provider": "외부 Physical 모사 API",
         "note": "GNSS · AHRS · 기압 고도 · IMU · 기체 상태를 수신합니다. Simulation 재생 중에는 수신을 잠시 멈추고, 종료하면 현재 시각으로 다시 연결합니다.",
         "fields": [{"name": "enabled", "kind": "toggle", "label": "실시간 UAM 센서 수신"}]},
        {"id": "state_estimation", "label": "상태 추정", "provider": _model_label("state_estimation", values),
         "note": "항공기 관측은 25~45초에 한 번 도착합니다. 그 사이를 고른 모델로 메워야 기체가 끊기지 않고 움직이고, "
                 "새 관측은 튀지 않게 흡수됩니다. 끄면 마지막 관측 자리에 그대로 두어 갱신마다 건너뜁니다. "
                 "여기서 고른 모델은 트윈의 상태 자체를 만듭니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "상태 추정"},
             {"name": "model", "kind": "model", "label": "추정 모델", "job": ai_models.ESTIMATION},
         ]},
        {"id": "trajectory_prediction", "label": "항공기 예측정보 생성",
         "provider": _model_label("trajectory_prediction", values),
         "note": "항공기를 클릭했을 때 모델이 보는 앞길을 그립니다. 화면에만 있고 트윈 상태에는 들어가지 않으며, "
                 "계산 결과이지 제출된 비행계획이 아닙니다. 추정과 다른 모델을 고를 수 있고, 고른 모델이 그 대상에 "
                 "쓸 수 없으면 아무것도 그리지 않고 이유를 말합니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "예측정보 표시"},
             {"name": "model", "kind": "model", "label": "예측 모델", "job": ai_models.PREDICTION},
             {"name": "seconds", "kind": "number", "label": "예상 구간", "unit": "초",
              "min": LIMITS["trajectory_prediction"]["seconds"][0],
              "max": LIMITS["trajectory_prediction"]["seconds"][1], "step": 5},
         ]},
        {"id":"risk_prediction","label":"주변 교통 위험 예측","provider":"PRISM 2D",
         "note":"선택 기체의 주변 교통과 15초 다중 경로를 표시합니다. 평면 예측이며 충돌 확률/회피 허가가 아닙니다. 관측 공분산 대체와 시뮬레이션 상태 입력은 연구용으로 구분합니다.",
         "fields":[{"name":"enabled","kind":"toggle","label":"AI 위험 예측 사용"},
                   {"name":"model","kind":"model","label":"위험 예측 모델","job":ai_models.RISK_PREDICTION},
                   {"name":"radius_m","kind":"number","label":"기본 주변 반경","unit":"m","min":500,"max":10000,"step":500},
                   {"name":"altitude_band_m","kind":"number","label":"기본 상대 고도 범위 (0 = 전체)","unit":"± m","min":0,"max":3000,"step":50},
                   {"name":"horizon_s","kind":"number","label":"예측 표시 시간","unit":"초","min":5,"max":15,"step":5}]},
        {"id": "uam_prediction", "label": "UAM 예측정보 생성",
         "provider": _model_label("uam_prediction", values),
         "note": "UAM 비교 모델은 같은 기준 시각에서 단기 10초, 중기 90초, 장기 240초를 각각 계산합니다. "
                 "아래 비교 표시 선택은 계산을 끄지 않고 지도에 보이는 경로만 바꿉니다. "
                 "개별 모델 선택에는 적용되지 않습니다. 학습 모델의 구간은 고정이며 예상 구간 설정은 기존 임무/외삽 모델에만 적용됩니다. "
                 "실제 상태 이력이 부족하면 준비 중인 모델과 필요한 시간을 선택 정보창에 표시합니다.",
         "fields": [
             {"name": "enabled", "kind": "toggle", "label": "예측정보 표시"},
             {"name": "model", "kind": "model", "label": "예측 모델", "job": ai_models.UAM_PREDICTION},
             {"name": "short_enabled", "kind": "toggle", "label": "비교 표시: 단기 10초 (청록 실선)"},
             {"name": "mid_enabled", "kind": "toggle", "label": "비교 표시: 중기 90초 (주황 파선)"},
             {"name": "long_enabled", "kind": "toggle", "label": "비교 표시: 장기 240초 (보라 점선)"},
             {"name": "seconds", "kind": "number", "label": "예상 구간", "unit": "초",
              "min": LIMITS["uam_prediction"]["seconds"][0],
              "max": LIMITS["uam_prediction"]["seconds"][1], "step": 10},
         ]},
        {"id": "terrain", "label": "지형", "provider": _provider_label("terrain", values),
         "note": "로컬 자료가 없는 곳은 Cesium을 유지합니다. 끄면 평면 지표로 표시합니다. "
                 "보정 DEM은 EGM96 높이를 타원체 높이로 변환해 표시합니다. 30m급 시각화 자료이며 물리 지면 판정과 측량 정확도를 보장하지 않습니다.",
         "fields": [{"name": "enabled", "kind": "toggle", "label": "표시"},
                    {"name": "provider", "kind": "choice", "label": "지형 자료", "choices": PROVIDERS["terrain"]}]},
        {"id": "buildings", "label": "건물", "provider": _provider_label("buildings", values),
         "note": "화면이 향하는 지표를 중심으로 표시합니다. 줌아웃해도 유지하며 먼 곳은 단순하고 옅게 처리합니다. "
                  "도시·광역 보기는 OSM 또는 정밀 3D를 사용하세요. 도형을 쌓은 브이월드 건물은 요청량을 제한한 근거리 대안입니다. "
                  "진하기를 낮추면 매끄럽게 비칩니다. 실사 사진은 90% 이상에서 불투명 경로를 사용합니다. "
                  "색조와 밝기는 높이별 음영 위에 곱해집니다. 어느 건물이 높은지는 그대로 두고 도시의 색만 바꿉니다.",
         "fields": [{"name": "enabled", "kind": "toggle", "label": "표시"},
                    {"name": "provider", "kind": "choice", "label": "자료",
                     "choices": [dict(item) for item in PROVIDERS["buildings"]]},
                    {"name": "quality", "kind": "choice", "label": "건물 상세도", "choices": BUILDING_QUALITIES},
                    {"name": "distance", "kind": "choice", "label": "건물 표시 거리", "choices": BUILDING_DISTANCES},
                    {"name": "opacity", "kind": "number", "label": "건물 진하기", "unit": "0~1",
                     "min": LIMITS["buildings"]["opacity"][0], "max": LIMITS["buildings"]["opacity"][1], "step": .05},
                    {"name": "tint", "kind": "choice", "label": "건물 색조", "choices": BUILDING_TINTS},
                    {"name": "brightness", "kind": "number", "label": "건물 밝기", "unit": "0~1",
                     "min": LIMITS["buildings"]["brightness"][0], "max": LIMITS["buildings"]["brightness"][1], "step": .05}]},
        {"id": "imagery", "label": "지도 영상", "provider": _provider_label("imagery", values),
         "note": "지구를 덮는 영상입니다. 브이월드 영상은 국내만 덮고 그 밖은 World Imagery가 보입니다.",
         "fields": [{"name": "provider", "kind": "choice", "label": "자료",
                     "choices": [dict(item) for item in PROVIDERS["imagery"]]}]},
    ]
    for source in sources:
        # A feed the twin has a model for is grouped by that model and says
        # where its state comes from; everything else is a library source.
        if source["id"] in FEEDS:
            source["group"] = FEEDS[source["id"]]["model"]
            source["origin"] = describe_origin(source["id"])
        else:
            source["group"] = SOURCE_GROUPS.get(source["id"], DEFAULT_GROUP)
    return {"schema_version": SCHEMA_VERSION, "groups": [dict(group) for group in GROUPS],
            "sources": sources, "values": values, "limits": deepcopy(LIMITS),
            # The models a `model` field may be set to, so the picker draws the
            # library rather than the panel inventing a list.
            "ai_models": ai_models.describe_library()}


def retry_delay_seconds(interval_seconds, failures, status_code=None, ceiling=21600):
    """How long to wait after a collection failed.

    Never sooner than the source's own interval. Asking a provider that is
    failing more often than one that is answering is backwards, and it is how a
    public service comes to block the address: this machine lost CelesTrak that
    way, after which the collector kept knocking every five minutes because the
    error path shortened the wait to 300 seconds.

    The wait then doubles with each consecutive failure. A provider that has
    refused a dozen times running will not answer the thirteenth request any
    sooner, and CelesTrak's usage policy asks a client to stop and let a person
    look. The ceiling is eight intervals, held between half an hour and six
    hours, so a source polled every minute recovers quickly while one polled
    every two hours backs a long way off. One success resets the count.
    """
    base = max(60.0, float(interval_seconds or 60))
    limit = min(float(ceiling), max(1800.0, base * 8))
    delay = min(base * 2 ** max(0, min(int(failures) - 1, 16)), limit)
    if status_code == 429:
        # The provider has said in so many words that it wants a longer wait.
        delay = max(delay, 600.0)
    return delay


def _number(value, field, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field}: 숫자여야 합니다") from None
    if number != number or not low <= number <= high:
        raise ValueError(f"{field}: {low}~{high} 사이여야 합니다")
    return int(number) if number == int(number) else number


def _toggle(value, field):
    if not isinstance(value, bool):
        raise ValueError(f"{field}: 켜짐 또는 꺼짐이어야 합니다")
    return value


def _choice(value, field, allowed):
    if value not in allowed:
        raise ValueError(f"{field}: {', '.join(allowed)} 중 하나여야 합니다")
    return value


def _bounds(value, field, span):
    if not isinstance(value, dict):
        raise ValueError(f"{field}: 위경도 범위 객체여야 합니다")
    result = {}
    for key, (low, high) in _BOUND_RANGE.items():
        if key not in value:
            raise ValueError(f"{field}: {key} 값이 필요합니다")
        result[key] = float(_number(value[key], field, low, high))
    if result["lamin"] >= result["lamax"] or result["lomin"] >= result["lomax"]:
        raise ValueError(f"{field}: 최소값이 최대값보다 작아야 합니다")
    for low, high in ((result["lamin"], result["lamax"]), (result["lomin"], result["lomax"])):
        if not span[0] <= high - low <= span[1]:
            raise ValueError(f"{field}: 한 변이 {span[0]}~{span[1]}° 사이여야 합니다")
    return result


def validate_settings(raw, base=None):
    """Return normalised settings or raise ValueError('source.field: reason')."""
    if not isinstance(raw, dict):
        raise ValueError("settings: 객체여야 합니다")
    current = deepcopy(base["sources"] if base and "sources" in base else DEFAULTS)
    patch = raw.get("sources") if isinstance(raw.get("sources"), dict) else {}
    values = {}
    for source, defaults in DEFAULTS.items():
        merged = dict(current.get(source, defaults))
        given = patch.get(source) if isinstance(patch.get(source), dict) else {}
        for key, fallback in defaults.items():
            if key not in given:
                merged.setdefault(key, fallback)
                continue
            field = f"{source}.{key}"
            if key in ("enabled", "follow_view", "prediction", "short_enabled", "mid_enabled", "long_enabled"):
                merged[key] = _toggle(given[key], field)
            elif source == "risk_prediction" and key == "horizon_s":
                merged[key] = _number(given[key],field,5,15)
                if merged[key] not in (5,10,15):raise ValueError(f"{field}: 5, 10, 15초 중 선택하세요")
            elif key == "model":
                merged[key] = _choice(given[key], field, MODEL_CHOICES[source])
            elif key == "product":
                merged[key] = _choice(given[key], field, [item["id"] for item in CLOUD_PRODUCTS])
            elif key == "provider":
                merged[key] = _choice(given[key], field, [item["id"] for item in PROVIDERS[source]])
            elif key == "quality":
                merged[key] = _choice(given[key], field, [item["id"] for item in BUILDING_QUALITIES])
            elif key == "tint":
                merged[key] = _choice(given[key], field, [item["id"] for item in BUILDING_TINTS])
            elif key == "distance":
                merged[key] = _choice(given[key], field, [item["id"] for item in BUILDING_DISTANCES])
            elif key == "bounds":
                merged[key] = _bounds(given[key], field, LIMITS[source]["bounds_span"])
            else:
                merged[key] = _number(given[key], field, *LIMITS[source][key])
        values[source] = {key: merged[key] for key in defaults}
    return {"schema_version": SCHEMA_VERSION, "sources": values}


class LibraryPolicy:
    """The live view the collector reads: enabled, interval, window, retention.

    Sources not named here are not governed, so an unrelated binding keeps the
    interval it was created with.
    """

    def __init__(self, settings=None):
        self._values = deepcopy((settings or validate_settings({}))["sources"])
        self._listeners = []

    @property
    def values(self):
        return deepcopy(self._values)

    def apply(self, settings):
        self._values = deepcopy(settings["sources"])
        for listener in list(self._listeners):
            listener(self.values)

    def subscribe(self, listener):
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def _for(self, binding):
        return self._values.get(BINDINGS.get(binding, ""), None)

    def enabled(self, binding):
        policy = self._for(binding)
        return True if policy is None else bool(policy.get("enabled", True))

    def interval(self, binding):
        policy = self._for(binding)
        return None if policy is None else policy.get("poll_seconds")

    def bounds(self):
        return dict(self._values["aircraft"]["bounds"])

    def follow_view(self, source="aircraft"):
        return bool(self._values[source].get("follow_view", True))

    def retention(self):
        return self._values["aircraft"]["retention_seconds"]

    def estimation(self):
        """What the estimator and the prediction should do, read each tick.

        One value for the twin because the estimator and the drawing share a
        tick; two settings for the operator because they are different jobs.
        """
        estimation = self._values["state_estimation"]
        prediction = self._values["trajectory_prediction"]
        uam = self._values["uam_prediction"]
        return {"enabled": bool(estimation["enabled"]), "model": estimation["model"],
                "prediction": bool(prediction["enabled"]),
                "prediction_seconds": prediction["seconds"],
                "prediction_model": prediction["model"],
                "uam_prediction": bool(uam["enabled"]),
                "uam_prediction_seconds": uam["seconds"],
                "uam_prediction_model": uam["model"],
                "uam_prediction_short_enabled": bool(uam.get("short_enabled", True)),
                "uam_prediction_mid_enabled": bool(uam.get("mid_enabled", True)),
                "uam_prediction_long_enabled": bool(uam.get("long_enabled", True))}
