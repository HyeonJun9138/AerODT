import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.web.operations_routes import create_operations_router
from user_application.apps.web_dashboard.operations_rehearsal import OperationsRehearsal, RehearsalError


def setup_room():
    records = [{'id': 'VP1', 'name': '여의도'}, {'id': 'VP2', 'name': '목동'}]
    clock = [1000.0]
    room = OperationsRehearsal(lambda: records, lambda: clock[0])
    app = FastAPI()
    app.include_router(create_operations_router(room))
    return room, TestClient(app), records, clock


def join(client, role, facility=None):
    result = client.post('/api/operations/rehearsal/join', json={'name': role, 'role': role, 'facility_id': facility})
    assert result.status_code == 200
    return {'X-AeroDT-Session': result.json()['token']}


def test_two_clients_share_requests_responses_and_facility_scopes():
    room, a, _, _ = setup_room()
    b = TestClient(a.app)
    psu, vp = join(a, 'psu'), join(b, 'vertiport', 'VP1')
    request = b.post('/api/operations/rehearsal/reports', headers=vp, json={'facility_id': 'VP1', 'note': 'F1 점검 연습'}).json()
    snap = a.get('/api/operations/rehearsal', headers=psu).json()
    assert len(snap['participants']) == 2
    assert snap['requests'][0] == request
    assert 'token' not in str(snap)
    assert not snap['capabilities']['vehicle_control']
    path = f"/api/operations/rehearsal/requests/{request['id']}/decision"
    answer = a.post(path, headers=psu, json={'version': 1, 'action': 'acknowledged', 'note': '확인했습니다'})
    assert answer.status_code == 200
    remote = b.get('/api/operations/rehearsal', headers=vp).json()
    assert remote['requests'][0]['response'] == '확인했습니다'
    assert remote['revision'] > snap['revision']
    assert len(remote['history']) == 1


def test_roles_versions_and_terminal_requests_are_enforced():
    room, client, _, _ = setup_room()
    psu, vp = join(client, 'psu'), join(client, 'vertiport', 'VP1')
    assert client.post('/api/operations/rehearsal/examples', headers=vp).status_code == 403
    assert client.post('/api/operations/rehearsal/reports', headers=vp, json={'facility_id': 'VP2', 'note': 'no'}).status_code == 403
    seeded = client.post('/api/operations/rehearsal/examples', headers=psu).json()
    assert len(seeded['requests']) == 4
    assert client.post('/api/operations/rehearsal/examples', headers=psu).status_code == 409
    path = '/api/operations/rehearsal/requests/'+seeded['requests'][0]['id']+'/decision'
    assert client.post(path, headers=vp, json={'version': 1, 'action': 'hold'}).status_code == 403
    assert client.post(path, headers=psu, json={'version': 1, 'action': 'hold'}).status_code == 200
    assert client.post(path, headers=psu, json={'version': 1, 'action': 'proceed'}).status_code == 409
    assert client.post(path, headers=psu, json={'version': 2, 'action': 'proceed'}).status_code == 200
    assert client.post(path, headers=psu, json={'version': 3, 'action': 'hold'}).status_code == 409


def test_lost_sessions_restart_expiry_and_deleted_facility_do_not_control_anything():
    room, client, records, clock = setup_room()
    vp = join(client, 'vertiport', 'VP1')
    records.pop(0)
    assert client.post('/api/operations/rehearsal/reports', headers=vp, json={'facility_id': 'VP1', 'note': 'test'}).status_code == 409
    clock[0] += 91
    assert client.get('/api/operations/rehearsal', headers=vp).status_code == 401
    assert not client.get('/api/operations/rehearsal').json()['participants']
    assert OperationsRehearsal(lambda: records).room_id != room.room_id


def test_snapshot_is_detached_and_wire_is_bounded_and_same_origin():
    room, client, _, _ = setup_room()
    psu = join(client, 'psu')
    client.post('/api/operations/rehearsal/examples', headers=psu)
    snapshot = room.snapshot()
    snapshot['requests'][0]['state'] = 'tampered'
    assert room.snapshot()['requests'][0]['state'] == 'pending'
    assert client.post('/api/operations/rehearsal/join', json={'role': 'admin'}).status_code == 422
    assert client.post('/api/operations/rehearsal/join', json={'role': 'psu', 'name': 'x'*33}).status_code == 422
    assert client.post('/api/operations/rehearsal/examples', headers={**psu, 'Origin': 'http://other.example'}).status_code == 403
    assert client.get('/api/operations/rehearsal').headers['cache-control'] == 'no-store'
    assert client.post('/api/operations/rehearsal/examples').status_code == 401


