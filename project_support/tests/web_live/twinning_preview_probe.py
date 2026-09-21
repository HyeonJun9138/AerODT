"""Explicit local UI probe; no live-world sources, secrets or production server."""
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from communication.web.twinning_test_routes import create_twinning_test_router
from user_application.apps.web_dashboard.twinning_test import TwinningTestSession
from digital_twin.model_library.visual_catalog import read_visual_catalog

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / 'digital_twin/model_library/visual_assets'
session = TwinningTestSession(lambda: read_visual_catalog(ASSETS))


@asynccontextmanager
async def lifespan(app):
    yield
    await session.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(create_twinning_test_router(session))
app.mount('/static', StaticFiles(directory=ROOT/'user_application/web'), name='static')
app.mount('/visualization', StaticFiles(directory=ROOT/'digital_twin/visualization/web'), name='visualization')
app.mount('/visual-assets', StaticFiles(directory=ASSETS), name='assets')


@app.get('/api/visual-assets')
def catalog():
    return read_visual_catalog(ASSETS)


@app.get('/')
def index():
    return HTMLResponse('''<!doctype html><html lang="ko"><meta charset="utf-8">
    <title>Twinning Test local probe</title>
    <link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Widgets/widgets.css">
    <link rel="stylesheet" href="/static/twinning_test_panel.css">
    <script src="https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Cesium.js"></script>
    <body style="background:#0d1c25"><button id="open">Twinning Test</button>
    <script type="module">import {TwinningTestPanel} from '/static/twinning_test_panel.js';
    const panel=new TwinningTestPanel();document.querySelector('#open').onclick=()=>panel.open();
    </script></body></html>''')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=18776)
