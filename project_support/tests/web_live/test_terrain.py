import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from user_application.apps.web_dashboard.application import create_app


def terrain_payload(**changes):
    return dict(type='TERRAIN', url='https://assets.ion.cesium.com/1/',
                accessToken='temporary-terrain-token',
                attributions=[{'html': 'Terrain attribution', 'collapsible': True}],
                **changes)


def test_application_exposes_fixed_terrain_without_starting_live_sources(tmp_path, monkeypatch):
    monkeypatch.setenv('AERODT_CESIUM_ION_TOKEN', 'root-secret')
    original = httpx.AsyncClient
    requests = []

    def handle(request):
        requests.append(request)
        assert str(request.url) == 'https://api.cesium.com/v1/assets/1/endpoint'
        assert request.headers['Authorization'] == 'Bearer root-secret'
        return httpx.Response(200, json=terrain_payload(extra='omit'))

    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(
        **{**kwargs, 'transport': httpx.MockTransport(handle)}))
    app = create_app({'cache_directory': str(tmp_path), 'buildings_enabled': True}, sources=[])
    assert not requests
    # Do not enter lifespan: this exercises only the visualization composition.
    client = TestClient(app)
    response = client.get('/api/visualization/terrain/endpoint?assetId=99&url=https://evil.example')
    assert response.status_code == 200
    assert response.json() == terrain_payload()
    assert 'root-secret' not in response.text
    assert response.headers['cache-control'] == 'no-store'
    assert len(requests) == 1


def test_terrain_route_blocks_cross_site_and_sanitizes_errors():
    from communication.web.terrain_routes import create_terrain_router
    calls = []

    async def failed():
        calls.append(1)
        raise ValueError('root-secret')

    app = FastAPI()
    app.include_router(create_terrain_router(failed))
    client = TestClient(app)
    path = '/api/visualization/terrain/endpoint'
    for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
        response = client.get(path, headers=headers)
        assert response.status_code == 403
        assert response.headers['cache-control'] == 'no-store'
    assert calls == []
    response = client.get(path, headers={'Origin': 'http://testserver'})
    assert response.status_code == 503
    assert 'root-secret' not in response.text
    assert response.headers['cache-control'] == 'no-store'


def test_terrain_is_disabled_without_token_or_when_explicitly_disabled(tmp_path, monkeypatch):
    monkeypatch.delenv('AERODT_CESIUM_ION_TOKEN', raising=False)
    settings = {'cache_directory': str(tmp_path), 'buildings_enabled': True}
    response = TestClient(create_app(settings, sources=[])).get('/api/visualization/terrain/endpoint')
    assert response.status_code == 404
    assert response.json() == {'error': 'Terrain not configured'}
    monkeypatch.setenv('AERODT_CESIUM_ION_TOKEN', 'root-secret')
    settings['terrain_enabled'] = False
    response = TestClient(create_app(settings, sources=[])).get('/api/visualization/terrain/endpoint')
    assert response.status_code == 404


@pytest.mark.parametrize('change', [
    {'type': '3DTILES'}, {'url': 'http://assets.cesium.com/1/'},
    {'url': 'https://assets.cesium.com.evil.example/1/'},
    {'url': 'https://root-secret@assets.cesium.com/1/'},
    {'url': 'https://assets.cesium.com:8443/1/'},
    {'url': 'https://assets.cesium.com/1/?access_token=root-secret'},
    {'accessToken': 'root-secret'}, {'accessToken': ''},
    {'attributions': [{'html': 'root-secret', 'collapsible': True}]},
    {'attributions': 'not-an-array'}, {'externalType': 'STK_TERRAIN_SERVER'},
])
def test_terrain_rejects_unsafe_or_wrong_provider_payload(change):
    from communication.external.cesium_terrain import TerrainEndpoint
    payload = {**terrain_payload(), **change}
    endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload)))
    with pytest.raises(ValueError, match='provider unavailable'):
        asyncio.run(endpoint.fetch())


