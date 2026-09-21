import math

import pytest

from communication.external.aircraft_window import ViewWindow, clamp_window, read_view

KOREA = {"lamin": 33.0, "lamax": 38.6, "lomin": 126.0, "lomax": 130.0}


def area(window):
    return (window["lamax"] - window["lamin"]) * (window["lomax"] - window["lomin"])


def test_a_view_is_only_accepted_when_it_is_a_usable_rectangle():
    assert read_view({"lamin": 36, "lamax": 38, "lomin": 126, "lomax": 128}) == {
        "lamin": 36.0, "lamax": 38.0, "lomin": 126.0, "lomax": 128.0}
    assert read_view(None) is None
    assert read_view({"lamin": 38, "lamax": 36, "lomin": 126, "lomax": 128}) is None, "inverted"
    assert read_view({"lamin": 36, "lamax": 36, "lomin": 126, "lomax": 128}) is None, "empty"
    assert read_view({"lamin": -91, "lamax": 38, "lomin": 126, "lomax": 128}) is None, "off the globe"
    assert read_view({"lamin": 36, "lamax": 38, "lomin": 170, "lomax": -170}) is None, "one request cannot wrap"
    assert read_view({"lamin": float("nan"), "lamax": 38, "lomin": 126, "lomax": 128}) is None
    assert read_view({"lamin": True, "lamax": 38, "lomin": 126, "lomax": 128}) is None, "booleans are not coordinates"
    assert read_view({"lamin": "36", "lamax": 38, "lomin": 126, "lomax": 128}) is None
    assert read_view({"lamin": 36, "lamax": 38, "lomin": 126}) is None, "incomplete"


def test_no_reported_view_keeps_the_configured_fallback():
    assert clamp_window(None, fallback=KOREA) == KOREA
    assert clamp_window(None, fallback=KOREA) is not KOREA, "the caller's dict is not handed out"


def test_the_window_follows_the_view_and_includes_its_surroundings():
    view = {"lamin": 37.3, "lamax": 37.8, "lomin": 126.7, "lomax": 127.3}
    window = clamp_window(view, fallback=KOREA)
    assert window["lamin"] < view["lamin"] and window["lamax"] > view["lamax"]
    assert window["lomin"] < view["lomin"] and window["lomax"] > view["lomax"]
    centre = ((window["lamin"] + window["lamax"]) / 2, (window["lomin"] + window["lomax"]) / 2)
    # Coordinates are rounded to about a hundred metres so a drifting camera
    # does not produce a different request URL every time.
    assert centre == pytest.approx((37.55, 127.0), abs=1e-3), "centred on what the operator is looking at"


def test_a_close_up_view_still_asks_for_everything_the_request_pays_for():
    # The provider charges by tier. A city-block window and a 22 square degree
    # one cost the same request, and the small one simply has fewer aircraft in
    # it: over Seoul that was four instead of the thirty-odd the provider holds.
    view = {"lamin": 37.5, "lamax": 37.51, "lomin": 126.97, "lomax": 126.98}
    window = clamp_window(view, fallback=KOREA)
    assert area(window) == pytest.approx(22.0, abs=1e-2)
    assert window["lamax"] - window["lamin"] == pytest.approx(window["lomax"] - window["lomin"], abs=1e-2)
    assert (window["lamin"] + window["lamax"]) / 2 == pytest.approx(37.505, abs=1e-3), "still centred on the view"


def test_a_letterbox_view_grows_into_a_box_instead_of_a_band_round_the_globe():
    # Filling the tier by scaling would multiply the long side too; padding both
    # sides by the same degrees widens the short one where the room actually is.
    window = clamp_window({"lamin": 37.5, "lamax": 37.6, "lomin": 120.0, "lomax": 126.0}, fallback=KOREA)
    assert area(window) == pytest.approx(22.0, abs=1e-2)
    # Scaling this 0.1 by 6 degree view to the same area would have asked for
    # 36 degrees of longitude, a third of the way round the world.
    assert window["lomax"] - window["lomin"] < 11.0
    assert window["lamax"] - window["lamin"] > 2.0


