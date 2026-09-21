"""Keep prepared tile encodings out of generic response compression."""
from starlette.middleware.gzip import GZipMiddleware


class TileAwareGZipMiddleware:
    def __init__(self, app):
        self.app = app
        # Fast compression for changing JSON/static responses. The large 3D
        # tile route negotiates and caches its own gzip/identity representation.
        self.compressed = GZipMiddleware(app, minimum_size=1000, compresslevel=3)

    async def __call__(self, scope, receive, send):
        # WMTS JPEG/PNG is already compressed. Recompressing every cached image
        # consumes event-loop CPU during camera travel without improving it.
        prepared = ('/api/visualization/vworld/3d/', '/api/visualization/vworld/tiles/')
        path = scope.get('path', '')
        if scope['type'] == 'http' and (path.startswith(prepared) or
                (path.startswith('/visual-assets/') and path.lower().endswith('.glb'))):
            await self.app(scope, receive, send)
        else:
            await self.compressed(scope, receive, send)
