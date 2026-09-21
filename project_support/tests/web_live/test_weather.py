"""Coarse weather from Open-Meteo: request shape, decoding, wire and library."""
import json

import pytest
from fastapi.testclient import TestClient

from communication.external.weather_source import OpenMeteoSource, sample_points
from digital_twin.live_twin.weather_conditions import read_conditions
from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard.library_settings import DEFAULTS, LIMITS, describe_library, validate_settings

BOUNDS = {"lamin": 33.0, "lamax": 38.6, "lomin": 126.0, "lomax": 130.0}


def test_weather_code_is_requested_and_preserved_without_inventing_missing_conditions():
    assert 'weather_code' in OpenMeteoSource(BOUNDS).request()['params']['current'].split(',')
    data = {'latitude': 37.5, 'longitude': 127.0, 'current': {'weather_code': 73}}
    assert read_conditions(data, 1)['points'][0]['weather_code'] == 73
    data['current'] = {}
    assert read_conditions(data, 1)['points'][0]['weather_code'] is None


def test_a_window_becomes_a_few_points_that_describe_it():
    points = sample_points(BOUNDS)
    assert len(points) == 5, "the centre and the corners are enough for a coarse picture"
    centre = points[0]
    assert centre == (pytest.approx(35.8), pytest.approx(128.0))
    assert (BOUNDS["lamin"], BOUNDS["lomin"]) in points and (BOUNDS["lamax"], BOUNDS["lomax"]) in points
    for latitude, longitude in points:
        assert -90 <= latitude <= 90 and -180 <= longitude <= 180


def test_one_request_carries_every_point_and_asks_only_for_what_is_used():
    source = OpenMeteoSource(lambda: BOUNDS)
    request = source.request()
    assert request["url"].startswith("https://api.open-meteo.com/v1/forecast")
    assert request["params"]["latitude"] == "35.8,33.0,33.0,38.6,38.6"
    assert request["params"]["longitude"] == "128.0,126.0,130.0,126.0,130.0"
    asked = set(request["params"]["current"].split(","))
    assert {"cloud_cover", "visibility", "wind_speed_10m", "wind_direction_10m", "temperature_2m"} <= asked
    assert request["params"]["wind_speed_unit"] == "ms", "aviation reads wind in metres per second"
    assert "hourly" not in request["params"], "a coarse picture needs no forecast series"


def test_a_provider_answer_becomes_typed_conditions():
    payload = [
        {"latitude": 35.8, "longitude": 128.0, "elevation": 34.0,
         "current": {"time": "2026-09-09T08:00", "cloud_cover": 31, "visibility": 25280.0,
                     "wind_speed_10m": 2.3, "wind_direction_10m": 210, "temperature_2m": 26.4}},
        {"latitude": 33.0, "longitude": 126.0,
         "current": {"time": "2026-09-09T08:00", "cloud_cover": 88, "visibility": 8000.0,
                     "wind_speed_10m": 6.1, "wind_direction_10m": 90, "temperature_2m": 24.0}},
    ]
    conditions = read_conditions(payload, received_time=1788940800.0)
    assert conditions["schema_version"] == 1
    assert conditions["received_time"] == 1788940800.0
    assert conditions["observed_time"] == "2026-09-09T08:00"
    assert len(conditions["points"]) == 2
    centre = conditions["points"][0]
    assert centre["latitude"] == 35.8 and centre["cloud_cover_percent"] == 31
    assert centre["visibility_m"] == 25280.0 and centre["wind_speed_ms"] == 2.3
    assert centre["wind_direction_deg"] == 210 and centre["temperature_c"] == 26.4
    assert conditions["summary"]["cloud_cover_percent"] == 31, "the centre speaks for the window"
    assert conditions["summary"]["worst_visibility_m"] == 8000.0, "and the worst corner is not hidden"


def test_a_single_point_answer_and_a_broken_one_are_both_survivable():
    single = read_conditions({"latitude": 37.5, "longitude": 127.0,
                              "current": {"time": "2026-09-09T08:00", "cloud_cover": 10}}, received_time=1.0)
    assert len(single["points"]) == 1 and single["points"][0]["cloud_cover_percent"] == 10
    assert single["points"][0]["visibility_m"] is None
    for broken in (None, {}, [], {"current": None}, "nope"):
        assert read_conditions(broken, received_time=1.0)["points"] == []


def test_weather_and_clouds_are_library_sources_with_their_own_limits():
    described = describe_library()
    ids = [source["id"] for source in described["sources"]]
    assert "weather" in ids and "clouds" in ids
    weather = next(s for s in described["sources"] if s["id"] == "weather")
    assert {field["name"] for field in weather["fields"]} == {"enabled", "poll_seconds"}
    assert LIMITS["weather"]["poll_seconds"][0] >= 300
    clouds = next(s for s in described["sources"] if s["id"] == "clouds")
    assert {field["name"] for field in clouds["fields"]} == {"enabled", "product", "opacity", "refresh_seconds"}
    product = next(field for field in clouds["fields"] if field["name"] == "product")
    assert product["kind"] == "choice"
    assert [choice["id"] for choice in product["choices"]] == ["himawari_infrared", "himawari_visible", "modis"]
    assert DEFAULTS["clouds"]["enabled"] is False, "imagery is not fetched until it is asked for"
    assert DEFAULTS["weather"]["enabled"] is True

    assert DEFAULTS["clouds"]["product"] == "himawari_infrared", "cloud that is there day and night is the honest default"
    settled = validate_settings({"sources": {"clouds": {"product": "modis", "opacity": 0.4}}})
    assert settled["sources"]["clouds"]["product"] == "modis" and settled["sources"]["clouds"]["opacity"] == 0.4
    with pytest.raises(ValueError, match="^clouds.product:"):
        validate_settings({"sources": {"clouds": {"product": "sky"}}})
    with pytest.raises(ValueError, match="^clouds.opacity:"):
        validate_settings({"sources": {"clouds": {"opacity": 3}}})
    with pytest.raises(ValueError, match="^weather.poll_seconds:"):
        validate_settings({"sources": {"weather": {"poll_seconds": 10}}})


def test_conditions_read_a_record_exactly_as_data_froze_it():
    # Data stores records immutably: dicts become mapping proxies and lists tuples.
    from data.ingestion.source_records import freeze
    frozen = freeze([{"latitude": 35.8, "longitude": 128.0,
                      "current": {"time": "2026-09-09T08:15", "cloud_cover": 48, "visibility": 17180.0,
                                  "wind_speed_10m": 2.1, "wind_direction_10m": 180, "temperature_2m": 16.9}}])
    conditions = read_conditions(frozen, received_time=2.0)
    assert len(conditions["points"]) == 1, "a frozen record is still readable"
    assert conditions["summary"]["cloud_cover_percent"] == 48


def test_weather_is_served_from_the_last_record_and_says_when_there_is_none(tmp_path):
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": 10}, sources=[])
    with TestClient(app) as client:
        empty = client.get("/api/live/weather")
        assert empty.status_code == 200
        assert empty.json()["points"] == [] and empty.json()["schema_version"] == 1
        state = {item["id"]: item for item in client.get("/api/library/sources").json()["state"]}
        assert "weather" in state and "clouds" in state
        assert state["clouds"]["status"] in ("ready", "disabled", "paused"), "imagery reports a display state, not a feed"
