"""Geographic terrain tiles for visualization, never simulation ground truth."""
from collections import OrderedDict
from threading import RLock
import struct

SIZE = 65
MIN_LEVEL = 6
MAX_LEVEL = 14


class LocalTerrainTiles:
    def __init__(self, dem):
        self.dem = dem
        self.cache = OrderedDict()
        self.lock = RLock()

    def metadata(self):
        return {'schema_version': 1, 'enabled': True, 'width': SIZE, 'height': SIZE,
                'min_level': MIN_LEVEL, 'max_level': MAX_LEVEL,
                'bounds': [t['bounds'] for t in self.dem.tiles],
                'vertical_datum': 'WGS84 ellipsoid',
                'source_vertical_datum': self.dem.manifest['vertical_datum'],
                'datum_note': self.dem.manifest.get('datum_note', ''),
                'credit': 'Local DEM (user supplied)',
                'version': self.dem.manifest['version']}

    def tile(self, level, x, y):
        if not MIN_LEVEL <= level <= MAX_LEVEL or not 0 <= x < 2**(level+1) or not 0 <= y < 2**level:
            raise ValueError('Invalid terrain tile')
        key = level, x, y
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            step = 180 / 2**level
            west, north = -180 + x*step, 90-y*step
            east, south = west+step, north-step
            if not any(w <= east and e >= west and s <= north and n >= south
                       for w,s,e,n in (t['bounds'] for t in self.dem.tiles)):
                return None
            heights, weights = [], []
            for row in range(SIZE):
                for col in range(SIZE):
                    h, weight = self.dem.sample(west+step*col/(SIZE-1), north-step*row/(SIZE-1))
                    heights.append(h); weights.append(weight)
            result = struct.pack('<'+'f'*(SIZE*SIZE*2), *heights, *weights)
            self.cache[key] = result
            if len(self.cache) > 128:
                self.cache.popitem(last=False)
            return result
