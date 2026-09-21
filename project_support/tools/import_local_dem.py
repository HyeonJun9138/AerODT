"""Prepare user GeoTIFFs once, without changing them. Runtime needs no GDAL.

Usage: python -m project_support.tools.import_local_dem --source <directory>
  --output data/workspace/terrain/user_dem --vertical-datum egm96 --geoid <tif>
The datum must be explicitly supplied: many SRTM exports omit vertical CRS.
Build-time dependencies: Pillow and numpy (not needed by the web server).
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image


def convert(path, output, name, dtype):
    with Image.open(path) as image:
        keys=image.tag_v2.get(34735, ())
        parsed={keys[i]:keys[i+3] for i in range(4,len(keys),4) if keys[i+1]==0}
        if parsed.get(2048)!=4326 or parsed.get(1025)!=2:
            raise ValueError('Expected WGS84 PixelIsPoint GeoTIFF')
        dx,dy,_=image.tag_v2[33550]
        tie=image.tag_v2[33922]; west,north=tie[3]-tie[0]*dx,tie[4]+tie[1]*dy
        w,h=image.size
        raw=np.asarray(image)
        if dtype=='int16' and (not np.issubdtype(raw.dtype,np.integer) or raw.min() < -32768 or raw.max() > 32767):
            raise ValueError('DEM requires signed 16-bit metre samples; refusing lossy conversion')
        values=raw.astype('<i2' if dtype=='int16' else '<f4')
        nodata=image.tag_v2.get(42113)
        nodata=float(nodata) if nodata else None
        data=values.tobytes()
    (output/name).write_bytes(data)
    return {'file':name,'dtype':dtype,'width':w,'height':h,'west':west,'north':north,
            'dx':dx,'dy':dy,'bounds':[west,north-(h-1)*dy,west+(w-1)*dx,north],
            'nodata':nodata,'sha256':hashlib.sha256(data).hexdigest(),
            'source_name':path.name,'source_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--vertical-datum',choices=['egm96','ellipsoid'],required=True)
    parser.add_argument('--geoid',type=Path)
    args=parser.parse_args()
    if args.output.exists():raise ValueError('Output already exists; choose a new package directory')
    files=sorted(args.source.glob('*.tif'))
    if not files:raise ValueError('No source TIFFs')
    if args.vertical_datum=='egm96' and not args.geoid:raise ValueError('EGM96 needs a geoid grid')
    args.output.mkdir(parents=True)
    tiles=[convert(p,args.output,f'tile_{i:03d}.bin','int16') for i,p in enumerate(files)]
    manifest={'schema_version':1,'vertical_datum':args.vertical_datum,'blend_degrees':.02,'tiles':tiles,
              'datum_note':'수직 CRS 미표기: SRTM v3 파일명 기준 EGM96 가정. 측량용 사용 전 원자료 확인 필요.'
                           if args.vertical_datum=='egm96' else 'Importer-selected ellipsoidal heights'}
    if args.geoid:
        manifest['geoid']=convert(args.geoid,args.output,'geoid.bin','float32')
        manifest['geoid_source']='https://cdn.proj.org/us_nga_egm96_15.tif (NGA/PROJ, Public Domain)'
    manifest['version']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()[:16]
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf-8')
    print(f'Prepared {len(tiles)} rasters in {args.output}')


if __name__=='__main__':main()
