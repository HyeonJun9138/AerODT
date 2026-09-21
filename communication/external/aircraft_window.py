"""The area an aircraft provider is asked for.

Display reports where the operator is looking; this decides what to request.
The provider bills per request and charges by tier, so the window follows the
view but always fills the cheapest tier and never exceeds it: the daily budget
stays fixed however the camera moves, and a close-up view still asks for the
whole area that request already pays for. Nothing here is twin state.
"""

import math

WORLD = {"lamin": -90.0, "lamax": 90.0, "lomin": -180.0, "lomax": 180.0}
KEYS = ("lamin", "lamax", "lomin", "lomax")


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def read_view(payload):
    """A reported view, or None when it is not a usable rectangle. A window that
    crosses the antimeridian cannot be expressed as one request, so it is
    refused rather than silently turned into its complement."""
    if not isinstance(payload, dict):
        return None
    view = {key: payload.get(key) for key in KEYS}
    if not all(_finite(value) for value in view.values()):
        return None
    if not (-90 <= view["lamin"] < view["lamax"] <= 90):
        return None
    if not (-180 <= view["lomin"] < view["lomax"] <= 180):
        return None
    return {key: float(view[key]) for key in KEYS}


def clamp_window(view, *, fallback, maximum_area=22.0, minimum_span=.5, margin=1.35, locality_span=45.0):
    """The window to request for a reported view.

    The window is centred on the view and always fills the cheapest tier: the
    provider charges by tier, not by degree, so a window smaller than the tier
    costs exactly the same and only loses the aircraft just outside it. A view
    larger than the tier is shrunk about its centre, a smaller one is grown by
    an equal margin on every side, which also squares off a very wide or very
    tall view rather than reaching around the world for it. A view wider than
    locality_span is not a place the operator is looking at but a continent or
    the globe, where a centre crop would land in whatever ocean happens to be
    mid-screen; that returns the caller's fallback instead, as does having no
    usable view at all.
    """
    if view is None:
        return dict(fallback)
    if view["lamax"] - view["lamin"] > locality_span or view["lomax"] - view["lomin"] > locality_span:
        return dict(fallback)
    centre_latitude = (view["lamin"] + view["lamax"]) / 2
    centre_longitude = (view["lomin"] + view["lomax"]) / 2
    height = max(minimum_span, (view["lamax"] - view["lamin"]) * margin)
    width = max(minimum_span, (view["lomax"] - view["lomin"]) * margin)
    area = height * width
    if area > maximum_area:
        scale = (maximum_area / area) ** .5
        height, width = height * scale, width * scale
    elif area < maximum_area:
        # Grow both sides by the same number of degrees until the tier is full.
        # Padding rather than scaling keeps a letterbox view from becoming a
        # band right around the globe: the shorter side gains proportionally more.
        pad = (math.sqrt((height + width) ** 2 + 4 * (maximum_area - area)) - (height + width)) / 4
        height, width = height + 2 * pad, width + 2 * pad
    window = {
        "lamin": centre_latitude - height / 2, "lamax": centre_latitude + height / 2,
        "lomin": centre_longitude - width / 2, "lomax": centre_longitude + width / 2,
    }
    # Slide, rather than clip, at the poles and the antimeridian: clipping would
    # shrink the window and drop the surroundings the operator asked for.
    for low, high, limit in (("lamin", "lamax", 90.0), ("lomin", "lomax", 180.0)):
        if window[low] < -limit:
            window[high] = min(limit, window[high] - limit - window[low])
            window[low] = -limit
        elif window[high] > limit:
            window[low] = max(-limit, window[low] + limit - window[high])
            window[high] = limit
    return {key: round(window[key], 3) for key in KEYS}


class ViewWindow:
    """The latest reported view. One local dashboard, so the newest report wins;
    a second tab simply moves the window rather than fighting over it."""

    def __init__(self, fallback, **policy):
        self._fallback = dict(fallback) if fallback else dict(WORLD)
        self._policy = policy
        self._view = None

    def report(self, payload):
        view = read_view(payload)
        if view is None:
            return False
        self._view = view
        return True

    def clear(self):
        self._view = None

    @property
    def reported(self):
        return self._view is not None

    def reported_view(self):
        """What the display last reported, or None. A consumer that is not
        billed by area - the twin deciding which satellites are overhead - wants
        the screen itself, not the window shaped for the provider's price list."""
        return dict(self._view) if self._view is not None else None

    def current(self):
        return clamp_window(self._view, fallback=self._fallback, **self._policy)
