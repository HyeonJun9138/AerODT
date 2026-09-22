"""Numerical and scientific-plot QA for condition_dem outputs, without a live server."""
import argparse
import json
import math
from pathlib import Path
import time

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LightSource
import numpy as np
import rasterio
from scipy import ndimage as ndi

from data.terrain.local_dem import LocalDem
from digital_twin.visualization.local_terrain import LocalTerrainTiles
from project_support.tools.condition_dem import NODATA, sha, write_json


def review(directory, baseline=None):
    directory = Path(directory)
    report = json.loads((directory/'report.json').read_text(encoding='utf-8'))
    manifest = json.loads((directory/'package/manifest.json').read_text(encoding='utf-8'))
    original = np.load(directory/'build_arrays/original.npy', mmap_mode='r')
    corrected = np.load(directory/'build_arrays/corrected.npy', mmap_mode='r')
    previous = None
    if baseline:
        baseline=Path(baseline)
        previous_report=json.loads((baseline/'report.json').read_text(encoding='utf-8'))
        assert previous_report['bounds']==report['bounds']
        assert [s['sha256'] for s in previous_report['sources']]==[s['sha256'] for s in report['sources']]
        previous=np.load(baseline/'build_arrays/corrected.npy',mmap_mode='r')
        assert previous.shape==corrected.shape
    assert original.shape == corrected.shape == tuple(report['shape'])
    valid_count = changed_count = 0
    maximum_change = 0.
    exclusions = None
    if report.get('profile')=='urban_strong':
        exclusions={k:np.load(directory/'build_arrays'/(k+'.npy'),mmap_mode='r')
                    for k in ('natural','structure','water')}
    for row in range(0, len(original), 256):
        a = original[row:row+256]; b = corrected[row:row+256]
        valid = a != NODATA
        assert np.array_equal(valid, b != NODATA), 'NoData coverage changed'
        assert np.isfinite(b).all()
        if exclusions is not None:
            protected=((exclusions['natural'][row:row+256]>0) | (exclusions['structure'][row:row+256]>0))
            protected &= valid & (exclusions['water'][row:row+256]==0)
            assert np.array_equal(a[protected],b[protected]), 'Mapped protected ground changed'
        delta = np.abs(b[valid]-a[valid])
        maximum_change = max(maximum_change, float(delta.max(initial=0)))
        valid_count += int(valid.sum()); changed_count += int((delta > .1).sum())
    assert maximum_change <= max(v for k,v in report['parameters'].items() if k.endswith('_max_change_m')) + .001
    mosaic = directory/report['mosaic']['file']
    assert sha(mosaic) == report['mosaic']['sha256']
    with rasterio.open(mosaic) as d:
        assert d.shape == corrected.shape
        for row in range(0,len(corrected),256):
            height=min(256,len(corrected)-row)
            assert np.array_equal(d.read(1,window=rasterio.windows.Window(0,row,d.width,height)),
                                  corrected[row:row+height])
    for grid in manifest['tiles']+[manifest['geoid']]:
        assert sha(directory/'package'/grid['file']) == grid['sha256']
    seams = []
    for index, first in enumerate(manifest['tiles']):
        for second in manifest['tiles'][index+1:]:
            w,s,e,n = first['bounds']; w2,s2,e2,n2 = second['bounds']
            a = np.memmap(directory/'package'/first['file'], dtype='<f4', mode='r', shape=(first['height'],first['width']))
            b = np.memmap(directory/'package'/second['file'], dtype='<f4', mode='r', shape=(second['height'],second['width']))
            pair = None
            if abs(e-w2)<1e-8 and abs(n-n2)<1e-8:
                pair = a[:,-1], b[:,0]
            elif abs(n-s2)<1e-8 and abs(w-w2)<1e-8:
                pair = a[0,:], b[-1,:]
            if pair is not None:
                assert np.array_equal(*pair), 'Shared source edge is discontinuous'
                seams.append([first['file'], second['file']])
    # Verify package bytes agree with the GeoTIFF exports, not just array previews.
    for grid in manifest['tiles']:
        with rasterio.open(directory/'geotiff'/(Path(grid['file']).stem+'_conditioned.tif')) as d:
            a = np.memmap(directory/'package'/grid['file'],dtype='<f4',mode='r',shape=(grid['height'],grid['width']))
            assert np.array_equal(d.read(1),a)

    west,south,east,north = report['bounds']; dx=report['sources'][0]['dx'];dy=report['sources'][0]['dy']
    qa = directory/'qa';qa.mkdir(exist_ok=True)
    regions = []
    regions_to_review = [
        ('Gimpo airport', (126.76,37.53,126.825,37.59), 'airport'),
        ('Han River', (126.90,37.51,126.97,37.56), 'water'),
        ('Bukhansan', (126.96,37.64,127.02,37.70), None),
    ]
    if report.get('profile')=='urban_strong':
        regions_to_review += [('Gangnam urban', (127.01,37.48,127.065,37.525),'urban'),
                             ('Yeouido urban', (126.90,37.515,126.95,37.545),'urban'),
                             ('Gangnam roads', (127.01,37.48,127.065,37.525),'road'),
                             ('Yeouido roads', (126.90,37.515,126.95,37.545),'road'),
                             ('Han riverside ground roads', (126.88,37.50,127.06,37.57),'riverside_road')]
    for name, bounds, kind in regions_to_review:
        w,s,e,n=bounds
        r0,r1=round((north-n)/dy),round((north-s)/dy)
        c0,c1=round((w-west)/dx),round((e-west)/dx)
        sl=np.s_[r0:r1,c0:c1];a=original[sl];b=corrected[sl]
        if kind == 'riverside_road':
            mask = np.load(directory/'build_arrays/road.npy',mmap_mode='r')[sl]>0
            water = np.load(directory/'build_arrays/water.npy',mmap_mode='r')[sl]>0
            spacing=(dy*111320,dx*111320*math.cos(math.radians((s+n)/2)))
            mask &= (ndi.distance_transform_edt(~water,sampling=spacing)<=150) & ~water
            for excluded in ('structure','natural'):
                mask &= np.load(directory/'build_arrays'/(excluded+'.npy'),mmap_mode='r')[sl]==0
        else:
            mask = np.ones(a.shape,dtype=bool) if kind is None else np.load(directory/'build_arrays'/(kind+'.npy'),mmap_mode='r')[sl]>0
        if kind and kind not in ('road','riverside_road'):
            mask=ndi.binary_erosion(mask,iterations=2)
        mask &= a!=NODATA
        before=float(np.sqrt(np.mean((a-ndi.gaussian_filter(a,1.2))[mask]**2)))
        after=float(np.sqrt(np.mean((b-ndi.gaussian_filter(b,1.2))[mask]**2)))
        regions.append(dict(name=name,bounds=bounds,mask=kind or 'all',cells=int(mask.sum()),
                            roughness_before_m=before,roughness_after_m=after,
                            roughness_reduction_percent=100*(1-after/before) if before else 0,
                            before_range_m=[float(a[mask].min()),float(a[mask].max())],
                            after_range_m=[float(b[mask].min()),float(b[mask].max())]))
        if previous is not None:
            old=previous[sl]
            old_rms=float(np.sqrt(np.mean((old-ndi.gaussian_filter(old,1.2))[mask]**2)))
            regions[-1].update(previous_roughness_m=old_rms,
                              reduction_from_previous_percent=100*(1-after/old_rms) if old_rms else 0)
        fig,axes=plt.subplots(1,3,figsize=(15,5),constrained_layout=True)
        spacing_x=dx*111320*math.cos(math.radians((s+n)/2));spacing_y=dy*111320
        lighting=LightSource(azdeg=315,altdeg=35)
        low,high=float(a.min()),float(a.max())
        for ax,z,title in zip(axes[:2],[a,b],['Original SRTM','Conditioned (same scale)']):
            ax.imshow(lighting.shade(z,cmap=plt.get_cmap('terrain'),vert_exag=1,
                      dx=spacing_x,dy=spacing_y,vmin=low,vmax=high),extent=[w,e,s,n],aspect='auto')
            if kind:
                ax.contour(mask,levels=[.5],colors=['cyan'],linewidths=.5,extent=[w,e,s,n],origin='upper')
            ax.set_title(title)
        color_limit=80 if report.get('profile')=='urban_strong' else 12
        im=axes[2].imshow(b-a,cmap='RdBu_r',vmin=-color_limit,vmax=color_limit,extent=[w,e,s,n],aspect='auto')
        axes[2].set_title('Height change (m)');fig.colorbar(im,ax=axes[2],shrink=.8)
        for ax in axes:
            ax.set_xlabel('Longitude');ax.set_ylabel('Latitude');ax.ticklabel_format(useOffset=False)
        fig.suptitle(f'{name} | high-frequency RMS: {before:.2f} -> {after:.2f} m\n'
                     'Visual conditioning, not surveyed terrain. Cyan: evaluation mask.',fontsize=12)
        fig.savefig(qa/(name.lower().replace(' ','_')+'.png'),dpi=140);plt.close(fig)

    dem=LocalDem(directory/'package');terrain=LocalTerrainTiles(dem)
    samples=[]
    for lon,lat in [(126.7906,37.5583),(126.93,37.54),(126.99,37.67),(127.,37.5)]:
        height,weight=dem.sample(lon,lat)
        grid=next(g for g in dem.tiles if dem._contains(g,lon,lat))
        orthometric=dem._sample(grid,lon,lat);undulation=dem._sample(dem.manifest['geoid'],lon,lat)
        assert abs(height-orthometric-undulation)<1e-6 and weight==1
        samples.append(dict(lon=lon,lat=lat,orthometric_m=orthometric,undulation_m=undulation,ellipsoid_m=height))
    assert dem.sample(129.5,38.5)==(0,0), 'Missing northeast source tile invented'
    tile_timings=[]
    for level in (12,14):
        step=180/2**level;x=int((126.79+180)/step);y=int((90-37.56)/step)
        started=time.perf_counter();blob=terrain.tile(level,x,y);elapsed=time.perf_counter()-started
        assert len(blob)==65*65*2*4
        assert np.isfinite(np.frombuffer(blob,dtype='<f4')).all()
        tile_timings.append(dict(level=level,bytes=len(blob),cold_seconds=elapsed))
    result=dict(valid_cells=valid_count,changed_over_10cm=changed_count,max_abs_change_m=maximum_change,
                matching_shared_edges=len(seams),package_hashes_verified=True,geotiff_matches_package=True,
                merged_geotiff_matches_arrays=True,
                nodata_preserved=True,regions=regions,samples=samples,tile_generation=tile_timings,
                mapped_exclusions_preserved=exclusions is not None,
                live_dashboard_tested=False)
    write_json(qa/'validation.json',result)
    print(json.dumps(result,indent=2))
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path)
    p.add_argument('--baseline',type=Path)
    args=p.parse_args();review(args.directory,args.baseline)
