"""Loopback-only renderer check; no live API, settings or simulation changes."""
from pathlib import Path
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

def build():
    root=Path(__file__).resolve().parents[3]
    app=FastAPI()
    app.mount('/visualization',StaticFiles(directory=root/'digital_twin/visualization/web'))
    app.mount('/visual-assets',StaticFiles(directory=root/'digital_twin/model_library/visual_assets'))
    @app.get('/taxi-heading')
    def taxi_heading():return FileResponse(Path(__file__).with_name('taxi_heading_check.html'))
    @app.get('/taxi-heading.json')
    def taxi_heading_data():return FileResponse(root/'data/workspace/visualization_checks/taxi_heading/run.json')
    @app.get('/boarding')
    def boarding():return FileResponse(Path(__file__).with_name('passenger_boarding_check.html'))
    @app.get('/boarding.json')
    def boarding_data():return FileResponse(root/'data/workspace/visualization_checks/boarding/fixture.json')
    @app.get('/')
    def page():return FileResponse(Path(__file__).with_suffix('.html'))
    @app.get('/flight-label')
    def flight_label():return FileResponse(Path(__file__).with_name('flight_label_check.html'))
    @app.get('/flight-motion')
    def flight_motion():return FileResponse(Path(__file__).with_name('flight_motion_check.html'))
    @app.get('/flight-run.json')
    def flight_run():return FileResponse(root/'data/workspace/visualization_checks/smooth_flight/run.json')
    @app.get('/flight-plan.js')
    def flight_plan():return FileResponse(root/'user_application/web/flight_plan.js',media_type='text/javascript')
    @app.get('/airtaxi.glb')
    def model():return FileResponse(root/'digital_twin/model_library/visual_assets/aircraft/civilian/projectairsim_airtaxi/model.glb')
    @app.get('/airtaxi.json')
    def metadata():return FileResponse(root/'digital_twin/model_library/visual_assets/aircraft/civilian/projectairsim_airtaxi/asset.json')
    return app

if __name__=='__main__':uvicorn.run(build(),host='127.0.0.1',port=8877,access_log=False)
