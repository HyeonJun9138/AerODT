import asyncio
import httpx
import pytest
from communication.external.live_sources import CelesTrakSource, NotModified, OpenSkySource


def client_factory(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))


def test_gp_adapter_requests_json_and_leaves_interpretation_to_live(monkeypatch):
    def respond(request):
        assert request.url.params['FORMAT'] == 'JSON'
        assert request.url.params['GROUP'] == 'active'
        return httpx.Response(200, json=[{'NORAD_CAT_ID': 100001}])
    client_factory(monkeypatch, respond)
    assert asyncio.run(CelesTrakSource().fetch()) == [{'NORAD_CAT_ID': 100001}]


def test_gp_asks_conditionally_once_a_copy_is_held(monkeypatch):
    """The provider asks to be asked this way, and it is the difference between
    downloading a 1.3 MB catalogue every two hours and downloading it when it
    has actually changed."""
    seen = []
    def respond(request):
        seen.append(request.headers.get('if-modified-since'))
        return httpx.Response(200, json=[{'NORAD_CAT_ID': 100001}],
                              headers={'Last-Modified': 'Mon, 08 Sep 2026 10:00:00 GMT'})
    client_factory(monkeypatch, respond)
    source = CelesTrakSource()
    assert asyncio.run(source.fetch()) == [{'NORAD_CAT_ID': 100001}]
    assert seen == [None], 'nothing to validate on the first request'
    assert source.last_modified == 'Mon, 08 Sep 2026 10:00:00 GMT'

    held = CelesTrakSource(validator=lambda: 'Mon, 08 Sep 2026 10:00:00 GMT')
    asyncio.run(held.fetch())
    assert seen[-1] == 'Mon, 08 Sep 2026 10:00:00 GMT'


def test_an_unchanged_catalogue_is_reported_as_such_not_as_a_failure(monkeypatch):
    client_factory(monkeypatch, lambda request: httpx.Response(304))
    with pytest.raises(NotModified):
        asyncio.run(CelesTrakSource(validator=lambda: 'Mon, 08 Sep 2026 10:00:00 GMT').fetch())


def test_a_redirect_is_reported_instead_of_being_followed(monkeypatch):
    """Following one would turn a request into two and read as success. A moved
    address, or a challenge page, is something a person should see."""
    calls = []
    def respond(request):
        calls.append(request.url.host)
        return httpx.Response(301, headers={'location': 'https://elsewhere.test/gp.php'})
    client_factory(monkeypatch, respond)
    with pytest.raises(httpx.HTTPStatusError) as raised:
        asyncio.run(CelesTrakSource().fetch())
    assert raised.value.response.status_code == 301
    assert calls == ['celestrak.org'], 'the redirect target was never requested'


def test_opensky_oauth_token_is_reused_without_exposure(monkeypatch):
    tokens = []
    def respond(request):
        if request.method == 'POST':
            tokens.append(1)
            return httpx.Response(200, json={'access_token':'test-private-token','expires_in':300})
        assert request.headers['authorization'] == 'Bearer test-private-token'
        return httpx.Response(200, json={'states':[]})
    client_factory(monkeypatch, respond)
    source = OpenSkySource('test-id','test-secret')
    for _ in range(2):
        assert asyncio.run(source.fetch()) == {'states':[]}
    assert len(tokens) == 1
