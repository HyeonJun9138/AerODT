"""Offline conditioning contracts; optional build dependencies, no live server."""
import numpy as np
import pytest

pytest.importorskip('scipy')
pytest.importorskip('mapbox_vector_tile')
from project_support.tools.condition_dem import (
    NODATA, URBAN_MASK_NAMES, airport_plane, condition_patch, condition_urban_patch, geographic_geometry, select_group,
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
    assert geographic_geometry({'type':'Polygon','coordinates':[]},0,0,1,4096)['coordinates']==[]


@pytest.mark.parametrize('profile',['conservative','urban_strong'])
def test_build_accepts_nga_4979_and_exports_joined_runtime_package(tmp_path,profile):
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
    report=build(source,mbtiles,output,geoid,profile)
    assert report['profile']==profile
    assert report['source_overlap_max_m']==0
    dem=LocalDem(output/'package')
    assert dem.sample(126+64*dx,38-32*dx)[0]==pytest.approx(45)
    with rasterio.open(output/'geotiff/0_conditioned.tif') as a, rasterio.open(output/'geotiff/1_conditioned.tif') as b:
        np.testing.assert_array_equal(a.read(1)[:,-1],b.read(1)[:,0])
    with pytest.raises(ValueError,match='existing results'):
        build(source,mbtiles,output,geoid)
    dem.close()
    reused=tmp_path/'reused'
    again=build(source,mbtiles,reused,geoid,profile,reuse_masks=output)
    assert again['tiles']==report['tiles']
    mask_file=output/'build_arrays/road.npy'
    mask=np.load(mask_file,mmap_mode='r+');mask[0,0]=1;mask.flush();del mask
    with pytest.raises(ValueError,match='Mask cache hash mismatch'):
        build(source,mbtiles,tmp_path/'tampered',geoid,profile,reuse_masks=output)


def test_strong_urban_removes_surface_bumps_and_pits_without_using_roof_as_ground():
    a=np.full((181,181),20,dtype='float32')
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES}
    m['urban'][30:150,30:150]=1;m['building'][75:90,75:90]=1
    a[75:90,75:90]=85;a[105:108,105:108]=-20
    result,_=condition_urban_patch(a,m,(30,30))
    assert np.max(np.abs(result[75:90,75:90]-20))<1
    assert result[106,106]>18
    assert np.max(np.abs(result-a))<=80


def test_strong_urban_preserves_grade_and_forest_structure_and_shore():
    y,x=np.indices((181,181),dtype='float32');a=20+.15*x+.2*y
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES};m['urban'][:]=1
    result,_=condition_urban_patch(a,m,(30,30))
    np.testing.assert_allclose(result[50:-50,50:-50],a[50:-50,50:-50],atol=.001)
    for name in ('natural','structure'):
        m[name][70:80,70:80]=1;a[70:80,70:80]+=40
        result,_=condition_urban_patch(a,m,(30,30))
        np.testing.assert_array_equal(result[70:80,70:80],a[70:80,70:80])
    m['water'][110:130,:]=1;a[110:130,:]=5;a[108,:]=50
    result,_=condition_urban_patch(a,m,(30,30))
    np.testing.assert_array_equal(result[108],a[108])


def test_strong_urban_nodata_and_halo_agree():
    a=np.random.default_rng(4).normal(20,4,(300,240)).astype('float32');a[:,:20]=NODATA
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES}
    m['urban'][90:220,50:190]=1;m['road'][:,100]=1;m['building'][150:175,120:135]=1
    whole,_=condition_urban_patch(a,m,(30,30))
    assert np.array_equal(whole==NODATA,a==NODATA)
    for start,end in ((0,150),(150,300)):
        lo=max(0,start-96);hi=min(300,end+96)
        part,_=condition_urban_patch(a[lo:hi],{k:v[lo:hi] for k,v in m.items()},(30,30))
        np.testing.assert_allclose(part[start-lo:end-lo],whole[start:end],atol=1e-4)


def test_strong_masks_include_ordinary_roads_buildings_and_landuse_but_guard_bridges():
    assert select_group('transportation',{'class':'minor'},'LineString','urban_strong')=='road'
    assert select_group('transportation',{'class':'minor','brunnel':'bridge'},'LineString','urban_strong')=='structure'
    assert select_group('building',{'render_height':80},'Polygon','urban_strong')=='building'
    assert select_group('landuse',{'class':'residential'},'Polygon','urban_strong')=='urban'
    assert select_group('landcover',{'class':'wood'},'Polygon','urban_strong')=='natural'


