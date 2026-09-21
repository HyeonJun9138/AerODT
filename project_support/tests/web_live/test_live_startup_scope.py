"""UAM reconnects must not accidentally enable global satellite broadcasting."""
import time
from fastapi.testclient import TestClient
from user_application.apps.web_dashboard.application import create_app
from digital_twin.live_twin.state_synchronization import LiveSynchronizer

def test_startup_uses_configured_scope_and_then_the_actual_display(monkeypatch,tmp_path):
    initial={'lamin':37.,'lamax':38.,'lomin':126.,'lomax':128.}
    moved={'lamin':49.,'lamax':50.,'lomin':1.,'lomax':3.};seen=[]
    def sync(self,*args,**kwargs):seen.append(self.view());return ()
    monkeypatch.setattr(LiveSynchronizer,'synchronize',sync)
    app=create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path/'cache'),
                    'aircraft_bounds':initial,'tick_seconds':.02},sources=[])
    with TestClient(app) as client:
        end=time.monotonic()+2
        while not seen and time.monotonic()<end:time.sleep(.01)
        assert seen and seen[0]==initial
        assert client.post('/api/live/view',json=moved).status_code==200
        end=time.monotonic()+2
        while moved not in seen and time.monotonic()<end:time.sleep(.01)
        assert moved in seen
