from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.web.simulation_routes import create_simulation_router

class Ports:
    calls = 0
    def create(self, body): self.calls += 1; return body
    def update(self, key, body): self.calls += 1; return body
    def delete(self, key): self.calls += 1; return True

def test_edit_lock_rejects_mutations_and_exposes_reason():
    ports = Ports()
    app = FastAPI()
    app.include_router(create_simulation_router(ports, edit_state=lambda: {'locked': True, 'message': '시뮬레이션 진행 중'}))
    client = TestClient(app)
    assert client.get('/api/simulation/vertiports/edit-state').json()['locked']
    for method, url in [('post','/api/simulation/vertiports'), ('put','/api/simulation/vertiports/a'), ('delete','/api/simulation/vertiports/a')]:
        response = client.request(method, url, json={})
        assert response.status_code == 409
    assert ports.calls == 0

def test_unlocked_edit_allows_existing_create():
    app = FastAPI()
    app.include_router(create_simulation_router(Ports(), edit_state=lambda: {'locked': False}))
    assert TestClient(app).post('/api/simulation/vertiports',json={}).status_code == 201
import threading
import pytest
from user_application.uam_mission.scenario_session import ScenarioSession

@pytest.mark.parametrize('state',['playing','paused'])
def test_session_rejects_edit_in_active_states(state):
    session=object.__new__(ScenarioSession);session._lock=threading.RLock();session.state=state
    with pytest.raises(PermissionError):session.edit_infrastructure(lambda:None)

def test_infrastructure_change_blocks_stale_plan_replay():
    session=object.__new__(ScenarioSession);session._lock=threading.RLock();session.state='ready';session.engine=object()
    assert session.edit_infrastructure(lambda:42)==42
    with pytest.raises(ValueError,match='다시'):session.play()
