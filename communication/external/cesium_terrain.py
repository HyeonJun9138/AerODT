"""Fixed Cesium World Terrain asset; it is not a physical observation source."""
import time

from communication.external.cesium_asset_endpoint import CesiumAssetEndpoint


class TerrainEndpoint(CesiumAssetEndpoint):
    def __init__(self, token, *, transport=None, clock=time.monotonic):
        super().__init__(token, 'terrain', transport=transport, clock=clock)
