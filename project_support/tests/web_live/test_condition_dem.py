"""Offline conditioning contracts; optional build dependencies, no live server."""
import numpy as np
import pytest

pytest.importorskip('scipy')
pytest.importorskip('mapbox_vector_tile')
from project_support.tools.condition_dem import (
    NODATA, airport_plane, condition_patch, geographic_geometry, select_group,
)


def masks(shape):
    return {k:np.zeros(shape,dtype='uint8') for k in ('water','river','airport','road')}


def test_preserves_nodata_and_caps_flat_ground_correction():
    a=np.full((81,81),20,dtype='float32');a[40,40]=30;a[0,0]=NODATA
    result,_=condition_patch(a,masks(a.shape),(30,30))
    assert result[0,0]==NODATA
    assert 28<=result[40,40]<30
    assert np.max(np.abs(result[a!=NODATA]-a[a!=NODATA]))<=2.00001


def test_water_smoothing_excludes_high_banks_and_preserves_islands():
    a=np.full((81,81),150,dtype='float32');m=masks(a.shape)
    m['water'][20:60,:]=1;a[20:60,:]=10;a[40,40]=16
    m['water'][35:38,35:38]=0;a[35:38,35:38]=80
    result,_=condition_patch(a,m,(30,30))
    assert 10<=result[40,40]<11
    assert result[36,36]==80
    assert result[0,40]==150
    assert np.max(np.abs(result-a))<=8.00001


def test_flat_slope_is_not_made_horizontal_and_mountains_are_unchanged():
    y,x=np.indices((81,81),dtype='float32')
    a=10+.3*x+.2*y
    result,_=condition_patch(a,masks(a.shape),(30,30))
    np.testing.assert_allclose(result[10:-10,10:-10],a[10:-10,10:-10],atol=1e-5)
    mountain=10+8*x;mountain[40,40]+=3
    result,_=condition_patch(mountain,masks(a.shape),(30,30))
    np.testing.assert_array_equal(result[10:-10,10:-10],mountain[10:-10,10:-10])


def test_block_halo_agrees_with_whole_processing():
    a=np.random.default_rng(5).normal(20,.5,(180,180)).astype('float32');m=masks(a.shape)
    m['water'][50:130,:]=1
    whole,_=condition_patch(a,m,(30,30))
    for r0,r1 in [(0,90),(90,180)]:
        lo=max(0,r0-64);hi=min(180,r1+64)
        part,_=condition_patch(a[lo:hi],{k:v[lo:hi] for k,v in m.items()},(30,30))
        np.testing.assert_allclose(part[r0-lo:r1-lo],whole[r0:r1],atol=1e-5)


def test_airport_plane_rejects_building_outliers_and_retains_grade():
    y,x=np.indices((100,100),dtype='float32');a=18+.03*x-.02*y
    a[10:25,10:25]+=25
    plane,fit=airport_plane(a,np.ones(a.shape,dtype=bool))
    np.testing.assert_allclose(fit[:2],[.03,-.02],atol=1e-6)
    assert abs(plane[50,50]-18.5)<1e-5


def test_bridge_tunnel_rail_and_runway_without_width_are_not_ground_masks():
    for prop in ({'brunnel':'bridge'},{'brunnel':'tunnel'},{'layer':1},{'layer':-1}):
        assert select_group('transportation',{'class':'primary',**prop},'LineString') is None
    assert select_group('transportation',{'class':'rail'},'LineString') is None
    assert select_group('aeroway',{'class':'runway'},'LineString') is None
    assert select_group('aeroway',{'class':'apron'},'Polygon')=='airport'
    assert select_group('water',{'class':'lake'},'Polygon')=='water'


def test_mvt_northwest_coordinate_and_latitude_orientation():
    g=geographic_geometry({'type':'LineString','coordinates':[[0,0],[4096,4096]]},0,0,1,4096)
    assert g['coordinates'][0][0]==-180
    assert g['coordinates'][0][1]==pytest.approx(85.0511287798)
    assert g['coordinates'][1]==[0,0]


def test_build_accepts_nga_4979_and_exports_joined_runtime_package(tmp_path):
    import sqlite3
    import rasterio
    from rasterio.transform import Affine
    from project_support.tools.condition_dem import build
    from data.terrain.local_dem import LocalDem

    source=tmp_path/'input';source.mkdir()
    dx=1/3600
    for index in range(2):
        tx=Affine(dx,0,126+index*64*dx-dx/2,0,-dx,38+dx/2)
        with rasterio.open(source/f'{index}.tif','w',driver='GTiff',width=65,height=65,
                           count=1,crs='EPSG:4326',transform=tx,dtype='int16',nodata=-32767) as d:
            d.write(np.full((65,65),20,dtype='int16'),1)
            d.update_tags(AREA_OR_POINT='Point',DTED_VerticalDatum='E96')
    geoid=tmp_path/'geoid.tif'
    with rasterio.open(geoid,'w',driver='GTiff',width=20,height=20,count=1,
                       crs='EPSG:4979',transform=Affine(.1,0,125.5,0,-.1,38.5),dtype='float32') as d:
        d.write(np.full((20,20),25,dtype='float32'),1)
        d.update_tags(target_crs_epsg_code='5773')
        d.set_band_description(1,'geoid_undulation')
    mbtiles=tmp_path/'vectors.mbtiles'
    with sqlite3.connect(mbtiles) as c:
        c.execute('create table metadata (name text,value text)')
        c.execute("insert into metadata values ('maxzoom','14')")
        c.execute('create table tiles (zoom_level integer,tile_column integer,tile_row integer,tile_data blob)')
    output=tmp_path/'result'
    report=build(source,mbtiles,output,geoid)
    assert report['source_overlap_max_m']==0
    dem=LocalDem(output/'package')
    assert dem.sample(126+64*dx,38-32*dx)[0]==pytest.approx(45)
    with rasterio.open(output/'geotiff/0_conditioned.tif') as a, rasterio.open(output/'geotiff/1_conditioned.tif') as b:
        np.testing.assert_array_equal(a.read(1)[:,-1],b.read(1)[:,0])
    with pytest.raises(ValueError,match='existing results'):
        build(source,mbtiles,output,geoid)
