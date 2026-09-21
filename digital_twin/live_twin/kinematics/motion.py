"""How an aircraft state is carried forward between observations.

This is the kinematics the Data Alignment / State Estimation step uses, on its
own so both the current state and a predicted path are produced by the same
arithmetic rather than by two similar-looking pieces of code.

Two models are offered. Constant velocity keeps the observed velocity vector,
which is a straight line through space. A coordinated turn keeps the observed
turn rate as well: the horizontal velocity is rotated about the local vertical
while it is integrated, so an aircraft in a turn is carried around the turn
instead of flying out of it. Both are estimates from what a surveillance feed
reports, never a filed route.

Pure functions in ECEF metres: no storage, transport or rendering here.
"""
import math

# Positive heading grows clockwise from north, and a right-handed rotation about
# the local vertical turns counter-clockwise seen from above, so a right turn is
# a negative rotation about "up".
TURN_SIGN = -1.0
# Below this the arc and the straight line differ by less than a millimetre over
# a minute, so the simpler form is used and no division by zero can happen.
NEGLIGIBLE_RATE_RAD_S = 1e-9


def up_at(latitude_deg, longitude_deg):
    """The local vertical (geodetic normal) as a unit vector in ECEF."""
    latitude, longitude = math.radians(latitude_deg), math.radians(longitude_deg)
    return (math.cos(latitude) * math.cos(longitude),
            math.cos(latitude) * math.sin(longitude),
            math.sin(latitude))


def turn_rate_between(previous_heading_deg, heading_deg, gap_seconds, limit_dps):
    """Degrees per second between two ground tracks, along the shorter arc.

    None when it cannot be measured. The limit is what an airliner actually
    flies — a standard rate turn — so a jump in a noisy track report becomes a
    firm turn rather than an impossible one.
    """
    if previous_heading_deg is None or heading_deg is None:
        return None
    if not (gap_seconds and math.isfinite(gap_seconds)) or gap_seconds <= 0:
        return None
    delta = (heading_deg - previous_heading_deg + 180) % 360 - 180
    return max(-limit_dps, min(limit_dps, delta / gap_seconds))


def blend_turn_rate(previous_dps, measured_dps, gain):
    """Take part of a newly measured turn rate, keeping the rest of the old one."""
    if measured_dps is None:
        return previous_dps
    if previous_dps is None:
        return measured_dps
    return previous_dps + gain * (measured_dps - previous_dps)


def advance_state(position, velocity, up, turn_rate_dps, dt):
    """Position and velocity `dt` seconds on, turning about the local vertical.

    With no turn rate this is the straight line the constant-velocity model
    draws. With one it is the exact arc of a constant-rate turn: the vertical
    part of the velocity is untouched, so a climbing turn still climbs.
    """
    if not dt:
        return tuple(position), tuple(velocity)
    rate = math.radians(turn_rate_dps or 0.0) * TURN_SIGN
    if abs(rate) < NEGLIGIBLE_RATE_RAD_S:
        return tuple(p + dt * v for p, v in zip(position, velocity)), tuple(velocity)
    climb = sum(u * v for u, v in zip(up, velocity))
    horizontal = tuple(v - climb * u for u, v in zip(up, velocity))
    # up x horizontal: the horizontal velocity turned a quarter turn to the left.
    left = (up[1] * horizontal[2] - up[2] * horizontal[1],
            up[2] * horizontal[0] - up[0] * horizontal[2],
            up[0] * horizontal[1] - up[1] * horizontal[0])
    sine, cosine = math.sin(rate * dt), math.cos(rate * dt)
    moved = tuple(h * sine / rate + l * (1 - cosine) / rate + u * climb * dt
                  for h, l, u in zip(horizontal, left, up))
    turned = tuple(h * cosine + l * sine for h, l in zip(horizontal, left))
    return (tuple(p + m for p, m in zip(position, moved)),
            tuple(t + climb * u for t, u in zip(turned, up)))


def heading_after(heading_deg, turn_rate_dps, dt):
    """The ground track after turning at that rate, or the old one when it cannot turn."""
    if heading_deg is None:
        return None
    return (heading_deg + (turn_rate_dps or 0.0) * dt) % 360
