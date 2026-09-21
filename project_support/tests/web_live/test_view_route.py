import asyncio

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.external.aircraft_window import ViewWindow
from communication.external.live_sources import OpenSkySource
from communication.web.live_routes import create_router

KOREA = {"lamin": 33.0, "lamax": 38.6, "lomin": 126.0, "lomax": 130.0}
SEOUL = {"lamin": 37.3, "lamax": 37.8, "lomin": 126.7, "lomax": 127.3}


def build(window=None):
    app = FastAPI()
    app.include_router(create_router(lambda: "{}", lambda: {}, 1, None, None,
                                     report_view=window.report if window else None))
    return app


def test_the_display_can_move_the_window_it_asks_the_provider_for():
    window = ViewWindow(KOREA)
    with TestClient(build(window)) as client:
        assert client.post("/api/live/view", json=SEOUL).json() == {"accepted": True}
    moved = window.current()
    assert moved != KOREA
    assert moved["lamin"] < SEOUL["lamin"] and moved["lamax"] > SEOUL["lamax"], "with its surroundings"


def test_a_page_from_another_origin_cannot_steer_the_request():
    window = ViewWindow(KOREA)
    with TestClient(build(window)) as client:
        response = client.post("/api/live/view", json=SEOUL, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert window.current() == KOREA, "the window is untouched"


def test_a_body_that_is_not_a_view_is_refused_and_changes_nothing():
    window = ViewWindow(KOREA)
    with TestClient(build(window)) as client:
        for body in [{"lamin": 38, "lamax": 36, "lomin": 126, "lomax": 128}, {}, [1, 2]]:
            assert client.post("/api/live/view", json=body).status_code == 400
        assert client.post("/api/live/view", content=b"not json",
                           headers={"Content-Type": "application/json"}).status_code == 400
    assert window.current() == KOREA


def test_without_an_aircraft_provider_the_report_is_accepted_but_does_nothing():
    with TestClient(build(None)) as client:
        response = client.post("/api/live/view", json=SEOUL)
    assert response.status_code == 200
    assert response.json() == {"accepted": False, "reason": "no_aircraft_provider"}


def test_the_provider_reads_the_window_at_request_time():
    asked = []

    def handle(request):
        if "auth" in str(request.url):
            return httpx.Response(200, json={"access_token": "token", "expires_in": 1800})
        asked.append(dict(httpx.URL(str(request.url)).params))
        return httpx.Response(200, json={"time": 1, "states": []})

    window = ViewWindow(KOREA)
    source = OpenSkySource("id", "secret", bounds=window.current)
    transport = httpx.MockTransport(handle)

    async def fetch_with(transport):
        # The source builds its own client, so patch the transport it will use.
        original = httpx.AsyncClient.__init__

        def patched(self, *args, **kwargs):
            kwargs["transport"] = transport
            original(self, *args, **kwargs)

        httpx.AsyncClient.__init__ = patched
        try:
            return await source.fetch()
        finally:
            httpx.AsyncClient.__init__ = original

    asyncio.run(fetch_with(transport))
    assert asked[-1] == {key: str(value) for key, value in KOREA.items()}
    window.report(SEOUL)
    asyncio.run(fetch_with(transport))
    assert asked[-1] != asked[0], "the next request follows the display"
    assert float(asked[-1]["lamin"]) < SEOUL["lamin"] < float(asked[-1]["lamax"])
