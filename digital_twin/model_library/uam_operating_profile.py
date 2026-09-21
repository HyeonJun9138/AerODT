"""Model Library: how fast a UAM is flown, in the numbers a pilot would set.

The speeds a flight was built with used to be constants next to the plan
builder, in metres a second, and they did not match what this project flies to:
a cruise of eighty-seven knots where the operating figures say a hundred and
thirty, a taxi at nearly eight knots, a vertical rate of nearly six hundred feet
a minute.

This is the speeds written out, and only the speeds. The altitudes and the
stage-by-stage procedure that came with the same table are older material and
are deliberately not taken from it: where a flight goes is the route network's
business and the operator draws that. What is set here is how fast each part of
it is flown.

The numbers are kept in knots and feet per minute, because those are what they
mean to whoever sets them, and converted at the edge rather than stored
converted. Vstall is the one value the figures refer to without giving; it is
ours, and it is marked as ours, because the transition speed is a multiple of it.

Nothing here builds a flight. It says how fast, and `flight_plan.py` reads it.
"""
SCHEMA_VERSION = 1

KNOT_MPS = 0.514444
FOOT_M = 0.3048
FPM_MPS = FOOT_M / 60.0

# The speeds, as the operating figures give them. Every one is settable; these
# are where the pilot's screen starts.
DEFAULTS = {
    # Ground. Out to the pad and back in, and they differ.
    "taxi_out_kt": 2.6,
    "taxi_in_kt": 3.0,
    # The lift off the pad, and the descent onto it.
    "vertical_speed_fpm": 500.0,
    "landing_vertical_fpm": 300.0,
    # The corridor.
    "cruise_kt": 130.0,
    # The transition speed is a multiple of the stall speed. The figures name
    # the multiple; the stall speed is the airframe's and therefore ours.
    "stall_kt": 45.0,
    "transition_factor": 1.2,
}
# What each may be, and what it is called on the pilot's screen. The ranges are
# wide enough for a different airframe and narrow enough that a typo is caught
# rather than flown.
FIELDS = (
    {"name": "cruise_kt", "label": "순항 속도", "unit": "kt", "min": 40.0, "max": 250.0, "step": 5.0,
     "note": "회랑을 나는 속도입니다."},
    {"name": "stall_kt", "label": "실속 속도 (Vstall)", "unit": "kt", "min": 20.0, "max": 120.0, "step": 1.0,
     "note": "기체의 값입니다. 천이 속도가 이 값의 배수라 여기부터 바꿉니다."},
    {"name": "transition_factor", "label": "천이 속도 배수", "unit": "×Vstall", "min": 1.0, "max": 2.0, "step": 0.05,
     "note": "이륙 직후와 착륙 직전에 나는 속도입니다."},
    {"name": "vertical_speed_fpm", "label": "수직 상승", "unit": "ft/min", "min": 100.0, "max": 1500.0, "step": 50.0,
     "note": "판을 떠나 올라가는 속도입니다."},
    {"name": "landing_vertical_fpm", "label": "수직 강하", "unit": "ft/min", "min": 50.0, "max": 1000.0, "step": 50.0,
     "note": "판으로 내려앉는 속도입니다. 올라갈 때보다 느립니다."},
    {"name": "taxi_out_kt", "label": "지상 이동 (출발)", "unit": "kt", "min": 0.5, "max": 20.0, "step": 0.1,
     "note": "게이트에서 FATO까지."},
    {"name": "taxi_in_kt", "label": "지상 이동 (도착)", "unit": "kt", "min": 0.5, "max": 20.0, "step": 0.1,
     "note": "FATO에서 게이트까지."},
)
FIELD_NAMES = tuple(field["name"] for field in FIELDS)
BY_NAME = {field["name"]: field for field in FIELDS}
# The one number that is not from the operating figures, so a screen can say so.
OURS = ("stall_kt",)
SOURCE = "UAM 운항 속도 (순항 130 kt · 수직 500 ft/min · 지상 2.6~3 kt · 천이 1.2×Vstall)"
# Deliberately not taken from the same table: where a flight goes. Said out loud
# so nobody looks for it here.
NOT_TAKEN = "고도와 단계별 절차는 옛 자료라 쓰지 않습니다. 경로와 고도는 항로 설계를 따릅니다."


