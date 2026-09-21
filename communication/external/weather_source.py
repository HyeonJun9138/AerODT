"""Coarse weather for the current window, from Open-Meteo.

One request carries every point, so a wider window costs no more requests than
a narrow one. The adapter fetches and returns the provider's answer unchanged;
reading it is not its job, and it holds no credentials because this provider
needs none.
"""
import httpx

ENDPOINT = "https://api.open-meteo.com/v1/forecast"
CURRENT_FIELDS = ("temperature_2m", "weather_code", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
                  "visibility", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "surface_pressure")


def sample_points(bounds):
    """The centre and the corners of a window: enough for a coarse picture."""
    lamin, lamax = float(bounds["lamin"]), float(bounds["lamax"])
    lomin, lomax = float(bounds["lomin"]), float(bounds["lomax"])
    centre = (round((lamin + lamax) / 2, 4), round((lomin + lomax) / 2, 4))
    return [centre, (lamin, lomin), (lamin, lomax), (lamax, lomin), (lamax, lomax)]


class OpenMeteoSource:
    def __init__(self, bounds):
        # A callable is read per request, so the sampled window follows the operator.
        self._bounds = bounds

    def window(self):
        return dict(self._bounds() if callable(self._bounds) else self._bounds)

    def request(self):
        points = sample_points(self.window())
        return {"url": ENDPOINT, "params": {
            "latitude": ",".join(f"{latitude}" for latitude, _ in points),
            "longitude": ",".join(f"{longitude}" for _, longitude in points),
            "current": ",".join(CURRENT_FIELDS),
            "wind_speed_unit": "ms",
            "timeformat": "iso8601",
        }}

    async def fetch(self):
        request = self.request()
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(request["url"], params=request["params"])
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, (list, dict)):
            raise ValueError("Invalid weather response")
        return payload
