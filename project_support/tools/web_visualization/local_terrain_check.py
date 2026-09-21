"""Isolated local terrain UI check; no live flight/satellite requests or user settings writes."""
from fastapi.responses import FileResponse
from user_application.apps.web_dashboard.application import ROOT, create_app
from user_application.apps.web_dashboard.credentials import configure_cesium


def build():
    try:
        configure_cesium()
    except ValueError:
        pass
    app = create_app({'workspace_directory': str(ROOT/'data/workspace/terrain/ui_check'),
                      'cache_directory': str(ROOT/'data/workspace/terrain/ui_check/ingestion'),
                      'local_dem_directory': str(ROOT/'data/workspace/terrain/user_dem'),
                      'terrain_enabled': True, 'buildings_enabled': True,
                      'celestrak_enabled': False, 'opensky_enabled': False,
                      'vworld_enabled': False, 'airspace_enabled': False}, sources=[])

    @app.get('/terrain-check', include_in_schema=False)
    def check():
        return FileResponse(ROOT/'project_support/tools/web_visualization/local_terrain_check.html')
    return app
