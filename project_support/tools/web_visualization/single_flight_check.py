"""Isolated single-flight UI and real Cesium rig QA; no production data writes."""
from pathlib import Path
import json
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from digital_twin.model_library.visual_catalog import read_visual_catalog
from digital_twin.model_library import flight_plan as fp
from digital_twin.simulation import native_flight_engine as native
from project_support.tests.web_live.test_flight_plan import VERTIPORTS, NETWORK

app=FastAPI()
app.mount('/app', StaticFiles(directory=ROOT/'user_application/web'))
app.mount('/visualization', StaticFiles(directory=ROOT/'digital_twin/visualization/web'))
app.mount('/visual-assets', StaticFiles(directory=ROOT/'digital_twin/model_library/visual_assets'))
@app.get('/')
def page(): return FileResponse(Path(__file__).with_suffix('.html'))
@app.get('/catalog')
def catalog(): return read_visual_catalog(ROOT/'digital_twin/model_library/visual_assets')
@app.get('/options')
def options(): return fp.plan_options(VERTIPORTS, NETWORK)
@app.post('/fly')
def fly(raw:dict):
    plan=fp.build_plan(fp.validate_request(raw, options()), VERTIPORTS, NETWORK)
    result=native.run(plan, root=ROOT, rate_hz=5)
    return {'plan':result['plan'],'states':result['states'],'run':{'run_id':'isolated-qa','summary':result['summary']}}
if __name__ == '__main__': uvicorn.run(app, host='127.0.0.1', port=8878, access_log=False)
