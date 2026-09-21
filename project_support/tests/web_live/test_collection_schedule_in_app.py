"""The collector honours the shared schedule, not just its own timer.

The guard is only worth having if the running server actually asks it before
every request, keeps a stop across a restart, and treats "not modified" as the
good answer it is.
"""
import json
import time

import httpx
from fastapi.testclient import TestClient

from communication.external.live_sources import NotModified
from data.ingestion.collection_guard import CollectionGuard
from user_application.apps.web_dashboard.application import SourceBinding, create_app


def settings(tmp_path, **extra):
    return {"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
            "tick_seconds": .02, **extra}


def guard_of(tmp_path):
    return CollectionGuard(tmp_path / "collection/guard.json")


def status_of(client, source_id):
    return next(item for item in client.get("/api/live/snapshot").json()["sources"] if item["id"] == source_id)


def test_a_restart_does_not_buy_another_request(tmp_path):
    """Restarting the server used to ask the provider again straight away. With
    a two hour interval and a debugging session, that is a lot of requests."""
    calls = []

    async def fetch():
        calls.append(time.time())
        return [{"id": "AB", "latitude": 37.5, "longitude": 127.0}]

    for _ in range(3):
        binding = SourceBinding("aircraft_probe", "aircraft_v1", fetch, 3600)
        with TestClient(create_app(settings(tmp_path), sources=[binding])):
            time.sleep(.15)
    assert len(calls) == 1, f"asked {len(calls)} times across three runs"
    assert guard_of(tmp_path).seconds_until_allowed("aircraft_probe") > 3000


def test_an_answer_that_will_not_change_stops_the_source_until_the_operator_looks(tmp_path):
    attempts = []

    async def forbidden():
        attempts.append(1)
        request = httpx.Request("GET", "https://celestrak.org/NORAD/elements/gp.php")
        raise httpx.HTTPStatusError("blocked", request=request, response=httpx.Response(403, request=request))

    binding = SourceBinding("blocked_probe", "celestrak_gp", forbidden, 1)
    with TestClient(create_app(settings(tmp_path), sources=[binding])) as client:
        time.sleep(.4)
        status = status_of(client, "blocked_probe")
        assert status["status"] == "stopped"
        assert "403" in status["message"] and "껐다 켜면" in status["message"]
    assert attempts == [1], "one refusal, then it stops asking"
    assert guard_of(tmp_path).stopped("blocked_probe") == "HTTP 403"

    # And it is still stopped in the next run: the process is not the client.
    with TestClient(create_app(settings(tmp_path), sources=[binding])):
        time.sleep(.3)
    assert attempts == [1]


def test_not_modified_is_a_success_and_keeps_what_we_hold(tmp_path):
    answers = []

    async def fetch():
        if answers:
            raise NotModified("Mon, 08 Sep 2026 10:00:00 GMT")
        answers.append(1)
        return [{"id": "AB", "latitude": 37.5, "longitude": 127.0}]

    binding = SourceBinding("conditional_probe", "aircraft_v1", fetch, .05)
    with TestClient(create_app(settings(tmp_path), sources=[binding])) as client:
        time.sleep(.4)
        status = status_of(client, "conditional_probe")
        assert status["status"] == "ready"
        assert status["message"] in ("외부 자료 수신", "공급자 확인: 변경 없음")
        assert status["updated_at"], "the copy we hold keeps its collection time"
    entries = guard_of(tmp_path).journal()
    assert [entry["outcome"] for entry in entries].count("failure") == 0


def test_a_fixture_source_is_not_written_to_the_schedule(tmp_path):
    async def fetch():
        return [{"id": "AB", "latitude": 37.5, "longitude": 127.0}]

    binding = SourceBinding("fixture_probe", "aircraft_v1", fetch, .02, provenance="fixture")
    with TestClient(create_app(settings(tmp_path), sources=[binding])):
        time.sleep(.2)
    path = tmp_path / "collection/guard.json"
    if path.exists():
        assert "fixture_probe" not in json.loads(path.read_text(encoding="utf-8"))["sources"]
