"""Isolated loopback web/real-Cesium verification, without live collectors.

python -m project_support.tools.web_visualization.building_check
Open http://127.0.0.1:8778/building-check (or / for the real settings panel).
"""
from pathlib import Path

import uvicorn
from fastapi.responses import FileResponse

from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard.launcher import prepare_config


def main():
    root = Path(__file__).resolve().parents[3]
    config = prepare_config(root, 8778, "127.0.0.1")
    config.update(workspace_directory=str(root / "data/workspace/visualization_checks/buildings"),
                  cache_directory=str(root / "data/workspace/visualization_checks/buildings/cache"),
                  tick_seconds=60, airspace_enabled=False)
    app = create_app(config, sources=[])

    @app.get("/building-check", include_in_schema=False)
    async def check():
        return FileResponse(Path(__file__).with_suffix(".html"))

    uvicorn.run(app, host="127.0.0.1", port=8778, access_log=False)


if __name__ == "__main__":
    main()
