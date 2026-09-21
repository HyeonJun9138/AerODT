"""Isolated rehearsal -> feature history -> real weights -> HTTP evidence.

Uses repository test fixtures, never the running dashboard's shared scenario.
This is a software integration check, not native-flight accuracy validation.
"""
import json
from pathlib import Path
import runpy
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))


def main():
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    fixtures=runpy.run_path(str(ROOT/'project_support/tests/web_live/test_scenario_session.py'))
    workspace=ROOT/'data/workspace/uam_prediction_comparison/integration'
    app=create_app({'workspace_directory':str(workspace),'cache_directory':str(workspace)},sources=[])
    session=app.state.scenario_session
    clock=fixtures['Clock']()
    session._now=clock
    session._vertiports=lambda:fixtures['VERTIPORTS']
    session._network=lambda:fixtures['NETWORK']
    session._elevation=None
    session._pilots_factory=None
    session._directory=None
    session.load(fixtures['CSV']);session.play()
    for _ in range(2400):
        clock.tick(.25);session.advance_view()
        captured=session.learned_prediction_input('scenario:A1')
        if (captured['entity'].altitude_m>100
                and all(w['status']=='ready' for w in captured['windows'].values())):
            break
    entity=captured['entity']
    app.state.world.replace([entity],entity.state_time,[])
    client=TestClient(app)  # No lifespan: no collectors, weather, or live processes.
    response=client.put('/api/library/sources',json={'sources':{'uam_prediction':{'model':'uam_route_mlp_comparison'}}})
    response.raise_for_status()
    started=time.perf_counter()
    response=client.get('/api/live/trajectory/scenario:A1');response.raise_for_status()
    elapsed=(time.perf_counter()-started)*1000
    answer=response.json()
    assert [p['status'] for p in answer['predictions']]==['ready']*3,answer
    assert all(len(p['path']['points'])==26 for p in answer['predictions'])
    output=workspace.parent/'comparison_actual.json'
    output.write_text(json.dumps(answer,ensure_ascii=False,indent=2),encoding='utf-8')
    evidence={'basis':'isolated kinematic rehearsal inputs, actual imported learned models, HTTP ASGI threadpool',
              'not_native_flight_accuracy':True,'phase':entity.flight_phase,'simulated_elapsed_s':session.engine.time_s-session.engine.opens_s,
              'model_t':captured['windows']['uam_route_mlp_short']['rows'][-1][0],
              'first_request_ms':elapsed,'generated_at':answer['generated_at'],
              'horizons':[p['horizon_seconds'] for p in answer['predictions']],
              'statuses':[p['status'] for p in answer['predictions']],
              'output':'comparison_actual.json'}
    (workspace.parent/'integration_evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(evidence,ensure_ascii=False))
    session.close()


if __name__=='__main__':
    main()
