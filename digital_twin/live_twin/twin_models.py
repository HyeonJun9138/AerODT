"""The real-time models the twin keeps, and where each one's state comes from.

The twin does not hold "the OpenSky feed" or "the Open-Meteo feed". It holds a
picture of the world in a few parts — what our own assets are doing, what the
mission and its resources are, what the weather is, what else is in the air and
what the airspace allows, and what has happened that somebody must know about —
and each part is filled by whatever can fill it. Today that is mostly public
APIs. Tomorrow an aircraft on the ramp reports its own state over a link, and it
becomes another feed of the same model rather than a new thing to find room for.

That is the whole point of naming the models here rather than naming the
providers. A feed says which model it fills and where it comes from; nothing
downstream has to be told again when the where changes.

`CAPABILITIES` in digital_twin/contracts/live.py already names the parts that
are not built yet. This lists all of them, built or not, so a panel can show an
empty one honestly instead of leaving a hole where a model should be.
"""

# Where a feed's state comes from. The twin treats them alike; an operator does
# not, so each says which it is.
ORIGINS = {
    "external_api": {"id": "external_api", "label": "외부 API",
                     "note": "바깥 제공처에서 받아옵니다."},
    "simulation": {"id": "simulation", "label": "내부 시뮬레이션",
                   "note": "이 작업공간에서 만들어 씁니다."},
    "physical": {"id": "physical", "label": "실기체 연동",
                 "note": "기체나 지상 장비가 직접 보고합니다."},
    "physical_emulation": {"id": "physical_emulation", "label": "Physical 모사 API",
                           "note": "별도 컴퓨터에서 비행 엔진과 센서를 실행해 전송합니다."},
}
DEFAULT_ORIGIN = "external_api"

# The models, in the order the architecture draws them.
#
# Two different things can be missing from a model and they are not the same
# thing. A model can have nothing filling it — no feed reports anything of that
# kind yet. Or it can be filled but not *assessed*: the state arrives, and the
# judgement that turns it into an answer ("is this flyable", "is that a
# conflict") is the extension point contracts.live.CAPABILITIES names and has
# not been built. `capability` is the second; whether any feed fills it is the
# first, and is read from the feeds rather than declared.
TWIN_MODELS = [
    {"id": "asset_states", "label": "자산 상태", "capability": None,
     "note": "추적 중인 대상들의 지금 상태 — 항공기, 위성, UAM. 지금은 공개 API와 내부 "
             "시뮬레이션이 채우고, 실기체 연동이 붙으면 같은 자리에 실기체 보고가 들어옵니다.",
     "waiting": ""},
    {"id": "mission_resources", "label": "임무 · 자원", "capability": "mission_resources",
     "note": "비행 계획과 그것이 쓰는 자원 — 게이트, 충전기, 배터리, 승객.",
     "waiting": "Simulation의 비행 계획을 실시간 자원 상태로 올리는 연동이 아직 없습니다."},
    {"id": "environment", "label": "환경", "capability": "environment",
     "note": "기상과 하늘 상태. 자료는 들어오고 있습니다.",
     "waiting": ""},
    {"id": "traffic_airspace", "label": "교통 · 공역", "capability": "airspace_assessment",
     "note": "공역 구조 — 비행금지·제한·위험구역과 관제권. 지도에 그려지는 자료이며 "
             "설정 → 공역에서 켜고 끕니다.",
     "waiting": ""},
    {"id": "events_alerts", "label": "이벤트 · 경보", "capability": "situation_assessment",
     "note": "사람이 알아야 하는 일 — 이탈, 저전력, 공역 침범, 수집 중단.",
     "waiting": "상황 판단이 아직 없어 경보를 만들지 않습니다. 수집 상태는 각 자료 카드에 그대로 나옵니다."},
]
MODEL_IDS = tuple(model["id"] for model in TWIN_MODELS)
DEFAULT_MODEL = "asset_states"

# Which model each feed fills, and where that feed's state comes from. A feed
# added without an entry here still lands somewhere rather than disappearing.
FEEDS = {
    # Everything whose state is tracked as an object, whoever owns it: our own
    # vehicles and the traffic around them are the same kind of state, and the
    # airspace they fly through is a different kind.
    "uam": {"model": "asset_states", "origin": "physical_emulation"},
    "aircraft": {"model": "asset_states", "origin": "external_api"},
    "satellite": {"model": "asset_states", "origin": "external_api"},
    "airspace": {"model": "traffic_airspace", "origin": "external_api"},
    "weather": {"model": "environment", "origin": "external_api"},
    "clouds": {"model": "environment", "origin": "external_api"},
}


def model_of(feed_id):
    return (FEEDS.get(feed_id) or {}).get("model", DEFAULT_MODEL)


def origin_of(feed_id):
    return (FEEDS.get(feed_id) or {}).get("origin", DEFAULT_ORIGIN)


def describe_origin(feed_id):
    return dict(ORIGINS.get(origin_of(feed_id), ORIGINS[DEFAULT_ORIGIN]))


# What the judgement on top of a model would be called, for the ones that have
# one. A model can be full of state and still have nobody drawing conclusions
# from it, and saying so is more useful than calling the model unbuilt.
ASSESSMENT_LABELS = {
    "mission_resources": "임무·자원 판단",
    "environment": "비행 가능 판단",
    "airspace_assessment": "공역 판단",
    "situation_assessment": "상황 판단",
    "perception_track_fusion": "표적 융합",
}


def describe_models(capabilities=None):
    """Every model, whether or not anything fills it, with two separate answers:
    is state arriving, and is anything being concluded from it.

    Both are worth telling apart. An operator looking at 환경 wants to know that
    the weather is arriving even though nothing yet decides from it, and an
    operator looking at 임무·자원 wants to know that nothing arrives at all."""
    built = dict(capabilities or {})
    described = []
    for model in TWIN_MODELS:
        feeds = sorted(feed for feed, at in FEEDS.items() if at["model"] == model["id"])
        capability = model["capability"]
        assessed = capability is None or bool(built.get(capability, False))
        waiting = model["waiting"]
        if not waiting and not assessed and capability:
            waiting = f"자료는 들어오지만 {ASSESSMENT_LABELS.get(capability, capability)}은 아직 없습니다."
        described.append({**model, "feeds": feeds, "filled": bool(feeds),
                          "assessed": assessed, "waiting": waiting})
    return described