def test_strong_road_corridor_and_large_change_limit():
    a=np.full((181,181),20,dtype='float32');m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES}
    m['road'][:,90]=1;a[70:73,90]=70
    result,_=condition_urban_patch(a,m,(30,30))
    assert result[71,90]<25
    m['urban'][50:130,50:130]=1;m['building'][75:85,75:85]=1;a[75:85,75:85]=200
    result,_=condition_urban_patch(a,m,(30,30))
    assert result[80,80]>=120
    assert np.max(np.abs(result-a))<=80.001


def test_strong_does_not_turn_nodata_edge_into_a_depression():
    a=np.full((181,181),20,dtype='float32');a[:,:80]=NODATA
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES};m['urban'][:]=1
    result,_=condition_urban_patch(a,m,(30,30))
    np.testing.assert_allclose(result[:,80:],20,atol=.001)


def test_empty_building_vector_fragment_is_counted_and_skipped(tmp_path):
    import math
    import sqlite3
    from rasterio.transform import Affine
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    from project_support.tools.condition_dem import extract_masks
    proto=vector_tile_pb2.tile();layer=proto.layers.add();layer.name='building';layer.version=2;layer.extent=4096
    feature=layer.features.add();feature.type=3
    path=tmp_path/'empty.mbtiles';z=14;n=2**z
    lon,lat=126.005,37.995;x=int((lon+180)/360*n)
    y=int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n)
    with sqlite3.connect(path) as c:
        c.execute('create table metadata (name text,value text)');c.execute("insert into metadata values ('maxzoom','14')")
        c.execute('create table tiles (zoom_level integer,tile_column integer,tile_row integer,tile_data blob)')
        c.execute('insert into tiles values (?,?,?,?)',(z,x,n-1-y,proto.SerializeToString()))
    m={k:np.zeros((37,37),dtype='uint8') for k in URBAN_MASK_NAMES};dx=1/3600
    counts=extract_masks(path,m,Affine(dx,0,126-dx/2,0,-dx,38+dx/2),(37,37),(126,37.99,126.01,38),'urban_strong')
    assert counts['invalid_geometry_fragments_skipped']==1
    assert not m['building'].any()


def test_subsurface_transport_does_not_freeze_surface_dem_artefacts():
    for kind in ('transit', 'rail', 'primary', 'path'):
        for props in ({'brunnel':'tunnel'}, {'layer':-1}, {'layer':-6}):
            assert select_group('transportation', {'class':kind, **props}, 'LineString', 'urban_strong') is None
    assert select_group('transportation', {'class':'primary', 'brunnel':'bridge', 'layer':1}, 'LineString', 'urban_strong') == 'structure'


def test_mapped_riverside_road_is_released_but_immediate_bank_stays():
    a=np.full((201,201),20,dtype='float32')
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES}
    m['water'][:70,:]=1;a[:70,:]=5
    m['road'][72,:]=1;a[72,90:110]=45
    a[70,:]=30
    b,_=condition_urban_patch(a,m,(30,30))
    assert b[72,100]<a[72,100]
    np.testing.assert_array_equal(b[70],a[70])
    np.testing.assert_array_equal(b[20],a[20])


def test_dense_building_surroundings_and_extended_filter_halo():
    y,x=np.indices((420,300),dtype='float32');a=20+.03*x+.02*y
    m={k:np.zeros(a.shape,dtype='uint8') for k in URBAN_MASK_NAMES}
    m['urban'][90:330,60:240]=1
    for r in range(160,230,8):
        for c in range(110,170,8):
            m['building'][r:r+3,c:c+3]=1
    a[155:235,105:175]+=30
    a[190:200,140:150]+=25
    whole,_=condition_urban_patch(a,m,(30,30))
    assert whole[190,140]<a[190,140]-15
    for start,end in ((0,210),(210,420)):
        lo=max(0,start-96);hi=min(420,end+96)
        part,_=condition_urban_patch(a[lo:hi],{k:v[lo:hi] for k,v in m.items()},(30,30))
        np.testing.assert_allclose(part[start-lo:end-lo],whole[start:end],atol=1e-4)
