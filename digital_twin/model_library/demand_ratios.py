"""Model Library: how much of a day's demand belongs to each vertiport.

A day's total trips have to be shared out between the decks before anything can
be scheduled: 강남 carries more than 미아, and departures are not the same shape
as arrivals. Whoever builds the schedule needs those two shares per deck —
`p_i^dep` and `p_j^arr` — and this is where they come from.

The numbers below were handed over as two files of Seoul travel-demand shares
(departure and arrival), one row per district. They are shares of *all* Seoul
demand, so the seventeen rows sum to 0.803 rather than to 1: the rest belongs to
places no vertiport was placed at. That is why nothing here treats them as
probabilities — they are weights, and the shares are worked out from whichever
decks are actually in scope.

The operator does not read 0.047. Read as a share of all Seoul demand, four
decimal places is a number nobody can hold two of in their head, and it means
nothing without the total. So the panel shows each deck as a **weight against
the average deck**: 100% is an average one, 강남 is 210%, 용산 is 50%. Ten per
cent steps, because the third significant figure of a demand forecast is not
something anybody should be adjusting.

Nothing here builds a schedule. It answers what the shares are, and the request
carries them to whoever does.
"""
import math

SCHEMA_VERSION = 1

# The two files, by the name each row was given. The vertiports were placed
# under the shorter name of the same district, so a row is matched to a deck by
# that name rather than by an id that neither file knows.
SOURCE = "서울시 통행 수요 기반 출발·도착 비율 (외부 제공, 2026-09-10 수신)"
DEPARTURE_SHARES = {
    "영등포·여의도": 0.047, "잠실": 0.055, "상암·수색": 0.026, "용산": 0.025,
    "목동": 0.074, "미아": 0.028, "봉천": 0.038, "사당·이수": 0.041,
    "성수": 0.050, "연신내·불광": 0.030, "천호·길동": 0.063, "광화문": 0.055,
    "강남": 0.098, "가산·대림": 0.046, "마곡": 0.048, "망우": 0.031, "수서·문정": 0.048,
}
ARRIVAL_SHARES = {
    "영등포·여의도": 0.045, "잠실": 0.049, "상암·수색": 0.028, "용산": 0.023,
    "목동": 0.074, "미아": 0.032, "봉천": 0.036, "사당·이수": 0.040,
    "성수": 0.061, "연신내·불광": 0.032, "천호·길동": 0.069, "광화문": 0.048,
    "강남": 0.075, "가산·대림": 0.047, "마곡": 0.057, "망우": 0.040, "수서·문정": 0.047,
}
# Which deck each row belongs to. The files name a district, the map names the
# place inside it where the deck stands.
PLACE_NAMES = {
    "영등포·여의도": "여의도", "잠실": "잠실", "상암·수색": "상암", "용산": "용산",
    "목동": "목동", "미아": "미아", "봉천": "봉천", "사당·이수": "사당",
    "성수": "성수", "연신내·불광": "연신내", "천호·길동": "천호", "광화문": "광화문",
    "강남": "강남", "가산·대림": "가산", "마곡": "마곡", "망우": "망우", "수서·문정": "수서",
}

# What the operator adjusts. 100 is an average deck; 0 means the deck neither
# sends nor receives. The ceiling is well above anything in the reference so a
# hub can be tried without the control running out.
DEFAULT_WEIGHT = 100
WEIGHT_STEP = 10
WEIGHT_MIN = 0
WEIGHT_MAX = 300
DIRECTIONS = ("departure", "arrival")


def _to_step(percent):
    """To the nearest step, halves upward.

    Python's own round() would send 125 to 120 and 135 to 140, which is correct
    arithmetic and indefensible on a spinner: the operator types a number and
    watches it go the wrong way for no reason they can see. The browser rounds
    halves upward too, so this also keeps the two sides of the control agreeing
    about the same number.
    """
    return int(math.floor(percent / WEIGHT_STEP + 0.5)) * WEIGHT_STEP


def average_share(shares):
    """The share an average deck in the reference carries."""
    values = [value for value in shares.values() if value > 0]
    return sum(values) / len(values) if values else 0.0


def weight_of(share, average):
    """A reference share as a weight against the average deck, in whole steps."""
    if not average or share is None:
        return DEFAULT_WEIGHT
    stepped = _to_step(share / average * 100.0)
    return max(WEIGHT_MIN, min(WEIGHT_MAX, stepped))