def test_role_switch_retires_previous_session_and_room_has_capacity_limit():
    room, client, _, _ = setup_room()
    headers = join(client, 'psu')
    result = client.post('/api/operations/rehearsal/join', headers=headers, json={'role':'vertiport','facility_id':'VP1'})
    assert result.status_code == 200
    assert len(room.sessions) == 1
    assert client.get('/api/operations/rehearsal', headers=headers).status_code == 401
    for _ in range(63):
        room.join('test', 'psu')
    with pytest.raises(RehearsalError) as error:
        room.join('overflow', 'psu')
    assert error.value.status == 429


def test_app_mounts_rehearsal_without_starting_sources(tmp_path):
    from user_application.apps.web_dashboard.application import create_app
    app = create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path)}, sources=[])
    client = TestClient(app)
    assert client.get('/api/operations/rehearsal').json()['scope'] == 'shared_rehearsal'


def test_two_websocket_observers_receive_same_live_world_entities(tmp_path):
    import time
    from user_application.apps.web_dashboard.application import create_app, SourceBinding
    async def aircraft():
        return [dict(id='shared', name='Shared observation', latitude=37, longitude=127,
                     altitude_m=1000, speed_mps=0, track_deg=0, vertical_rate_mps=0, observed_at=time.time())]
    app = create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path), 'tick_seconds':.02},
                     sources=[SourceBinding('fixture','aircraft_v1',aircraft,60,provenance='fixture')])
    with TestClient(app) as client:
        for _ in range(100):
            if client.get('/api/live/snapshot').json()['entities']:
                break
            time.sleep(.02)
        with client.websocket_connect('/ws/live') as first, client.websocket_connect('/ws/live') as second:
            a, b = first.receive_json(), second.receive_json()
            assert a['entities'] and b['entities']
            assert {r['entity_id'] for r in a['entities']} == {r['entity_id'] for r in b['entities']} == {'fixture:shared'}
            assert a['schema_version'] == b['schema_version']
        assert app.state.operations_rehearsal.snapshot()['requests'] == []


def test_leaving_frees_the_seat_at_once_and_is_safe_to_repeat():
    room, a, _, _ = setup_room()
    b = TestClient(a.app)
    psu, vp = join(a, 'psu'), join(b, 'vertiport', 'VP1')
    before = a.get('/api/operations/rehearsal', headers=psu).json()
    assert len(before['participants']) == 2

    gone = a.post('/api/operations/rehearsal/leave', headers=psu)
    assert gone.status_code == 200
    # The seat is free for the next person straight away rather than lingering
    # for the prune window, and everyone else sees that in the same revision.
    assert gone.json()['member'] is None
    remote = b.get('/api/operations/rehearsal', headers=vp).json()
    assert [p['role'] for p in remote['participants']] == ['vertiport']
    assert remote['revision'] > before['revision']

    # The token is spent: acting with it is refused the way an expired one is.
    refused = a.post('/api/operations/rehearsal/examples', headers=psu)
    assert refused.status_code == 401

    # Leaving twice, or without ever having sat down, is not an error: the
    # intention - to stop being the PSU - is satisfied either way.
    again = a.post('/api/operations/rehearsal/leave', headers=psu)
    assert again.status_code == 200 and again.json()['member'] is None
    assert a.post('/api/operations/rehearsal/leave').status_code == 200
    settled = b.get('/api/operations/rehearsal', headers=vp).json()
    assert settled['revision'] == remote['revision'], 'nothing changed, so nothing was bumped'

    # And the seat can be taken again afterwards.
    retaken = join(a, 'psu')
    assert len(b.get('/api/operations/rehearsal', headers=vp).json()['participants']) == 2
    assert a.get('/api/operations/rehearsal', headers=retaken).json()['member']['role'] == 'psu'
