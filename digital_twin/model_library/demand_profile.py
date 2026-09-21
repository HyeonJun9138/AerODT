"""Model Library: when in the day the demand happens, and who wants to go where.

`demand_ratios` says how much of a day belongs to each deck. This says *when*
in the day it happens, and turns the two into the thing a schedule is built
from: how many people want to travel from A to B in each hour of the operating
window.

The hourly shape is the Seoul travel-demand timeline we were handed — twenty-four
departure shares that sum to 100. It is a working day, not a flat line: the 08
hour carries five times what the 03 hour does, and a schedule built on a flat
day would put the fleet in the wrong place all morning.

Two decisions are worth saying out loud because neither is visible afterwards:

* **A window keeps the whole day's trips.** A day that runs 06:30–21:30 covers
  about nine tenths of the reference curve. The operator asked for 67,500 trips,
  so 67,500 trips are placed — shared out by the curve *normalised over the
  window* rather than sliced out of it. Otherwise several thousand people would
  vanish between the summary they read and the plan they get.
* **The pairs carry what the summary said they would.** The share of a leg is
  worked out here by the same formula the summary window draws, so the number
  beside 여의도 → 잠실 on screen is the number that gets scheduled.

Nothing here schedules anything, opens a file or reads a clock. It answers what
the demand is; `flight_scheduler` decides who flies it.
"""
import math

SCHEMA_VERSION = 1
SOURCE = "서울시 시간대별 통행 비율 (외부 제공, 2026-09-10 수신)"

# Per-hour share of a day's departures, 00 through 23, as percentages. The
# arrival curve is kept beside it because the two are not the same shape — the
# morning peak arrives an hour after it leaves — and a later version of the
# scheduler may want to place arrivals on their own curve.
HOURLY_DEPARTURE_PCT = (
    1.9581, 1.3959, 1.0857, 0.8918, 1.2796, 2.7142, 4.2458, 5.3509,
    5.6223, 5.3121, 5.1764, 5.1377, 5.0407, 5.1764, 5.2927, 5.4672,
    5.7387, 5.8938, 5.7774, 5.2540, 4.7111, 4.4785, 4.0132, 2.9857,
)
HOURLY_ARRIVAL_PCT = (
    1.7840, 1.2743, 0.9998, 0.9018, 1.3135, 2.8818, 4.8814, 6.0772,
    6.1164, 5.8224, 5.4695, 5.2735, 5.1362, 5.2735, 5.3323, 5.3519,
    5.4891, 5.5479, 5.3715, 4.8030, 4.3717, 4.1560, 3.6463, 2.7250,
)

MINUTES_PER_DAY = 24 * 60