def clamp_weight(value):
    """An operator's number, held to the range and the step it is shown in."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_WEIGHT
    return max(WEIGHT_MIN, min(WEIGHT_MAX, _to_step(number)))


def defaults_for(vertiports):
    """The reference weights for the decks that have been placed.

    A deck the files say nothing about is not guessed at: it starts at the
    average and is marked so the panel can say the number came from us rather
    than from the forecast.
    """
    by_place = {}
    for source_name, place in PLACE_NAMES.items():
        by_place[place] = source_name
    departure_average = average_share(DEPARTURE_SHARES)
    arrival_average = average_share(ARRIVAL_SHARES)
    rows = []
    for record in vertiports or ():
        identifier = record.get("id") if isinstance(record, dict) else getattr(record, "id", None)
        name = (record.get("name") if isinstance(record, dict) else getattr(record, "name", "")) or ""
        if not identifier:
            continue
        source_name = by_place.get(name)
        rows.append({
            "vertiport": identifier,
            "name": name,
            "source": source_name or "",
            "known": bool(source_name),
            "departure": weight_of(DEPARTURE_SHARES.get(source_name), departure_average),
            "arrival": weight_of(ARRIVAL_SHARES.get(source_name), arrival_average),
            "departure_share": DEPARTURE_SHARES.get(source_name),
            "arrival_share": ARRIVAL_SHARES.get(source_name),
        })
    return rows


def describe():
    """Everything the panel needs to draw and bound the control."""
    return {
        "schema_version": SCHEMA_VERSION,
        "source": SOURCE,
        "default_weight": DEFAULT_WEIGHT,
        "step": WEIGHT_STEP,
        "min": WEIGHT_MIN,
        "max": WEIGHT_MAX,
        "directions": list(DIRECTIONS),
        "note": ("100%가 평균 버티포트입니다. 받은 서울시 통행 비율을 평균 대비로 환산해 "
                 "10% 단위로 반올림한 값이 기본값이며, 자료에 없는 곳은 100%에서 시작합니다."),
        "places": [{"source": source, "name": place,
                    "departure_share": DEPARTURE_SHARES.get(source),
                    "arrival_share": ARRIVAL_SHARES.get(source)}
                   for source, place in PLACE_NAMES.items()],
    }


def shares(weights, scope=None):
    """The operator's weights as the shares a scheduler consumes.

    `weights` is `{vertiport: {"departure": w, "arrival": w}}`. The shares are
    normalised over the decks in scope, which is the right denominator: the
    reference covers all of Seoul, the day being built covers these decks.

    Every deck at zero would leave nothing to share out. That is a setting the
    operator can reach, so it answers zero shares rather than dividing by it,
    and the caller reports it as the empty day it is.
    """
    identifiers = [str(item) for item in (scope if scope is not None else weights.keys())]
    answer = {}
    for direction in DIRECTIONS:
        values = {}
        for identifier in identifiers:
            entry = weights.get(identifier) or {}
            values[identifier] = max(0.0, float(entry.get(direction, DEFAULT_WEIGHT)))
        total = sum(values.values())
        answer[direction] = ({identifier: 0.0 for identifier in identifiers} if total <= 0
                             else {identifier: value / total for identifier, value in values.items()})
    return answer


def validate(raw, scope=None):
    """An operator's weights, cleaned: every deck in scope, in range, on a step."""
    raw = raw if isinstance(raw, dict) else {}
    identifiers = [str(item) for item in (scope if scope is not None else raw.keys())]
    cleaned = {}
    for identifier in identifiers:
        entry = raw.get(identifier)
        entry = entry if isinstance(entry, dict) else {}
        cleaned[identifier] = {direction: clamp_weight(entry.get(direction, DEFAULT_WEIGHT))
                               for direction in DIRECTIONS}
    return cleaned


def summary(weights, scope=None, *, names=None):
    """What the summary window reads out: the busiest decks, and how uneven it is."""
    cleaned = validate(weights, scope)
    parts = shares(cleaned, scope)
    names = names or {}
    rows = []
    for identifier, entry in cleaned.items():
        rows.append({
            "vertiport": identifier, "name": names.get(identifier, identifier),
            "departure": entry["departure"], "arrival": entry["arrival"],
            "departure_share": round(parts["departure"].get(identifier, 0.0), 6),
            "arrival_share": round(parts["arrival"].get(identifier, 0.0), 6),
        })
    rows.sort(key=lambda row: row["departure_share"] + row["arrival_share"], reverse=True)
    live = [row for row in rows if row["departure"] > 0 or row["arrival"] > 0]
    return {
        "rows": rows,
        "busiest": rows[0]["name"] if rows else "",
        "quietest": live[-1]["name"] if live else "",
        "silent": [row["name"] for row in rows if row["departure"] == 0 and row["arrival"] == 0],
        "even": all(row["departure"] == DEFAULT_WEIGHT and row["arrival"] == DEFAULT_WEIGHT for row in rows),
    }
