"""How much of a day's demand belongs to each deck.

The two files we were given are shares of all Seoul travel, so they do not sum
to one and cannot be used as probabilities directly. These tests fix what is
done about that: they are weights, the operator reads them against an average
deck, and the shares a scheduler consumes are worked out over whichever decks
are actually in scope.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.demand_routes import create_demand_router
from digital_twin.model_library import demand_ratios as ratios

PLACES = ["여의도", "잠실", "상암", "용산", "목동", "미아", "봉천", "사당", "성수",
          "연신내", "천호", "광화문", "강남", "가산", "마곡", "망우", "수서", "인천"]
VERTIPORTS = [{"id": f"VP{index:03d}", "name": name} for index, name in enumerate(PLACES, start=1)]


def defaults():
    return {row["vertiport"]: row for row in ratios.defaults_for(VERTIPORTS)}


def weights_from(rows):
    return {identifier: {"departure": row["departure"], "arrival": row["arrival"]}
            for identifier, row in rows.items()}


def test_the_reference_is_kept_as_it_arrived_and_does_not_sum_to_one():
    """Seventeen districts out of a whole city: the missing fifth belongs to
    places no vertiport was placed at, which is why these are weights."""
    assert len(ratios.DEPARTURE_SHARES) == len(ratios.ARRIVAL_SHARES) == 17
    assert set(ratios.DEPARTURE_SHARES) == set(ratios.ARRIVAL_SHARES) == set(ratios.PLACE_NAMES)
    assert sum(ratios.DEPARTURE_SHARES.values()) == pytest.approx(0.803, abs=1e-9)
    assert sum(ratios.ARRIVAL_SHARES.values()) == pytest.approx(0.803, abs=1e-9)
    # Every row names a place a deck was actually placed at.
    assert len(set(ratios.PLACE_NAMES.values())) == 17


def test_a_share_reads_as_a_weight_against_the_average_deck():
    """0.047 says nothing without the total. 100% is an average deck, and the
    third significant figure of a forecast is not something to adjust, so the
    scale moves in tens."""
    rows = defaults()
    assert rows["VP013"]["name"] == "강남"
    assert rows["VP013"]["departure"] == 210, "the busiest deck sends twice an average one"
    assert rows["VP013"]["arrival"] == 160
    assert rows["VP004"]["departure"] == 50 and rows["VP004"]["arrival"] == 50, "용산 is half"
    assert rows["VP005"]["departure"] == 160, "목동"
    assert rows["VP001"]["departure"] == 100, "여의도 is about average"
    # Every default is on a step and inside the range.
    for row in rows.values():
        for direction in ratios.DIRECTIONS:
            assert row[direction] % ratios.WEIGHT_STEP == 0
            assert ratios.WEIGHT_MIN <= row[direction] <= ratios.WEIGHT_MAX


def test_a_deck_the_files_say_nothing_about_starts_at_the_average_and_says_so():
    rows = defaults()
    incheon = rows["VP018"]
    assert incheon["name"] == "인천"
    assert incheon["known"] is False and incheon["source"] == ""
    assert incheon["departure"] == incheon["arrival"] == ratios.DEFAULT_WEIGHT
    assert incheon["departure_share"] is None, "no forecast is reported as none, not as zero"
    assert rows["VP013"]["known"] is True and rows["VP013"]["source"] == "강남"


def test_an_operators_number_is_held_to_the_range_and_the_step():
    assert ratios.clamp_weight(123) == 120
    assert ratios.clamp_weight(125) == 130
    assert ratios.clamp_weight(-40) == ratios.WEIGHT_MIN
    assert ratios.clamp_weight(9999) == ratios.WEIGHT_MAX
    assert ratios.clamp_weight("nonsense") == ratios.DEFAULT_WEIGHT
    assert ratios.clamp_weight(None) == ratios.DEFAULT_WEIGHT


def test_the_shares_are_worked_out_over_the_decks_in_scope():
    """The reference covers the whole city; the day being built covers these
    decks. Normalising over the scope is the denominator the formula wants."""
    rows = defaults()
    scope = [row["vertiport"] for row in rows.values()]
    shares = ratios.shares(weights_from(rows), scope)
    for direction in ratios.DIRECTIONS:
        assert sum(shares[direction].values()) == pytest.approx(1.0, abs=1e-9)
    # 강남's share of these eighteen decks is larger than its share of the city.
    assert shares["departure"]["VP013"] > ratios.DEPARTURE_SHARES["강남"]
    # A smaller scope re-shares what is left rather than keeping the old numbers.
    pair = ratios.shares(weights_from(rows), ["VP013", "VP004"])
    assert pair["departure"]["VP013"] + pair["departure"]["VP004"] == pytest.approx(1.0)
    assert pair["departure"]["VP013"] == pytest.approx(210 / 260)


def test_every_deck_at_zero_answers_nothing_rather_than_dividing_by_it():
    silent = {"VP001": {"departure": 0, "arrival": 0}, "VP002": {"departure": 0, "arrival": 0}}
    shares = ratios.shares(silent, ["VP001", "VP002"])
    assert shares["departure"] == {"VP001": 0.0, "VP002": 0.0}
    assert shares["arrival"] == {"VP001": 0.0, "VP002": 0.0}


def test_validation_fills_in_every_deck_in_scope():
    cleaned = ratios.validate({"VP001": {"departure": 137}}, ["VP001", "VP002"])
    assert cleaned["VP001"]["departure"] == 140, "held to the step"
    assert cleaned["VP001"]["arrival"] == ratios.DEFAULT_WEIGHT, "the other direction is filled in"
    assert cleaned["VP002"] == {"departure": ratios.DEFAULT_WEIGHT, "arrival": ratios.DEFAULT_WEIGHT}
    assert set(cleaned) == {"VP001", "VP002"}, "and a deck out of scope is dropped"
    assert ratios.validate("not a mapping", ["VP001"])["VP001"]["departure"] == ratios.DEFAULT_WEIGHT


def test_the_summary_says_which_decks_the_day_is_about():
    rows = defaults()
    scope = [row["vertiport"] for row in rows.values()]
    names = {identifier: row["name"] for identifier, row in rows.items()}
    described = ratios.summary(weights_from(rows), scope, names=names)
    assert described["busiest"] == "강남"
    assert described["even"] is False
    assert described["silent"] == []
    assert len(described["rows"]) == len(scope)
    assert described["rows"][0]["name"] == "강남", "sorted by how much of the day it carries"
    # A deck switched off is named rather than merely being a zero in a list.
    quiet = weights_from(rows)
    quiet["VP004"] = {"departure": 0, "arrival": 0}
    assert ratios.summary(quiet, scope, names=names)["silent"] == ["용산"]
    # A flat setup is worth saying so the operator knows nothing is shaping it.
    flat = {identifier: {"departure": 100, "arrival": 100} for identifier in scope}
    assert ratios.summary(flat, scope, names=names)["even"] is True


def test_the_wire_serves_the_defaults_for_the_decks_that_exist():
    app = FastAPI()
    app.include_router(create_demand_router(lambda: VERTIPORTS))
    with TestClient(app) as client:
        answer = client.get("/api/simulation/demand/defaults")
        assert answer.status_code == 200 and answer.headers["cache-control"] == "no-store"
        body = answer.json()
        assert body["default_weight"] == 100 and body["step"] == 10
        assert body["min"] == 0 and body["max"] == 300
        assert body["directions"] == ["departure", "arrival"]
        assert "서울시" in body["source"]
        rows = {row["vertiport"]: row for row in body["vertiports"]}
        assert len(rows) == len(VERTIPORTS)
        assert rows["VP013"]["departure"] == 210
        assert rows["VP018"]["known"] is False

    # A vertiport store that cannot be read answers the scale with no decks,
    # rather than failing the panel that is only asking for its defaults.
    def broken():
        raise RuntimeError("store is unreadable")

    app = FastAPI()
    app.include_router(create_demand_router(broken))
    with TestClient(app) as client:
        body = client.get("/api/simulation/demand/defaults").json()
        assert body["vertiports"] == [] and body["default_weight"] == 100
