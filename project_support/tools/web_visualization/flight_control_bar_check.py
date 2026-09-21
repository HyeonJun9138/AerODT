"""Read-only Cesium/control-bar check using an explicitly chosen recorded run.

Run with --runs-root <isolated flight run shelf> --run-id <recording id>.
No providers, credentials, physics execution or writes to the shelf are used.
"""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from data.simulation.flight_runs import FlightRuns
from digital_twin.model_library.visual_catalog import read_visual_catalog
from digital_twin.model_library.flight_plan import plan_options
from project_support.tests.web_live.test_flight_plan import VERTIPORTS, NETWORK

app = FastAPI()
app.mount('/app', StaticFiles(directory=ROOT/'user_application/web'))
app.mount('/visualization', StaticFiles(directory=ROOT/'digital_twin/visualization/web'))
app.mount('/visual-assets', StaticFiles(directory=ROOT/'digital_twin/model_library/visual_assets'))

@app.get('/')
def page(): return FileResponse(Path(__file__).with_suffix('.html'))

@app.get('/fixture')
def fixture():
    shelf = app.state.shelf
    identifier = app.state.identifier
    return {'run':shelf.get(identifier), 'plan':shelf.plan(identifier), 'states':shelf.states(identifier),
            'options':plan_options(VERTIPORTS, NETWORK),
            'assets':read_visual_catalog(ROOT/'digital_twin/model_library/visual_assets')['assets']}

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs-root', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--port', type=int, default=8879)
    args = parser.parse_args()
    app.state.shelf = FlightRuns(args.runs_root.resolve())
    app.state.identifier = args.run_id
    app.state.shelf.get(args.run_id)  # Fail before listening if it is unavailable.
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)
