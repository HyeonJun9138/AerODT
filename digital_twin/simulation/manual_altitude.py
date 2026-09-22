"""Translate a native contact-world observation into the fleet's deck datum.

Never changes native pose/contact or the socket sample. This is the inverse of
the display deck registration, not an AGL clamp: altitude above the blend and
positions away from the deck remain unchanged.
"""
import math


def fleet_altitude(layout, reference, contact_height, latitude, longitude, altitude):
    frame = layout.get('frame') or {}
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
               for v in (reference, contact_height, latitude, longitude, altitude,
                         frame.get('latitude'), frame.get('longitude'))):
        return altitude
    radius = max((math.hypot(x, y) for x, y in layout.get('platform', {}).get('corners_m', [])), default=0)
    east = (longitude-frame['longitude'])*111320*math.cos(math.radians(frame['latitude']))
    north = (latitude-frame['latitude'])*111320

    def fade(value, near, far):
        t = max(0., min(1., (value-near)/(far-near)))
        return 1-t*t*(3-2*t)

    # Keep in step with vertiport_layer.deckSurfaceOffset, including paint clearance.
    delta = contact_height + .03 - reference
    amount = delta*fade(math.hypot(east, north), radius, radius+250)
    if not amount:
        return altitude
    blend_top = max(150., 10.+1.6*max(0., delta))
    if altitude >= reference+blend_top:
        return altitude
    lo, hi = sorted((altitude, altitude-amount))
    # Monotonic even for a raised deck: the forward blend caps its slope.
    for _ in range(40):
        mid = (lo+hi)/2
        displayed = mid+amount*fade(mid-reference, 10., blend_top)
        if displayed < altitude:
            lo = mid
        else:
            hi = mid
    return (lo+hi)/2


def registered_altitude(engine, flight, latitude, longitude, altitude, heights):
    """Use the nearest known contact deck, as live entity registration does."""
    candidates = []
    for identifier, height in (heights or {}).items():
        if not isinstance(identifier, str) or identifier not in {flight.get('origin'), flight.get('destination')}:
            continue
        layout = engine._layout(identifier)
        frame = layout.get('frame') or {}
        if not all(isinstance(frame.get(k), (float, int)) for k in ('latitude', 'longitude')):
            continue
        distance = math.hypot((latitude-frame['latitude'])*111320,
                              (longitude-frame['longitude'])*111320*math.cos(math.radians(frame['latitude'])))
        radius = max((math.hypot(x, y) for x, y in layout.get('platform', {}).get('corners_m', [])), default=0)
        if distance <= radius+250:
            candidates.append((distance, identifier, layout, height))
    if not candidates:
        return altitude
    _, identifier, layout, height = min(candidates, key=lambda row: row[:2])
    return fleet_altitude(layout, engine._deck_height(identifier), height, latitude, longitude, altitude)
