"""Same-origin visualization asset access, separate from physical observations."""
from communication.web.cesium_routes import create_cesium_router


def create_building_router(fetch):
    return create_cesium_router('buildings', fetch)
