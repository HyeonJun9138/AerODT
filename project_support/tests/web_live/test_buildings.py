import asyncio
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.external.cesium_buildings import BuildingEndpoint
from communication.web.building_routes import create_building_router
from user_application.apps.web_dashboard.credentials import configure_cesium


def test_root_token_stays_server_side_and_asset_is_fixed():
    def handle(request):
        assert str(request.url) == 'https://api.cesium.com/v1/assets/96188/endpoint'
        assert request.headers['Authorization'] == 'Bearer root-secret'
        return httpx.Response(200,json={'type':'3DTILES','url':'https://assets.cesium.com/96188/tileset.json','accessToken':'temporary-asset-token','attributions':[],'extra':'omit'})
    endpoint=BuildingEndpoint('root-secret',transport=httpx.MockTransport(handle))
    data=asyncio.run(endpoint.fetch())
    assert data['accessToken']=='temporary-asset-token'
    assert 'root-secret' not in str(data) and 'extra' not in data


def test_route_blocks_cross_origin_and_sanitizes_failures():
    calls=[]
    async def fetch():
        calls.append(1)
        raise ValueError('root-secret')
    app=FastAPI();app.include_router(create_building_router(fetch))
    with TestClient(app) as client:
        assert client.get('/api/visualization/buildings/endpoint',headers={'Origin':'https://evil.example'}).status_code==403
        assert not calls
        response=client.get('/api/visualization/buildings/endpoint')
        assert response.status_code==503
        assert 'root-secret' not in response.text
        assert response.headers['cache-control']=='no-store'


def test_disabled_and_credentials(tmp_path):
    app=FastAPI();app.include_router(create_building_router(None))
    with TestClient(app) as client:
        assert client.get('/api/visualization/buildings/endpoint').status_code==404
    path=tmp_path/'cesium.json';path.write_text('{"accessToken":"test-secret"}')
    env={};configure_cesium(path,env)
    assert env['AERODT_CESIUM_ION_TOKEN']=='test-secret'