def test_pending_requests_coalesce_but_success_is_not_cached_for_ion_refresh():
    from communication.external.cesium_terrain import TerrainEndpoint

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def handle(request):
            calls.append(1)
            entered.set()
            await release.wait()
            return httpx.Response(200, json=terrain_payload())

        endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(handle))
        first = asyncio.create_task(endpoint.fetch())
        await entered.wait()
        second = asyncio.create_task(endpoint.fetch())
        await asyncio.sleep(0)
        release.set()
        one, two = await asyncio.gather(first, second)
        assert len(calls) == 1
        one['attributions'].clear()
        assert len(two['attributions']) == 1
        await endpoint.fetch()
        assert len(calls) == 2
        await endpoint.aclose()

    asyncio.run(scenario())


def test_cancelling_one_client_keeps_shared_request_and_close_cancels_provider():
    from communication.external.cesium_terrain import TerrainEndpoint

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def handle(request):
            calls.append(1)
            entered.set()
            await release.wait()
            return httpx.Response(200, json=terrain_payload())

        endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(handle))
        first = asyncio.create_task(endpoint.fetch())
        await entered.wait()
        second = asyncio.create_task(endpoint.fetch())
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        release.set()
        assert (await second)['type'] == 'TERRAIN'
        assert len(calls) == 1
        entered.clear()
        release.clear()
        pending = asyncio.create_task(endpoint.fetch())
        await entered.wait()
        await endpoint.aclose()
        assert isinstance((await asyncio.gather(pending, return_exceptions=True))[0], asyncio.CancelledError)
        with pytest.raises(ValueError):
            await endpoint.fetch()
        assert len(calls) == 2

    asyncio.run(scenario())


def test_provider_failure_backs_off_and_retries_without_leaking_response_body():
    from communication.external.cesium_terrain import TerrainEndpoint
    calls, now = [], [0]

    def handle(request):
        calls.append(1)
        return httpx.Response(403, text='root-secret')

    async def scenario():
        endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(handle), clock=lambda: now[0])
        for instant, wanted in ((0, 1), (10, 1), (61, 2)):
            now[0] = instant
            with pytest.raises(ValueError) as caught:
                await endpoint.fetch()
            assert 'root-secret' not in str(caught.value)
            assert len(calls) == wanted
        await endpoint.aclose()

    asyncio.run(scenario())


def test_upstream_redirect_and_oversized_endpoint_are_not_forwarded():
    from communication.external.cesium_terrain import TerrainEndpoint

    async def scenario():
        for response in (httpx.Response(302, headers={'Location': 'https://evil.example'}),
                         httpx.Response(200, content=json.dumps(terrain_payload(extra='x' * 70000)).encode())):
            calls = []

            def handle(request):
                calls.append(str(request.url))
                return response

            endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(handle))
            with pytest.raises(ValueError):
                await endpoint.fetch()
            assert calls == ['https://api.cesium.com/v1/assets/1/endpoint']
            await endpoint.aclose()

    asyncio.run(scenario())


def test_absolute_deadline_cancels_transport_and_enters_backoff(monkeypatch):
    from communication.external import cesium_asset_endpoint
    from communication.external.cesium_terrain import TerrainEndpoint
    monkeypatch.setattr(cesium_asset_endpoint, 'REQUEST_TIMEOUT_SECONDS', .01)

    async def scenario():
        cancelled, calls = [], []

        async def stalled(request):
            calls.append(1)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(1)

        endpoint = TerrainEndpoint('root-secret', transport=httpx.MockTransport(stalled))
        with pytest.raises(ValueError, match='provider unavailable'):
            await asyncio.wait_for(endpoint.fetch(), .5)
        assert cancelled == [1]
        with pytest.raises(ValueError):
            await endpoint.fetch()
        assert calls == [1]
        await endpoint.aclose()

    asyncio.run(scenario())
