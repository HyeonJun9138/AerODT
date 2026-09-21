"""A locality name for a position, so a waypoint can be named after where it is.

Asks OpenStreetMap's Nominatim for the address around a point and keeps the
part below city level: a quarter, neighbourhood or suburb, which is what a
person calls the area. Results are cached by rounded position and every
failure answers None, so the caller falls back to a default name and never
waits on the network twice for the same place. Nominatim's usage policy asks
for an identifying user agent and at most one request a second; the display
only asks once per new waypoint.
"""
import asyncio
import time

import httpx

REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "AeroDT/0.1 (local dashboard; route waypoint naming)"
# Address parts from the finest to the coarsest that still names a locality.
LOCALITY_KEYS = ("quarter", "neighbourhood", "suburb", "village", "town", "hamlet", "city_district", "borough", "district", "county")
# A locality name holds over about half a kilometre, so positions are
# grouped on that grid: the next waypoint nearby is answered from memory.
CACHE_GRID_DEGREES = 0.005
MINIMUM_SPACING_SECONDS = 1.0


def pick_locality(address):
    """The finest locality name in a Nominatim address, or None. City-level
    names are left out: a waypoint called after a whole city says nothing."""
    if not isinstance(address, dict):
        return None
    for key in LOCALITY_KEYS:
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


class PlaceNameLookup:
    def __init__(self, *, url=REVERSE_URL, language="ko", timeout_seconds=4.0, transport=None, clock=time.monotonic):
        self._url = url
        self._language = language
        self._timeout = timeout_seconds
        self._transport = transport
        self._clock = clock
        self._cache = {}
        self._last_request = None
        self._lock = asyncio.Lock()
        # One connection kept open: the TLS handshake is most of a lookup's time.
        self._client = None

    @staticmethod
    def _key(latitude, longitude):
        return (round(float(latitude) / CACHE_GRID_DEGREES), round(float(longitude) / CACHE_GRID_DEGREES))

    def _http(self):
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout, transport=self._transport, headers={"User-Agent": USER_AGENT})
        return self._client

    async def close(self):
        if self._client is not None:
            client, self._client = self._client, None
            await client.aclose()

    async def lookup(self, latitude, longitude):
        key = self._key(latitude, longitude)
        if key in self._cache:
            return self._cache[key]
        async with self._lock:
            if key in self._cache:
                return self._cache[key]
            if self._last_request is not None:
                wait = MINIMUM_SPACING_SECONDS - (self._clock() - self._last_request)
                if wait > 0:
                    await asyncio.sleep(wait)
            self._last_request = self._clock()
            name = await self._fetch(latitude, longitude)
        if name is not None:
            self._cache[key] = name
        return name

    async def _fetch(self, latitude, longitude):
        params = {"lat": f"{float(latitude):.6f}", "lon": f"{float(longitude):.6f}", "format": "jsonv2",
                  "zoom": 14, "accept-language": self._language}
        try:
            response = await self._http().get(self._url, params=params)
            if response.status_code != 200:
                return None
            document = response.json()
        except (httpx.HTTPError, ValueError, OSError):
            return None
        return pick_locality(document.get("address") if isinstance(document, dict) else None)
