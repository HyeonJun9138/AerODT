"""Read-only ion endpoints for the two approved visualization assets only."""
import asyncio
from copy import deepcopy
import json
import time
from urllib.parse import urlsplit

import httpx


_ASSETS = {'buildings': (96188, '3DTILES'), 'terrain': (1, 'TERRAIN')}
REQUEST_TIMEOUT_SECONDS = 18


class CesiumAssetEndpoint:
    def __init__(self, token, kind, *, transport=None, clock=time.monotonic):
        self._asset_id, self._type = _ASSETS[kind]
        if not isinstance(token, str) or not token.strip():
            raise ValueError('Cesium credential not configured')
        self._token = token
        self._transport = transport
        self._clock = clock
        self._pending = None
        self._retry_at = 0
        self._closed = False

    async def fetch(self):
        if self._closed or self._clock() < self._retry_at:
            raise ValueError('Cesium provider unavailable')
        if self._pending is None:
            self._pending = asyncio.create_task(self._request())
            self._pending.add_done_callback(self._finished)
        # A disconnected browser must not cancel another browser's request.
        # No positive cache: IonResource revisits this endpoint after HTTP 401
        # and must receive a fresh asset token rather than the expired one.
        return deepcopy(await asyncio.shield(self._pending))

    def _finished(self, task):
        if self._pending is task:
            self._pending = None
        if not task.cancelled():
            task.exception()  # Consume failures even when all clients left.

    async def _request(self):
        try:
            return await asyncio.wait_for(self._retrieve(), REQUEST_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._retry_at = self._clock() + 60
            # Never expose upstream bodies, URLs, headers or credentials.
            raise ValueError('Cesium provider unavailable') from None

    async def _retrieve(self):
        async with httpx.AsyncClient(timeout=15, follow_redirects=False,
                                     transport=self._transport) as client:
            async with client.stream('GET',
                    f'https://api.cesium.com/v1/assets/{self._asset_id}/endpoint',
                    headers={'Authorization': f'Bearer {self._token}'}) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        raise ValueError('Oversized endpoint')
        data = json.loads(body)
        url = urlsplit(data['url'])
        access_token = data.get('accessToken')
        attributions = data.get('attributions')
        if (data.get('type') != self._type or 'externalType' in data or
                url.scheme != 'https' or not (url.hostname or '').endswith('.cesium.com') or
                url.username or url.password or url.port not in (None, 443) or url.fragment or
                not isinstance(access_token, str) or not access_token or
                not isinstance(attributions, list) or
                any(not isinstance(item, dict) or not isinstance(item.get('html'), str) or
                    not isinstance(item.get('collapsible'), bool) for item in attributions)):
            raise ValueError('Invalid endpoint')
        result = {key: data[key] for key in ('type', 'url', 'accessToken', 'attributions')}
        if self._token in json.dumps(result):
            raise ValueError('Account credential in endpoint')
        return result

    async def aclose(self):
        self._closed = True
        if self._pending is not None:
            pending = self._pending
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
