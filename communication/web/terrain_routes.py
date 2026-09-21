"""World Terrain endpoint; no client-selected URL or asset ID is accepted."""
from communication.web.cesium_routes import create_cesium_router


def create_terrain_router(fetch):
    return create_cesium_router('terrain', fetch)
