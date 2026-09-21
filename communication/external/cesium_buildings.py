"""Fixed read-only Cesium OSM Buildings endpoint; account credential stays here."""
from communication.external.cesium_asset_endpoint import CesiumAssetEndpoint


class BuildingEndpoint(CesiumAssetEndpoint):
    def __init__(self, token, *, transport=None):
        super().__init__(token, 'buildings', transport=transport)
