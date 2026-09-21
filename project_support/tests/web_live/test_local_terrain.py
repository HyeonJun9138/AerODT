import json
import struct
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from data.terrain.local_dem import LocalDem
from digital_twin.visualization.local_terrain import LocalTerrainTiles
from communication.web.local_terrain_routes import create_local_terrain_router
from user_application.apps.web_dashboard.library_settings import validate_settings, describe_library


def package(tmp_path, *, missing=False):
    grid=dict(file='height.bin',dtype='int16',width=3,height=3,west=126,north=38,
              dx=.5,dy=.5,bounds=[126,37,127,38],nodata=-32767)
    values=[100,110,120,110,120,130,120,130,140]
    if missing: values[4]=-32767
    (tmp_path/'height.bin').write_bytes(struct.pack('<9h',*values))
    (tmp_path/'geoid.bin').write_bytes(struct.pack('<9f',*[25]*9))
    geo={**grid,'file':'geoid.bin','dtype':'float32','nodata':None}
    (tmp_path/'manifest.json').write_text(json.dumps(dict(schema_version=1,vertical_datum='egm96',
        tiles=[grid],geoid=geo,version='test',blend_degrees=.02)))
    return LocalDem(tmp_path)


def test_bilinear_and_geoid_sign_edges_and_missing(tmp_path):
    dem=package(tmp_path)
    try:
        assert dem.sample(126.5,37.5)==(145,1)
        assert dem.sample(126.25,37.75)==(135,1)
        assert dem.sample(125.9,37.5)==(0,0)
        assert dem.sample(126,37.5)==(135,0)
        assert dem.sample(126.01,37.5)[1]==pytest.approx(.5)
    finally: dem.close()
    dem=package(tmp_path,missing=True)
    try: assert dem.sample(126.5,37.5)==(0,0)
    finally: dem.close()


def test_router_bounds_payload_cache_and_same_origin(tmp_path):
    dem=package(tmp_path);tiles=LocalTerrainTiles(dem)
    app=FastAPI();app.include_router(create_local_terrain_router(tiles));client=TestClient(app)
    base='/api/visualization/terrain/local'
    meta=client.get(base).json()
    assert meta['width']==65 and meta['vertical_datum']=='WGS84 ellipsoid'
    assert str(tmp_path) not in json.dumps(meta)
    level=10;x=int((126.5+180)/(180/2**level));y=int((90-37.5)/(180/2**level))
    path=f'{base}/{level}/{x}/{y}'
    response=client.get(path)
    assert response.status_code==200 and len(response.content)==65*65*8
    heights=struct.unpack('<8450f',response.content)
    assert all(130<h<160 for h in heights[:4225])
    assert all(w==1 for w in heights[4225:])
    assert client.get(path).content==response.content
    assert len(tiles.cache)==1
    assert client.get(f'{base}/14/0/0').status_code==204
    for level,x,y in [(15,1,1),(5,1,1),(10,-1,1),(10,2048,1),(10,1,1024)]:
        assert client.get(f'{base}/{level}/{x}/{y}').status_code==400
    assert client.get(path,headers={'Origin':'https://wrong.example'}).status_code==403
    assert client.get(base,headers={'Sec-Fetch-Site':'cross-site'}).status_code==403
    dem.close()


def test_invalid_package_fails_closed(tmp_path):
    dem=package(tmp_path);dem.close()
    (tmp_path/'height.bin').write_bytes(b'x')
    with pytest.raises(ValueError):LocalDem(tmp_path)


@pytest.mark.parametrize('blend',[0,-1,float('nan'),float('inf'),2])
def test_invalid_blend_fails_closed(tmp_path,blend):
    dem=package(tmp_path);dem.close()
    path=tmp_path/'manifest.json';manifest=json.loads(path.read_text())
    manifest['blend_degrees']=blend;path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):LocalDem(tmp_path)


def test_disabled_package_and_provider_settings():
    app=FastAPI();app.include_router(create_local_terrain_router(None));client=TestClient(app)
    assert client.get('/api/visualization/terrain/local').json()['enabled'] is False
    assert client.get('/api/visualization/terrain/local/10/1/1').status_code==404
    settings=validate_settings({'sources':{'terrain':{'provider':'local_dem'}}})
    assert settings['sources']['terrain']['provider']=='local_dem'
    assert settings['sources']['terrain']['enabled'] is True
    with pytest.raises(ValueError):validate_settings({'sources':{'terrain':{'provider':'file:///private'}}})
    terrain=next(s for s in describe_library()['sources'] if s['id']=='terrain')
    assert len(next(f for f in terrain['fields'] if f['name']=='provider')['choices'])==2


def test_adjacent_source_boundary_not_feathered(tmp_path):
    dem=package(tmp_path);dem.close()
    path=tmp_path/'manifest.json';m=json.loads(path.read_text())
    m['vertical_datum']='ellipsoid'
    m['tiles'].append({**m['tiles'][0],'west':127,'bounds':[127,37,128,38]})
    path.write_text(json.dumps(m));dem=LocalDem(tmp_path)
    try:
        assert dem.sample(127,37.5)[1]==1
        assert dem.sample(127.001,37.5)[1]==1
    finally:dem.close()
