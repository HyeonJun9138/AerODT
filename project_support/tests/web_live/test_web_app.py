import asyncio
import time
from fastapi.testclient import TestClient

from user_application.apps.web_dashboard.application import create_app, SourceBinding


async def fetch_aircraft():
    return [dict(id="test", name="Test <script>", latitude=37, longitude=127,
        altitude_m=1000, speed_mps=100, track_deg=90, vertical_rate_mps=0,
        observed_at=time.time())]


def test_source_is_registered_in_data_before_state_is_exposed(tmp_path):
    binding = SourceBinding("fixture", "aircraft_v1", fetch_aircraft, 60, provenance="fixture")
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path), "tick_seconds": .02}, sources=[binding])
    with TestClient(app) as client:
        for _ in range(100):
            snapshot = client.get("/api/live/snapshot").json()
            if snapshot["entities"]:
                break
            time.sleep(.02)
        assert app.state.ingestion.latest("fixture") is not None
        assert snapshot["entities"][0]["provenance"] == "fixture"
        assert snapshot["capabilities"]["situation_assessment"] is False
        assert snapshot["sources"][0]["status"] == "ready"
        with client.websocket_connect("/ws/live") as socket:
            streamed = socket.receive_json()
            assert streamed["schema_version"] == 1
            assert streamed["entities"][0]["entity_id"] == "fixture:test"
        assert client.get("/api/health").json()["status"] == "ready"
        assert client.get("/api/visual-assets").json()["assets"]
        assert client.get("/data/workspace/private.json").status_code == 404
    manifest = next((tmp_path / 'logs/runs').glob('*/manifest.json'))
    assert 'stopped' in manifest.read_text()


def test_provider_failure_does_not_fail_server_or_expose_secret(tmp_path):
    async def fail():
        raise RuntimeError("secret=should-not-leak")
    binding = SourceBinding("failed", "aircraft_v1", fail, 60)
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path), "tick_seconds": .02}, sources=[binding])
    with TestClient(app) as client:
        time.sleep(.1)
        snapshot = client.get("/api/live/snapshot").json()
        assert snapshot["sources"][0]["status"] == "error"
        assert "should-not-leak" not in str(snapshot)
        assert client.get("/api/health").status_code == 200


def test_import_and_app_creation_do_not_start_network(tmp_path):
    calls = []
    async def fetch():
        calls.append(1)
        return []
    create_app({"cache_directory": str(tmp_path)}, sources=[SourceBinding("test", "aircraft_v1", fetch, 60)])
    assert calls == []


def test_sync_error_recovers_without_permanent_error_badge(tmp_path, monkeypatch):
    from digital_twin.live_twin.state_synchronization import LiveSynchronizer
    original = LiveSynchronizer.synchronize
    attempts = []
    def transient(self, *args, **kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise ValueError('transient')
        return original(self, *args, **kwargs)
    monkeypatch.setattr(LiveSynchronizer, 'synchronize', transient)
    app = create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path), 'tick_seconds':.02}, sources=[])
    with TestClient(app) as client:
        time.sleep(.15)
        data = client.get('/api/live/snapshot').json()
        assert len(attempts) > 1
        assert not any(source['id'] == 'synchronization' for source in data['sources'])


def test_clients_share_one_serialization_per_snapshot(tmp_path, monkeypatch):
    from user_application.apps.web_dashboard import application
    original = application.encode_snapshot
    calls = []
    def counted(*args):
        calls.append(1)
        return original(*args)
    monkeypatch.setattr(application, 'encode_snapshot', counted)
    app = create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path), 'tick_seconds':10}, sources=[])
    with TestClient(app) as client:
        time.sleep(.1)
        before = len(calls)
        for _ in range(10):
            assert client.get('/api/live/snapshot').status_code == 200
        assert len(calls) == before


def test_stream_sends_each_new_snapshot_once_and_paces_but_never_duplicates():
    from communication.web.live_routes import stream_snapshots

    async def scenario():
        current, sent, changed = ['a'], [], asyncio.Event()

        async def send(payload):
            sent.append(payload)

        async def wait_for_change():
            await changed.wait()
        task = asyncio.create_task(stream_snapshots(send, lambda: current[0], wait_for_change,
                                                    interval_seconds=.05, keepalive_seconds=.4))
        await asyncio.sleep(.02)
        assert sent == ['a']
        for value in ('b', 'c'):
            current[0] = value
            changed.set()
            changed.clear()
        await asyncio.sleep(.12)
        assert sent == ['a', 'c'], 'only the latest state after the minimum spacing'
        await asyncio.sleep(.15)
        assert sent == ['a', 'c'], 'an unchanged state is not re-sent every interval'
        await asyncio.sleep(.35)
        assert sent[:3] == ['a', 'c', 'c'] and len(sent) <= 4, 'keepalive resend is rare'
        current[0] = 'd'
        changed.set()
        changed.clear()
        await asyncio.sleep(.08)
        assert sent[-1] == 'd', 'a change wakes the stream without waiting for a keepalive'
        task.cancel()
    asyncio.run(scenario())


def test_websocket_receives_new_state_without_duplicate_frames(tmp_path):
    binding = SourceBinding("fixture", "aircraft_v1", fetch_aircraft, 60, provenance="fixture")
    app = create_app({"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path),
                      "tick_seconds": .05, "stream_seconds": .01}, sources=[binding])
    with TestClient(app) as client, client.websocket_connect("/ws/live") as socket:
        sequences = [socket.receive_json()["sequence"] for _ in range(6)]
    assert sequences == sorted(set(sequences)), 'each streamed frame carries a new sequence'


def test_stream_send_cost_is_part_of_cadence_not_added_to_every_interval():
    import pytest
    from communication.web.live_routes import stream_snapshots
    async def run(cost):
        now=[0.0];sent=[]
        class Done(Exception): pass
        async def send(payload):
            sent.append(now[0]);now[0]+=cost
            if len(sent)==6:raise Done()
        async def sleep(seconds):now[0]+=seconds
        try:
            await stream_snapshots(send,lambda:object(),interval_seconds=.1,
                sleep=sleep,clock=lambda:now[0])
        except Done: pass
        return [b-a for a,b in zip(sent,sent[1:])]
    for cost in [.03,.16]:
        gaps=asyncio.run(run(cost))
        assert gaps==pytest.approx([max(.1,cost)]*5)
