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

* **The daily total is a 24-hour potential demand.** The baseline traffic times
  the UAM conversion rate answers the whole day. An operating window takes only
  the part of the reference curve it covers; it does not squeeze demand from
  closed hours into the hours that remain. Half an hour takes half of that
  hour's share.
* **A missing pair does not move all of its demand elsewhere.** Demand is first
  formed over every selected origin and destination. If a leg cannot be flown,
  85% of that leg's demand is spread over plausible connected alternatives and
  15% leaves the UAM day. This keeps a sparse network from manufacturing the
  same total demand as a fully connected one.

Nothing here schedules anything, opens a file or reads a clock. It answers what
the demand is; `flight_scheduler` decides who flies it.
"""
import math

SCHEMA_VERSION = 1
SOURCE = "서울시 시간대별 통행 비율 (외부 제공, 2026-09-10 수신)"
OD_REDISTRIBUTION_RATE = 0.85

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
    """The 24-hour potential trips that fall inside the operating window.

    Keyed by the hour of the clock. First the window takes its proportional
    share of the 24-hour curve; only that clipped whole-person total is shared
    between the included hours. The second allocation keeps integer rounding
    deterministic without changing the window total.
    """
    hours = window_hours(start_minutes, end_minutes)
    if not hours:
        return {}
    weights = [HOURLY_DEPARTURE_PCT[hour] * fraction for hour, fraction in hours]
    counts = _largest_remainder(window_demand(daily_trips, start_minutes, end_minutes), weights)
    return {hour: count for (hour, _), count in zip(hours, counts)}


def window_share(start_minutes, end_minutes):
    """Share of the 24-hour departure curve covered by an operating window."""
    hours = window_hours(start_minutes, end_minutes)
    whole = sum(HOURLY_DEPARTURE_PCT)
    return (sum(HOURLY_DEPARTURE_PCT[hour] * fraction for hour, fraction in hours) / whole
            if whole > 0 else 0.0)


def window_demand(daily_trips, start_minutes, end_minutes):
    """Whole passengers available while the service is open."""
    return max(0, int(round(max(0, int(daily_trips)) * window_share(start_minutes, end_minutes))))


def _potential_legs(weights):
    """The unconstrained OD market over every selected vertiport."""
    rows = {str(row["vertiport"]): row for row in weights}
    legs = []
    for origin, start in rows.items():
        for destination, end in rows.items():
            if origin == destination:
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


def _connected_legs(pairs, available_legs=None):
    connected = set()
    for pair in pairs or ():
        ends = (str(pair.get("from")), str(pair.get("to")))
        if ends[0] != ends[1]:
            connected.update((ends, ends[::-1]))
    if available_legs is not None:
        connected &= {(str(origin), str(destination)) for origin, destination in available_legs}
    return connected


def od_allocation(weights, pairs, *, available_legs=None,
                  redistribution_rate=OD_REDISTRIBUTION_RATE):
    """Connected OD shares after partial diffusion of disconnected demand.

    A disconnected leg first looks for connected alternatives from the same
    origin, then alternatives arriving at the same destination, then legs that
    touch either endpoint. Only if none exist does it use the remaining network.
    The chosen alternatives divide the transferable share in proportion to
    their unconstrained OD shares. No direct route is invented.
    """
    rate = min(1.0, max(0.0, float(redistribution_rate)))
    potential = _potential_legs(weights)
    connected = _connected_legs(pairs, available_legs)
    active = [dict(leg, direct_share=leg["share"], redistributed_share=0.0)
              for leg in potential if (leg["from"], leg["to"]) in connected]
    inactive = [leg for leg in potential if (leg["from"], leg["to"]) not in connected]
    by_key = {(leg["from"], leg["to"]): leg for leg in active}

    for missing in inactive:
        candidates = [leg for leg in active
                      if leg["from"] == missing["from"] and leg["direct_share"] > 0]
        if not candidates:
            candidates = [leg for leg in active
                          if leg["to"] == missing["to"] and leg["direct_share"] > 0]
        if not candidates:
            candidates = [leg for leg in active
                          if leg["direct_share"] > 0 and (
                              missing["from"] in (leg["from"], leg["to"])
                              or missing["to"] in (leg["from"], leg["to"]))]
        if not candidates:
            candidates = [leg for leg in active if leg["direct_share"] > 0]
        transferable = missing["share"] * rate
        weight = sum(max(0.0, leg["direct_share"]) for leg in candidates)
        for candidate in candidates:
            portion = (max(0.0, candidate["direct_share"]) / weight
                       if weight > 0 else 1.0 / len(candidates))
            by_key[(candidate["from"], candidate["to"])]["redistributed_share"] += transferable * portion

    for leg in active:
        leg["share"] = leg["direct_share"] + leg["redistributed_share"]
    active.sort(key=lambda leg: (-leg["share"], leg["from"], leg["to"]))
    direct = sum(leg["direct_share"] for leg in active)
    disconnected = sum(leg["share"] for leg in inactive)
    redistributed = sum(leg["redistributed_share"] for leg in active)
    lost = max(0.0, 1.0 - direct - redistributed)
    return {"legs": active, "direct_share": direct, "disconnected_share": disconnected,
            "redistributed_share": redistributed, "lost_share": lost,
            "redistribution_rate": rate}


def od_shares(weights, pairs, *, available_legs=None,
              redistribution_rate=OD_REDISTRIBUTION_RATE):
    """What absolute share of operating-window demand each connected leg carries."""
    return od_allocation(weights, pairs, available_legs=available_legs,
                         redistribution_rate=redistribution_rate)["legs"]


def demand_plan(*, daily_trips, weights, pairs, start_minutes, end_minutes,
                available_legs=None, redistribution_rate=OD_REDISTRIBUTION_RATE):
    """Whole-person demand rows and an explicit account of demand diffusion."""
    allocation = od_allocation(weights, pairs, available_legs=available_legs,
                               redistribution_rate=redistribution_rate)
    hourly = hourly_trips(daily_trips, start_minutes, end_minutes)
    window_total = sum(hourly.values())
    direct, redistributed, lost = _largest_remainder(
        window_total, [allocation["direct_share"], allocation["redistributed_share"],
                       allocation["lost_share"]])
    scheduled = direct + redistributed
    hourly_scheduled = _largest_remainder(scheduled, list(hourly.values()))
    legs = allocation["legs"]
    rows = []
    if legs and scheduled > 0:
        shares = [leg["share"] for leg in legs]
        owed = [0.0] * len(legs)
        decks = sorted({leg["from"] for leg in legs} | {leg["to"] for leg in legs})
        place = {deck: index for index, deck in enumerate(decks)}
        turn = [((place[leg["from"]] + place[leg["to"]]) % len(decks), place[leg["from"]])
                for leg in legs]
        for (hour, _), trips in zip(sorted(hourly.items()), hourly_scheduled):
            counts = _carried_remainder(trips, shares, owed, turn)
            for leg, count in zip(legs, counts):
                if count > 0:
                    rows.append({"hour": hour, "from": leg["from"], "to": leg["to"],
                                 "passengers": count})
    return {"rows": rows, "summary": {
        "operating_window_demand_passengers": window_total,
        "direct_connected_demand_passengers": direct,
        "disconnected_od_demand_passengers": redistributed + lost,
        "redistributed_demand_passengers": redistributed,
        "network_lost_demand_passengers": lost,
        "network_schedulable_demand_passengers": scheduled,
        "od_redistribution_rate": allocation["redistribution_rate"],
    }}


def demand_rows(*, daily_trips, weights, pairs, start_minutes, end_minutes,
                available_legs=None, redistribution_rate=OD_REDISTRIBUTION_RATE):
    """Whole people, by hour and by leg: `{hour, from, to, passengers}`.

    The rows add up to the network-schedulable part of the operating-window
    demand. The network-loss remainder is available from `demand_plan`; it is
    intentionally not turned into a flight row. A leg that comes to nobody in
    an hour is left out rather than carried as a zero.
    """
    return demand_plan(daily_trips=daily_trips, weights=weights, pairs=pairs,
                       start_minutes=start_minutes, end_minutes=end_minutes,
                       available_legs=available_legs,
                       redistribution_rate=redistribution_rate)["rows"]


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
            "hourly_arrival_pct": list(HOURLY_ARRIVAL_PCT),
            "od_redistribution_rate": OD_REDISTRIBUTION_RATE}
