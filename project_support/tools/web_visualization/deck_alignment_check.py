"""Read-only deck QA on loopback 8893; never controls the running simulation.

Run with --capture once to snapshot the three read-only scene endpoints and
reduce deck heights from the local DEM using the scenario's own calculation.
Only terrain GETs are forwarded to the dashboard on 8766. Credential-bearing
terrain endpoint responses stay in memory and are never logged or saved.
"""
import json
import re
import sys
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from navigation_performance_check import Handler as StaticHandler, MOUNTS, ROOT

MOUNTS['deck-fixtures'] = ROOT / 'data/workspace/deck_alignment_check'


def capture():
    sys.path.insert(0, str(ROOT))
    from data.terrain.local_dem import LocalDem
    from digital_twin.simulation.scenario_engine import ScenarioEngine

    directory = MOUNTS['deck-fixtures']
    directory.mkdir(parents=True, exist_ok=True)
    for name, endpoint in [('snapshot', '/api/live/snapshot'),
                           ('vertiports', '/api/simulation/vertiports'),
                           ('assets', '/api/visual-assets')]:
        with urlopen('http://127.0.0.1:8766' + endpoint, timeout=10) as response:
            value = json.load(response)
        (directory / (name + '.json')).write_text(json.dumps(value), encoding='utf-8')
    ports = json.loads((directory / 'vertiports.json').read_text())['vertiports']
    dem = LocalDem(ROOT / 'data/workspace/terrain/user_dem')
    try:
        # Height reduction only. No pilots, clock advancement or active session.
        engine = ScenarioEngine.__new__(ScenarioEngine)
        engine._vertiports = {p['id']: p for p in ports}
        engine._deck_heights = {}
        engine._elevation = dem.sample
        heights = {p['id']: engine._deck_height(p['id']) for p in ports}
        (directory / 'physical_decks.json').write_text(json.dumps(heights), encoding='utf-8')
    finally:
        dem.close()


class Handler(StaticHandler):
    def do_GET(self):
        if re.fullmatch(r'/api/visualization/terrain/(endpoint|local(?:/\d+/\d+/\d+)?)', self.path):
            try:
                with urlopen('http://127.0.0.1:8766' + self.path, timeout=30) as upstream:
                    content = upstream.read()
                    self.send_response(upstream.status)
                    self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/octet-stream'))
                    self.end_headers()
                    self.wfile.write(content)
            except (HTTPError, OSError):
                self.send_error(503, 'Terrain unavailable')
            return
        super().do_GET()


if __name__ == '__main__':
    if '--capture' in sys.argv:
        capture()
    ThreadingHTTPServer(('127.0.0.1', 8893), Handler).serve_forever()
