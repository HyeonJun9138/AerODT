"""Isolated real PlanPanel + plan/run API QA, never the user's live workspace.

Run from repository root with web_venv Python; listen on 127.0.0.1:8879.
Fixtures are test-owned. No provider credentials or production app lifecycle.
"""
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from communication.web.domains.uam.plan_routes import create_plan_router
from communication.web.domains.uam.run_routes import create_run_router
from data.simulation.flight_plans import FlightPlans
from data.simulation.flight_runs import FlightRuns
from project_support.tests.web_live.test_flight_plan import NETWORK, VERTIPORTS
from user_application.uam_mission.flight_planning import FlightPlanning
from user_application.uam_mission.flight_execution import FlightExecution

directory = ROOT / 'data/workspace/validation/mission_separation' / ('ui-' + uuid.uuid4().hex[:8])
planning = FlightPlanning(vertiports=lambda: VERTIPORTS, network=lambda: NETWORK,
                          plans=FlightPlans(directory / 'plans'))
execution = FlightExecution(planning=planning, runs=FlightRuns(directory / 'runs'), root=ROOT, engine='native')
app = FastAPI()
app.include_router(create_plan_router(planning))
app.include_router(create_run_router(execution))
app.mount('/web', StaticFiles(directory=ROOT / 'user_application/web'), name='web')
app.mount('/visual-assets', StaticFiles(directory=ROOT / 'digital_twin/model_library/visual_assets'), name='assets')


@app.get('/', response_class=HTMLResponse)
def page():
    return (Path(__file__).with_suffix('.html')).read_text(encoding='utf-8')


if __name__ == '__main__':
    print('QA workspace:', directory, flush=True)
    uvicorn.run(app, host='127.0.0.1', port=8879)
