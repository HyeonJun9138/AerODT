"""OpenSky aircraft-state HTTP adapter; no twin state or interpretation."""

import time

import httpx


class OpenSkySource:
    def __init__(self, client_id, client_secret, bounds=None):
        self._client_id, self._client_secret = client_id, client_secret
        self._token, self._expires_at = None, 0
        # A callable is read per request, so the window can follow the display.
        self.bounds = bounds or {}

    def window(self):
        return dict(self.bounds() if callable(self.bounds) else self.bounds)

    async def fetch(self):
        async with httpx.AsyncClient(timeout=20) as client:
            if time.monotonic() >= self._expires_at:
                response = await client.post("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
                    data={"grant_type": "client_credentials", "client_id": self._client_id, "client_secret": self._client_secret})
                response.raise_for_status()
                credentials = response.json()
                self._token = credentials["access_token"]
                self._expires_at = time.monotonic() + max(1, credentials.get("expires_in", 300) - 30)
            response = await client.get("https://opensky-network.org/api/states/all",
                params=self.window(), headers={"Authorization": f"Bearer {self._token}"})
            if response.status_code == 401:
                self._expires_at = 0
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or "states" not in payload:
                raise ValueError("Invalid aircraft response")
            return payload
