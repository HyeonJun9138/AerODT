"""CelesTrak GP HTTP adapter; no twin state or interpretation."""

import httpx


class NotModified(Exception):
    """The provider says what we hold is still current. Not a failure."""


class CelesTrakSource:
    """GP elements, asked for the way the provider asks to be asked.

    Two things here are about not being blocked rather than about data. The
    request carries If-Modified-Since when we already hold a copy, which the
    usage policy asks for and which turns a two-hourly poll into a few hundred
    bytes when nothing has changed. And redirects are not followed: a provider
    that has moved, or that answers a challenge page, would otherwise turn one
    request into two and look like success. A person should see that instead.
    """

    def __init__(self, group="active", validator=lambda: ""):
        self.group = group
        # Read per request, so a fresh Last-Modified is used without a restart.
        self.validator = validator
        # What the provider said about the copy just handed over, for the caller
        # to keep and send back next time.
        self.last_modified = ""

    async def fetch(self):
        headers = {"User-Agent": "AeroDT-WebLiveTwin/1.0"}
        known = self.validator() if callable(self.validator) else self.validator
        if known:
            headers["If-Modified-Since"] = known
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            response = await client.get("https://celestrak.org/NORAD/elements/gp.php",
                params={"GROUP": self.group, "FORMAT": "JSON"}, headers=headers)
            if response.status_code == 304:
                raise NotModified(response.headers.get("Last-Modified", known))
            if response.is_redirect:
                # Reported as an HTTP status so the collector treats it the way
                # it treats any answer that will not come good by asking again.
                raise httpx.HTTPStatusError(
                    f"CelesTrak redirected to {response.headers.get('location', '')}",
                    request=response.request, response=response)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                raise ValueError("Empty GP response")
            self.last_modified = response.headers.get("Last-Modified", "")
            return payload