def defaults():
    return dict(DEFAULTS)


def validate(raw, base=None):
    """A profile the pilot set, held to its ranges, or ValueError('field: 이유')."""
    values = dict(base or DEFAULTS)
    if raw is None:
        return values
    if not isinstance(raw, dict):
        raise ValueError("profile: JSON 객체가 필요합니다")
    for name, given in raw.items():
        if name not in BY_NAME:
            raise ValueError(f"{name}: 모르는 항목입니다")
        field = BY_NAME[name]
        try:
            number = float(given)
        except (TypeError, ValueError):
            raise ValueError(f"{name}: 숫자가 필요합니다") from None
        if not field["min"] <= number <= field["max"]:
            raise ValueError(f"{name}: {field['min']:g}~{field['max']:g} {field['unit']} 범위입니다")
        values[name] = number
    # Numbers that are each in range can still describe a flight nobody can fly.
    if transition_speed_kt(values) >= values["cruise_kt"]:
        raise ValueError("cruise_kt: 천이 속도보다 빨라야 합니다")
    return values


def transition_speed_kt(values=None):
    """1.2 × Vstall, or whatever multiple the profile is set to."""
    values = values or DEFAULTS
    return values["stall_kt"] * values["transition_factor"]


def speeds(values=None):
    """The profile as the metres per second a plan is built with."""
    values = values or DEFAULTS
    transition = transition_speed_kt(values) * KNOT_MPS
    cruise = values["cruise_kt"] * KNOT_MPS
    return {
        "taxi_out_mps": values["taxi_out_kt"] * KNOT_MPS,
        "taxi_in_mps": values["taxi_in_kt"] * KNOT_MPS,
        "vertical_mps": values["vertical_speed_fpm"] * FPM_MPS,
        "landing_vertical_mps": values["landing_vertical_fpm"] * FPM_MPS,
        "transition_mps": transition,
        # Climbing out and descending in are flown between the transition speed
        # and the cruise, so those legs are timed at the average of the two
        # rather than at either end of it.
        "climb_mps": (transition + cruise) / 2.0,
        "descent_mps": (transition + cruise) / 2.0,
        "cruise_mps": cruise,
    }


def by_phase(values=None):
    """The speed each part of a flight is flown at, in both units.

    One row per phase of a plan, in the order they are flown, so a screen can
    show what the setting above it actually does.
    """
    flown = speeds(values)
    rows = [
        ("gate_out", "지상 이동 (출발)", flown["taxi_out_mps"]),
        ("takeoff", "수직 이륙", flown["vertical_mps"]),
        ("climb", "상승 · 전환", flown["climb_mps"]),
        ("cruise", "순항", flown["cruise_mps"]),
        ("descent", "강하 · 전환", flown["descent_mps"]),
        ("landing", "수직 착륙", flown["landing_vertical_mps"]),
        ("gate_in", "지상 이동 (도착)", flown["taxi_in_mps"]),
    ]
    return [{"phase": phase, "label": label, "mps": round(speed, 2),
             "knots": round(speed / KNOT_MPS, 1), "fpm": round(speed / FPM_MPS)}
            for phase, label, speed in rows]


def describe(values=None):
    """What the pilot's screen draws: the fields, the values, and what follows."""
    values = dict(values or DEFAULTS)
    return {
        "schema_version": SCHEMA_VERSION,
        "source": SOURCE,
        "not_taken": NOT_TAKEN,
        "fields": [dict(field, value=values[field["name"]], ours=field["name"] in OURS)
                   for field in FIELDS],
        "values": values,
        "phases": by_phase(values),
        "derived": {"transition_kt": round(transition_speed_kt(values), 1),
                    "cruise_mps": round(values["cruise_kt"] * KNOT_MPS, 1),
                    "vertical_mps": round(values["vertical_speed_fpm"] * FPM_MPS, 2)},
        "note": ("여기서 바꾸면 이후에 만드는 비행 계획이 그 속도로 만들어집니다. "
                 "이미 만들어진 계획과 재생 중인 하루는 그대로입니다."),
    }