def window_hours(start_minutes, end_minutes):
    """The hours a window touches, and how much of each one it holds.

    `[(6, 0.5), (7, 1.0), …, (21, 0.5)]` for 06:30–21:30. A window that ends
    before it starts runs past midnight; one that starts where it ends is empty
    rather than a whole day, because that is what the operator typed.
    """
    start, end = int(start_minutes), int(end_minutes)
    if start == end:
        return []
    span = (end - start) % MINUTES_PER_DAY or MINUTES_PER_DAY
    hours, minute = [], start
    while minute < start + span:
        hour = (minute // 60) % 24
        edge = (minute // 60 + 1) * 60
        held = min(edge, start + span) - minute
        hours.append((hour, round(held / 60.0, 6)))
        minute = edge
    return hours


def _largest_remainder(total, shares):
    """`total` whole units shared out by `shares`, adding up to `total` exactly.

    Whoever is owed the most by the rounding gets the next unit, and ties are
    broken by position so the same request is always the same answer.
    """
    total = int(total)
    if total <= 0 or not shares:
        return [0] * len(shares)
    weight = sum(max(0.0, share) for share in shares)
    if weight <= 0:
        return [0] * len(shares)
    exact = [total * max(0.0, share) / weight for share in shares]
    counts = [int(math.floor(value)) for value in exact]
    short = total - sum(counts)
    order = sorted(range(len(shares)), key=lambda index: (-(exact[index] - counts[index]), index))
    for index in order[:short]:
        counts[index] += 1
    return counts


def hourly_trips(daily_trips, start_minutes, end_minutes):
    """The day's trips, by the hour, inside the operating window.

    Keyed by the hour of the clock. The window's own hours are what the curve is
    normalised over, so the whole of `daily_trips` is placed rather than the
    share the window happens to cover.
    """
    hours = window_hours(start_minutes, end_minutes)
    if not hours:
        return {}
    weights = [HOURLY_DEPARTURE_PCT[hour] * fraction for hour, fraction in hours]
    counts = _largest_remainder(daily_trips, weights)
    return {hour: count for (hour, _), count in zip(hours, counts)}


def od_shares(weights, pairs):
    """What share of the day each leg carries.

    The formula the summary window draws: the departing deck's share of all
    departures against the arriving deck's share of all arrivals, with the
    departing deck itself left out of the arrival denominator because nobody
    flies to where they took off from. The pairs the operator cut carry nothing,
    so what is left is re-shared among the ones that remain rather than being
    quietly lost.

    `weights` is one row per deck with `vertiport`, `departure_share` and
    `arrival_share`; `pairs` is the unordered lines between them, each of which
    carries both directions.
    """
    rows = {str(row["vertiport"]): row for row in weights}
    legs = []
    for pair in pairs or ():
        ends = (str(pair.get("from")), str(pair.get("to")))
        for origin, destination in (ends, ends[::-1]):
            start, end = rows.get(origin), rows.get(destination)
            if start is None or end is None or origin == destination:
                continue
            rest = sum(float(row.get("arrival_share") or 0.0)
                       for identifier, row in rows.items() if identifier != origin)
            share = (float(start.get("departure_share") or 0.0)
                     * float(end.get("arrival_share") or 0.0) / rest) if rest > 0 else 0.0
            legs.append({"from": origin, "to": destination, "share": share})
    total = sum(leg["share"] for leg in legs)
    for leg in legs:
        leg["share"] = leg["share"] / total if total > 0 else 0.0
    legs.sort(key=lambda leg: (-leg["share"], leg["from"], leg["to"]))
    return legs


def demand_rows(*, daily_trips, weights, pairs, start_minutes, end_minutes):
    """Whole people, by hour and by leg: `{hour, from, to, passengers}`.

    Every hour is shared out on its own so the totals hold in both directions:
    the hours add up to the day, and each hour adds up to its own trips. A leg
    that comes to nobody in an hour is left out rather than carried as a zero.
    """
    legs = od_shares(weights, pairs)
    if not legs:
        return []
    shares = [leg["share"] for leg in legs]
    rows = []
    # What each leg is still owed from the hours before. An hour of ninety
    # trips over three hundred legs gives every leg a third of a person; rounded
    # on its own, every hour would hand its whole ninety to the same ninety legs
    # at the head of the list and the rest of the network would never see a
    # passenger. Carried forward, a leg owed a third an hour gets its person
    # every third hour, and the day as a whole lands where the shares said.
    owed = [0.0] * len(legs)
    # Between legs owed the same, the order is a round of matchings: in each
    # round every deck appears once as an origin and once as a destination, so
    # a thin hour is spread over the whole network rather than handed to
    # whichever decks sort first - as origins or as destinations.
    decks = sorted({leg["from"] for leg in legs} | {leg["to"] for leg in legs})
    place = {deck: index for index, deck in enumerate(decks)}
    turn = [((place[leg["from"]] + place[leg["to"]]) % len(decks), place[leg["from"]]) for leg in legs]
    for hour, trips in sorted(hourly_trips(daily_trips, start_minutes, end_minutes).items()):
        counts = _carried_remainder(trips, shares, owed, turn)
        for leg, count in zip(legs, counts):
            if count > 0:
                rows.append({"hour": hour, "from": leg["from"], "to": leg["to"], "passengers": count})
    return rows


def _carried_remainder(total, shares, owed, turn=None):
    """`total` whole units by `shares`, with `owed` carrying the rounding over.

    Each unit goes to whoever has the most owed, so the sum is exact in every
    call and, across calls, each share gets what it is owed to within one unit.
    `owed` is updated in place; `turn`, if given, orders those owed the same.
    """
    turn = list(turn) if turn is not None else list(range(len(shares)))
    total = int(total)
    if not shares:
        return []
    weight = sum(max(0.0, share) for share in shares)
    if total <= 0 or weight <= 0:
        return [0] * len(shares)
    for index, share in enumerate(shares):
        owed[index] += total * max(0.0, share) / weight
    counts = [max(0, int(math.floor(value))) for value in owed]
    short = total - sum(counts)
    if short < 0:
        # Floating drift could floor to one more than the hour holds; take it
        # back from where the least is owed.
        for index in sorted(range(len(shares)), key=lambda index: (round(owed[index] - counts[index], 9), turn[index], index), reverse=True):
            if short >= 0:
                break
            if counts[index] > 0:
                counts[index] -= 1
                short += 1
    else:
        order = sorted(range(len(shares)), key=lambda index: (-round(owed[index] - counts[index], 9), turn[index], index))
        for index in order[:short]:
            counts[index] += 1
    for index, count in enumerate(counts):
        owed[index] -= count
    return counts


def describe():
    """What the curve is and where it came from, for a screen that says so."""
    return {"schema_version": SCHEMA_VERSION, "source": SOURCE,
            "hourly_departure_pct": list(HOURLY_DEPARTURE_PCT),
            "hourly_arrival_pct": list(HOURLY_ARRIVAL_PCT)}
