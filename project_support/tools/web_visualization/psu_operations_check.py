"""Isolated two-browser rehearsal QA. Does not contact or modify the running app."""
from pathlib import Path
import json
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from communication.web.domains.uam.operations_routes import create_operations_router
from user_application.apps.web_dashboard.operations_rehearsal import OperationsRehearsal
from project_support.tests.web_live.test_flight_plan import vertiport
import uvicorn

records = [vertiport('VP1', '여의도', 37.525, 126.920, gates=4, heading_deg=35),
           vertiport('VP2', '목동', 37.530, 126.870, gates=8, heading_deg=125),
           vertiport('VP3', '잠실', 37.513, 127.102, gates=4)]
app = FastAPI()
app.mount('/app', StaticFiles(directory=ROOT/'user_application/web'))
app.include_router(create_operations_router(OperationsRehearsal(lambda: records)))

@app.get('/')
def page():
    return FileResponse(Path(__file__).with_suffix('.html'))

@app.get('/fixture')
def fixture():
    return {'vertiports': records}

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=8884, access_log=False)
