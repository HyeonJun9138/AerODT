"""Offline, bounded visual DEM conditioning; never authoritative flight ground.

Inputs are read-only SRTM Point GeoTIFFs (WGS84 / EGM96) and vector MBTiles.
Keep the source sampling grid. No super-resolution, inferred survey elevations,
river flow enforcement, or automatic activation in the running dashboard.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import sqlite3

import mapbox_vector_tile
from mapbox_vector_tile.Mapbox import vector_tile_pb2
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine
from scipy import ndimage as ndi

NODATA = -32767.0
MASK_NAMES = ('water', 'river', 'airport', 'road')
LAYERS = {'water', 'waterway', 'aeroway', 'transportation'}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def source_metadata(path):
    with rasterio.open(path) as d:
        tags = d.tags()
        if (d.crs.to_epsg() != 4326 or tags.get('AREA_OR_POINT') != 'Point'
                or tags.get('DTED_VerticalDatum') != 'E96' or d.count != 1
                or d.transform.b != 0 or d.transform.d != 0):
            raise ValueError(f'Unsupported source geometry or vertical datum: {path.name}')
        return dict(name=path.name, sha256=sha(path), width=d.width, height=d.height,
                    west=d.transform.c + d.transform.a / 2,
                    north=d.transform.f + d.transform.e / 2,
                    dx=d.transform.a, dy=-d.transform.e, nodata=d.nodata,
                    vertical_datum='egm96')


def smooth_valid(a, valid, sigma):
    weights = ndi.gaussian_filter(valid.astype('float32'), sigma, mode='nearest')
    total = ndi.gaussian_filter(np.where(valid, a, 0).astype('float32'), sigma, mode='nearest')
    return np.divide(total, weights, out=a.copy(), where=weights > 1e-6)


def condition_patch(a, masks, spacing):
    """A 64-cell halo exceeds every truncated kernel support used here."""
    valid = np.isfinite(a) & (a != NODATA)
    base = smooth_valid(a, valid, 1.2)
    gy, gx = np.gradient(smooth_valid(a, valid, 2), *spacing)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # Gently taper at 1--4 degrees; never smooth a mountain merely for being low.
    strength = np.clip((4 - slope) / 3, 0, 1)
    result = a + strength * np.clip(base - a, -2, 2)
    category = np.where(valid & (strength > 0), 1, 0).astype('uint8')
    road = masks['road'].astype(bool) & valid & (slope < 6)
    result[road] = (a + np.clip(base - a, -1, 1))[road]
    category[road] = 3
    water = masks['water'].astype(bool) & valid
    # Water-only support: never average a steep bank or bridge into the water.
    # This is bounded visual smoothing, NOT surveyed hydro-flattening. OMT's
    # class=lake also covers rivers in this dataset, so no whole polygon leveling.
    wet = smooth_valid(a, water, 5)
    wet_delta = np.where(water, np.clip(wet - a, -8, 8), 0)
    result[water] = (a + wet_delta)[water]
    category[water] = 2
    # Preserve islands, narrow levees and banks, including their flat crests.
    # Their low local slope alone must not authorize land-side smoothing.
    near = ndi.maximum_filter(water, size=7) & ~water & valid
    result[near] = a[near]
    category[near] = 0
    result[~valid] = NODATA
    category[~valid] = 0
    return result.astype('float32'), category


def airport_plane(a, inside):
    """Robust local plane; point coordinates are cell indices, not elevations."""
    rows, cols = np.nonzero(inside & np.isfinite(a) & (a != NODATA))
    if len(rows) < 50:
        return None
    step = max(1, len(rows) // 12000)
    rows, cols = rows[::step], cols[::step]
    values = a[rows, cols]
    origin = (float(cols.mean()), float(rows.mean()))
    design = np.column_stack((cols - origin[0], rows - origin[1], np.ones(len(rows))))
    selected = values <= np.percentile(values, 75)
    for _ in range(5):
        fit = np.linalg.lstsq(design[selected], values[selected], rcond=None)[0]
        residual = values - design @ fit
        median = np.median(residual)
        spread = max(.5, float(np.median(np.abs(residual - median))) * 1.4826)
        selected = np.abs(residual - median) < 2.5 * spread
        if selected.sum() < 30:
            return None
    yy, xx = np.indices(a.shape, dtype='float32')
    return fit[0] * (xx - origin[0]) + fit[1] * (yy - origin[1]) + fit[2], fit


def select_group(layer, props, geom_type):
    kind = props.get('class')
    if layer == 'water' and geom_type in ('Polygon', 'MultiPolygon'):
        return 'water'
    if layer == 'waterway' and kind in ('river', 'canal'):
        return 'river'
    if layer == 'aeroway' and kind in ('aerodrome', 'apron', 'runway', 'taxiway'):
        # Only actual polygons: a runway centerline contains no verified width.
        return 'airport' if geom_type in ('Polygon', 'MultiPolygon') else None
    if layer == 'transportation' and kind in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary'):
        if props.get('brunnel') in ('bridge', 'tunnel') or props.get('layer', 0) != 0:
            return None
        return 'road' if geom_type in ('LineString', 'MultiLineString') else None
    return None


def geographic_geometry(geometry, x, y, z, extent):
    n = 2 ** z
    def walk(coords):
        if isinstance(coords[0], (int, float)):
            lon = ((x + coords[0] / extent) / n) * 360 - 180
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + coords[1] / extent) / n))))
            return [lon, lat]
        return [walk(c) for c in coords]
    return {'type': geometry['type'], 'coordinates': walk(geometry['coordinates'])}


def extract_masks(mbtiles, masks, transform, shape, bounds):
    counts = Counter()
    connection = sqlite3.connect(Path(mbtiles).resolve().as_uri() + '?mode=ro', uri=True)
    try:
        z = int(dict(connection.execute('select name,value from metadata'))['maxzoom'])
        if z < 13:
            raise ValueError('Detailed vector tiles are required')
        n = 2 ** z
        def tile(lon, lat):
            return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        west, south, east, north = bounds
        xmin, ymin = tile(west, north); xmax, ymax = tile(east, south)
        query = ('select tile_column,tile_row,tile_data from tiles where zoom_level=? '
                 'and tile_column between ? and ? and tile_row between ? and ? order by tile_column,tile_row')
        for x, tms_y, blob in connection.execute(query, (z, xmin, xmax, n - 1 - ymax, n - 1 - ymin)):
            y = n - 1 - tms_y
            raw = gzip.decompress(blob) if blob[:2] == b'\x1f\x8b' else blob
            proto = vector_tile_pb2.tile(); proto.ParseFromString(raw)
            filtered = vector_tile_pb2.tile()
            for layer in proto.layers:
                if layer.name in LAYERS:
                    filtered.layers.add().CopyFrom(layer)
            decoded = mapbox_vector_tile.decode(filtered.SerializeToString(), default_options={'y_coord_down': True})
            lon0, lon1 = x / n * 360 - 180, (x + 1) / n * 360 - 180
            lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
            lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
            c0, r0 = (~transform) * (lon0, lat0); c1, r1 = (~transform) * (lon1, lat1)
            c0, r0 = max(0, math.floor(c0)), max(0, math.floor(r0))
            c1, r1 = min(shape[1], math.ceil(c1)), min(shape[0], math.ceil(r1))
            if c1 <= c0 or r1 <= r0:
                continue
            groups = {name: [] for name in MASK_NAMES}
            for name, layer in decoded.items():
                for feature in layer['features']:
                    geometry = feature['geometry']; props = feature['properties']
                    group = select_group(name, props, geometry['type'])
                    if group:
                        groups[group].append(geographic_geometry(geometry, x, y, z, layer['extent']))
                        counts[group + '_fragments'] += 1
            tx = transform * Affine.translation(c0, r0)
            for group, geometries in groups.items():
                if geometries:
                    burned = rasterize(((g, 1) for g in geometries), out_shape=(r1-r0, c1-c0),
                                       transform=tx, fill=0, dtype='uint8', all_touched=False)
                    current = masks[group][r0:r1, c0:c1]
                    np.maximum(current, burned, out=current)
            counts['tiles'] += 1
            if counts['tiles'] % 1000 == 0:
                print('vector_tiles', counts['tiles'], flush=True)
    finally:
        connection.close()
    return dict(counts)


def write_tif(path, data, transform, nodata=NODATA, **tags):
    with rasterio.open(path, 'w', driver='GTiff', width=data.shape[1], height=data.shape[0],
                       count=1, crs='EPSG:4326', transform=transform, dtype=data.dtype,
                       nodata=nodata, compress='deflate', predictor=3 if data.dtype.kind == 'f' else 2,
                       tiled=True, blockxsize=256, blockysize=256, BIGTIFF='IF_SAFER') as d:
        d.write(data, 1)
        d.update_tags(AREA_OR_POINT='Point', **tags)
        d.build_overviews([2, 4, 8, 16], rasterio.enums.Resampling.nearest
                          if data.dtype.kind == 'u' else rasterio.enums.Resampling.average)


def validate_geoid(path):
    with rasterio.open(path) as d:
        if (d.crs.to_epsg() not in (4326, 4979) or d.count != 1
                or d.tags().get('target_crs_epsg_code') != '5773'
                or d.descriptions[0] != 'geoid_undulation'):
            raise ValueError('Expected a geographic single-band EGM96 undulation grid')


def build(source, mbtiles, output, geoid):
    source, mbtiles, output = Path(source).resolve(), Path(mbtiles).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError('Choose a new output directory; existing results are never overwritten')
    validate_geoid(geoid)
    files = sorted(source.glob('*.tif'))
    if not files:
        raise ValueError('No DEM GeoTIFFs')
    metadata = [source_metadata(p) for p in files]
    dx, dy = metadata[0]['dx'], metadata[0]['dy']
    if any(abs(m['dx'] - dx) > 1e-12 or abs(m['dy'] - dy) > 1e-12 for m in metadata):
        raise ValueError('Mixed sampling intervals')
    west = min(m['west'] for m in metadata); north = max(m['north'] for m in metadata)
    east = max(m['west'] + (m['width']-1)*dx for m in metadata)
    south = min(m['north'] - (m['height']-1)*dy for m in metadata)
    shape = (round((north-south)/dy)+1, round((east-west)/dx)+1)
    transform = Affine(dx, 0, west-dx/2, 0, -dy, north+dy/2)
    output.mkdir(parents=True); scratch = output / 'build_arrays'; scratch.mkdir()
    rasters = output / 'geotiff'; rasters.mkdir()
    package = output / 'package'; package.mkdir()
    def array(name, dtype, fill=0):
        a = np.lib.format.open_memmap(scratch / (name+'.npy'), mode='w+', dtype=dtype, shape=shape)
        a[:] = fill
        return a
    original = array('original', 'float32', NODATA)
    overlap_max = 0.0
    for path, m in zip(files, metadata):
        row = round((north-m['north'])/dy); col = round((m['west']-west)/dx)
        m.update(row=row, col=col)
        with rasterio.open(path) as d:
            data = d.read(1).astype('float32')
        data[data == m['nodata']] = NODATA
        target = original[row:row+m['height'], col:col+m['width']]
        both = (target != NODATA) & (data != NODATA)
        if both.any():
            overlap_max = max(overlap_max, float(np.max(np.abs(target[both]-data[both]))))
            if overlap_max > 1:
                raise ValueError('Source overlap differs by more than 1 m; inspect inputs before merging')
            data[both] = (target[both] + data[both]) / 2
        np.copyto(target, data, where=data != NODATA)
    original.flush()
    masks = {name: array(name, 'uint8') for name in MASK_NAMES}
    counts = extract_masks(mbtiles, masks, transform, shape, (west, south, east, north))
    for a in masks.values():
        a.flush()
    print('vector_complete', counts, flush=True)
    corrected = array('corrected', 'float32', NODATA)
    category = array('category', 'uint8')
    block, halo = 512, 64
    for row in range(0, shape[0], block):
        r1 = min(shape[0], row+block); r0h = max(0, row-halo); r1h = min(shape[0], r1+halo)
        spacing = (dy*111320, dx*111320*math.cos(math.radians(north-row*dy)))
        for col in range(0, shape[1], block):
            c1 = min(shape[1], col+block); c0h = max(0, col-halo); c1h = min(shape[1], c1+halo)
            patch = np.asarray(original[r0h:r1h, c0h:c1h])
            result, kinds = condition_patch(patch, {k:v[r0h:r1h, c0h:c1h] for k,v in masks.items()}, spacing)
            crop = np.s_[row-r0h:r1-r0h, col-c0h:c1-c0h]
            corrected[row:r1, col:c1] = result[crop]; category[row:r1, col:c1] = kinds[crop]
        print('condition_rows', r1, shape[0], flush=True)
    # Whole connected airport footprints are fitted once, not once per tile.
    labels, number = ndi.label(masks['airport'])
    airport_reports = []
    for label, window in enumerate(ndi.find_objects(labels), 1):
        if window is None:
            continue
        r, c = window
        r0, r1 = max(0,r.start-5), min(shape[0],r.stop+5)
        c0, c1 = max(0,c.start-5), min(shape[1],c.stop+5)
        inside = labels[r0:r1,c0:c1] == label
        a = np.asarray(original[r0:r1,c0:c1])
        model = airport_plane(a, inside)
        if model is None:
            continue
        plane, fit = model
        mx = dx*111320*math.cos(math.radians(north-r0*dy)); my = dy*111320
        if math.hypot(fit[0]/mx,fit[1]/my) > math.tan(math.radians(2)):
            airport_reports.append({'label':label,'skipped':'fitted slope exceeds 2 degrees'})
            continue
        weight = ndi.gaussian_filter(inside.astype('float32'), 1.5)
        valid = (a != NODATA) & (masks['water'][r0:r1,c0:c1] == 0)
        existing = corrected[r0:r1,c0:c1]
        delta = np.clip(plane-a, -12, 12)
        existing[valid] = (existing*(1-weight)+(a+delta)*weight)[valid]
        kinds = category[r0:r1,c0:c1]; kinds[valid & (weight>.05)] = 4
        airport_reports.append({'label':label,'cells':int(inside.sum()),
                                'center':[west+(c0+c1)/2*dx,north-(r0+r1)/2*dy],
                                'fitted_slope_degrees':math.degrees(math.atan(math.hypot(fit[0]/mx,fit[1]/my)))})
    del labels
    corrected.flush(); category.flush()
    write_tif(output/'merged_conditioned_30m.tif', corrected, transform,
              VERTICAL_DATUM='EGM96', PURPOSE='visualization_only')
    grids=[]; summaries=[]
    for m in metadata:
        r,c,h,w=m['row'],m['col'],m['height'],m['width']
        data=np.asarray(corrected[r:r+h,c:c+w]); raw=np.asarray(original[r:r+h,c:c+w])
        valid=raw!=NODATA; delta=np.where(valid,data-raw,0).astype('float32')
        name=Path(m['name']).stem
        tx=transform*Affine.translation(c,r)
        write_tif(rasters/(name+'_conditioned.tif'),data,tx,VERTICAL_DATUM='EGM96',PURPOSE='visualization_only')
        write_tif(rasters/(name+'_change_m.tif'),np.where(valid,delta,NODATA).astype('float32'),tx,VERTICAL_DATUM='difference_metres')
        write_tif(rasters/(name+'_mask.tif'),np.where(valid,category[r:r+h,c:c+w],255).astype('uint8'),tx,nodata=255,
                  CLASSES='0:unchanged,1:gentle_ground,2:water,3:road_centerline,4:airport')
        binpath=package/(name+'.bin');data.astype('<f4').tofile(binpath)
        grids.append(dict(file=binpath.name,dtype='float32',width=w,height=h,west=m['west'],north=m['north'],
                          dx=dx,dy=dy,bounds=[m['west'],m['north']-(h-1)*dy,m['west']+(w-1)*dx,m['north']],nodata=NODATA,sha256=sha(binpath)))
        v=delta[valid]
        summaries.append(dict(source=m['name'],valid_cells=int(valid.sum()),changed_over_10cm=int((np.abs(v)>.1).sum()),
                              change_min=float(v.min()),change_max=float(v.max()),change_abs_p95=float(np.percentile(np.abs(v),95))))
        print('exported',name,flush=True)
    # Keep orthometric heights; the existing LocalDem adds N once at sampling.
    with rasterio.open(geoid) as d:
        # PROJ's NGA grid uses WGS84 3D (4979), with EGM96 target in band metadata.
        a=d.read(1).astype('<f4');a.tofile(package/'geoid.bin');t=d.transform
        gx,gn=t.c+t.a/2,t.f+t.e/2
        geogrid=dict(file='geoid.bin',dtype='float32',width=d.width,height=d.height,west=gx,north=gn,
                     dx=t.a,dy=-t.e,bounds=[gx,gn+(d.height-1)*t.e,gx+(d.width-1)*t.a,gn],nodata=d.nodata,sha256=sha(package/'geoid.bin'))
    manifest=dict(schema_version=1,vertical_datum='egm96',tiles=grids,geoid=geogrid,blend_degrees=.02,
                  datum_note='Source DTED_VerticalDatum=E96; visual corrections retain EGM96; h=H+N at runtime.',
                  geoid_source='https://cdn.proj.org/us_nga_egm96_15.tif',
                  credit='SRTM / USGS; OSM-derived Tilemaker vectors (source attribution must be retained)',
                  purpose='visualization_only_not_survey_or_flight_safety')
    manifest['version']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:16]
    write_json(package/'manifest.json',manifest)
    report=dict(sources=metadata,mbtiles_sha256=sha(mbtiles),geoid_sha256=sha(geoid),shape=shape,
                mosaic=dict(file='merged_conditioned_30m.tif',sha256=sha(output/'merged_conditioned_30m.tif')),
                parameters=dict(gentle_ground_max_change_m=2, water_max_change_m=8,
                                road_max_change_m=1, airport_max_change_m=12,
                                ground_sigma_cells=1.2, water_sigma_cells=5,
                                airport_max_fitted_slope_degrees=2,
                                ground_slope_taper_degrees=[1,4]),
                bounds=[west,south,east,north],source_overlap_max_m=overlap_max,vectors=counts,
                airports=airport_reports,tiles=summaries,
                limitations=['Water is locally smoothed, not flow-enforced or surveyed hydro-flattening.',
                             'Road masks are centerlines at source DEM resolution; width is not inferred.',
                             'NoData and missing source sheets remain missing; no invented coverage.',
                             'This output does not change runtime collision/ground truth or activate itself.'])
    write_json(output/'report.json',report)
    for path,m in zip(files,metadata):
        if sha(path)!=m['sha256']:
            raise RuntimeError('Source changed during build')
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('source','mbtiles','output','geoid'):
        parser.add_argument('--'+name,required=True,type=Path)
    args=parser.parse_args()
    build(args.source,args.mbtiles,args.output,args.geoid)
