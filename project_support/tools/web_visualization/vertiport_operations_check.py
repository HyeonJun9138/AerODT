"""Read-only visual QA using explicitly captured facility/weather snapshots."""
from pathlib import Path
import argparse
import json
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

app = FastAPI()
app.mount('/app', StaticFiles(directory=ROOT/'user_application/web'))
app.mount('/visualization', StaticFiles(directory=ROOT/'digital_twin/visualization/web'))

@app.get('/')
def page():
    return FileResponse(Path(__file__).with_suffix('.html'))

@app.get('/fixture')
def fixture():
    return app.state.fixture

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures-root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8879)
    args = parser.parse_args()
    app.state.fixture = {name: json.loads((args.fixtures_root/f'{name}.json').read_text(encoding='utf-8'))
                         for name in ('records', 'weather')}
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)
