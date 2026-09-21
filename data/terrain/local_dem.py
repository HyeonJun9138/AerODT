"""Read-only, bounded local height rasters. No renderer or network dependency."""
from collections import OrderedDict
import json
import math
import mmap
from pathlib import Path
import struct
from threading import RLock


class LocalDem:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.manifest = json.loads((self.directory / 'manifest.json').read_text(encoding='utf-8'))
        if self.manifest.get('schema_version') != 1 or self.manifest.get('vertical_datum') not in ('egm96', 'ellipsoid'):
            raise ValueError('Unsupported DEM package')
        self.tiles = self.manifest['tiles']
        if not 1 <= len(self.tiles) <= 256:
            raise ValueError('Invalid raster count')
        blend = self.manifest.get('blend_degrees', .02)
        if not isinstance(blend, (int, float)) or not math.isfinite(blend) or not 0 < blend <= 1:
            raise ValueError('Invalid terrain blend distance')
        self.grids = self.tiles + ([self.manifest['geoid']] if self.manifest['vertical_datum'] == 'egm96' else [])
        for grid in self.grids:
            path = (self.directory / grid['file']).resolve()
            if path.parent != self.directory or grid['dtype'] not in ('int16', 'float32'):
                raise ValueError('Invalid raster path or type')
            w, h = grid['width'], grid['height']
            if not (2 <= w <= 10000 and 2 <= h <= 10000 and grid['dx'] > 0 and grid['dy'] > 0):
                raise ValueError('Invalid raster geometry')
            if path.stat().st_size != w * h * (2 if grid['dtype'] == 'int16' else 4):
                raise ValueError('Invalid raster length')
        self._maps = OrderedDict()
        self.lock = RLock()
        # Only exposed boundaries are feathered; adjoining source sheets remain continuous.
        self.edges = []
        for tile in self.tiles:
            west, south, east, north = tile['bounds']
            for axis, value, lo, hi, side in [('x', west, south, north, -1), ('x', east, south, north, 1),
                                               ('y', south, west, east, -1), ('y', north, west, east, 1)]:
                mx, my = ((value + side * 1e-7, (lo + hi)/2) if axis == 'x'
                          else ((lo + hi)/2, value + side * 1e-7))
                if not any(self._contains(t, mx, my) for t in self.tiles):
                    self.edges.append((axis, value, lo, hi))

    @staticmethod
    def _contains(tile, lon, lat):
        w, s, e, n = tile['bounds']
        return w <= lon <= e and s <= lat <= n

    def _buffer(self, grid):
        key = grid['file']
        if key not in self._maps:
            with (self.directory / key).open('rb') as f:
                self._maps[key] = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
            if len(self._maps) > 4:
                self._maps.popitem(last=False)[1].close()
        self._maps.move_to_end(key)
        return self._maps[key]

    def _sample(self, grid, lon, lat):
        x, y = (lon-grid['west'])/grid['dx'], (grid['north']-lat)/grid['dy']
        w, h = grid['width'], grid['height']
        if not (-1e-7 <= x <= w-1+1e-7 and -1e-7 <= y <= h-1+1e-7):
            return None
        x, y = max(0, min(w-1, x)), max(0, min(h-1, y))
        ix, iy = min(w-2, int(x)), min(h-2, int(y))
        fmt, stride = ('<h', 2) if grid['dtype'] == 'int16' else ('<f', 4)
        buf = self._buffer(grid)
        vals = [struct.unpack_from(fmt, buf, ((iy+dy)*w+ix+dx)*stride)[0]
                for dy, dx in ((0,0),(0,1),(1,0),(1,1))]
        if any(v == grid.get('nodata') or not math.isfinite(v) for v in vals):
            return None
        fx, fy = x-ix, y-iy
        return (vals[0]*(1-fx)+vals[1]*fx)*(1-fy)+(vals[2]*(1-fx)+vals[3]*fx)*fy

    def sample(self, lon, lat):
        """Return (ellipsoidal metres, coverage weight); missing is (0, 0)."""
        with self.lock:
            height = None
            for tile in self.tiles:
                if self._contains(tile, lon, lat):
                    height = self._sample(tile, lon, lat)
                    if height is not None:
                        break
            if height is None:
                return 0.0, 0.0
            if self.manifest['vertical_datum'] == 'egm96':
                geoid = self._sample(self.manifest['geoid'], lon, lat)
                if geoid is None:
                    return 0.0, 0.0
                height += geoid  # h = H + N, not H - N.
            distance = math.inf
            for axis, value, lo, hi in self.edges:
                a, b = (lon, lat) if axis == 'x' else (lat, lon)
                distance = min(distance, math.hypot(a-value, b-max(lo,min(hi,b))))
            t = min(1.0, distance / self.manifest.get('blend_degrees', .02))
            return height, t*t*(3-2*t)

    def close(self):
        with self.lock:
            for buf in self._maps.values():
                buf.close()
            self._maps.clear()