def test_a_regional_view_is_shrunk_about_its_centre_so_the_request_stays_cheap():
    window = clamp_window({"lamin": 30, "lamax": 50, "lomin": 0, "lomax": 30}, fallback=KOREA)
    # Rounding the corners to about a hundred metres moves the area a little;
    # the tier it must stay inside is 25 square degrees, not 22.
    assert area(window) == pytest.approx(22.0, abs=1e-2)
    assert (window["lamin"] + window["lamax"]) / 2 == pytest.approx(40, abs=1e-3)
    assert (window["lomin"] + window["lomax"]) / 2 == pytest.approx(15, abs=1e-3)
    # The shape of the view is kept, so a wide view does not become a tall one.
    assert (window["lomax"] - window["lomin"]) > (window["lamax"] - window["lamin"])


def test_a_whole_globe_view_uses_the_configured_area_instead_of_cropping_an_ocean():
    # Zoomed out there is no locality to follow, and the centre of the screen is
    # usually open water; the configured box is the useful answer.
    for view in [{"lamin": -90, "lamax": 90, "lomin": -180, "lomax": 180},
                 {"lamin": -60, "lamax": 60, "lomin": -170, "lomax": 170},
                 {"lamin": 20, "lamax": 60, "lomin": 60, "lomax": 160}]:
        assert clamp_window(view, fallback=KOREA) == KOREA, view


def test_every_view_costs_the_same_cheapest_tier_and_uses_all_of_it():
    for view in [
        {"lamin": 37.4, "lamax": 37.6, "lomin": 126.9, "lomax": 127.1},
        {"lamin": 30, "lamax": 40, "lomin": 120, "lomax": 135},
        {"lamin": 89.9, "lamax": 90, "lomin": -180, "lomax": -179.9},
    ]:
        window = clamp_window(view, fallback=KOREA)
        assert area(window) == pytest.approx(22.0, abs=1e-2), view


def test_a_window_at_the_pole_or_the_antimeridian_slides_inside_instead_of_shrinking():
    north = clamp_window({"lamin": 88, "lamax": 89.9, "lomin": 126, "lomax": 128}, fallback=KOREA)
    assert north["lamax"] == 90.0 and north["lamin"] >= -90.0
    east = clamp_window({"lamin": 36, "lamax": 38, "lomin": 178, "lomax": 179.9}, fallback=KOREA)
    assert east["lomax"] == 180.0
    # Sliding, not clipping: the area asked for survives the edge of the map.
    for window in (north, east):
        assert area(window) == pytest.approx(22.0, abs=1e-2)
    assert all(-90 <= east[key] <= 90 for key in ("lamin", "lamax"))
    assert all(-180 <= east[key] <= 180 for key in ("lomin", "lomax"))


def test_the_holder_starts_on_the_fallback_and_follows_each_accepted_report():
    window = ViewWindow(KOREA)
    assert window.reported is False and window.current() == KOREA
    assert window.report({"lamin": 37.3, "lamax": 37.8, "lomin": 126.7, "lomax": 127.3}) is True
    assert window.reported is True
    seoul = window.current()
    assert seoul != KOREA and area(seoul) == pytest.approx(22.0, abs=1e-2)
    assert window.report({"nonsense": 1}) is False
    assert window.current() == seoul, "a rejected report leaves the last good window in place"
    assert window.report({"lamin": 35.1, "lamax": 35.3, "lomin": 129.0, "lomax": 129.2}) is True
    assert window.current() != seoul, "the newest report wins"
    window.clear()
    assert window.reported is False and window.current() == KOREA


def test_the_holder_also_hands_out_the_screen_itself_unchanged():
    # The twin decides which satellites are overhead from what is on screen, not
    # from the box shaped for an aircraft provider's price list.
    window = ViewWindow(KOREA)
    assert window.reported_view() is None
    seoul = {"lamin": 37.3, "lamax": 37.8, "lomin": 126.7, "lomax": 127.3}
    window.report(seoul)
    assert window.reported_view() == seoul
    assert window.reported_view() is not window.reported_view(), "a copy, not the holder's own dict"
    assert window.current() != seoul, "the provider window is widened; the screen is not"
    window.clear()
    assert window.reported_view() is None
