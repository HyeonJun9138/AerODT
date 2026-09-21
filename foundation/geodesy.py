"""WGS84/ECEF coordinates in metres; unrelated to the native UAM NED frame."""
import math

A = 6378137.0
E2 = 6.69437999014e-3


def to_ecef(latitude, longitude, altitude):
    lat, lon = math.radians(latitude), math.radians(longitude)
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
    return ((n + altitude) * math.cos(lat) * math.cos(lon),
            (n + altitude) * math.cos(lat) * math.sin(lon),
            (n * (1 - E2) + altitude) * math.sin(lat))


def from_ecef(position):
    x, y, z = position
    p = math.hypot(x, y)
    if p < 1e-6:
        return math.copysign(90.0, z), 0.0, abs(z) - A * math.sqrt(1 - E2)
    lat = math.atan2(z, p * (1 - E2))
    for _ in range(7):
        n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
        lat = math.atan2(z + E2 * n * math.sin(lat), p)
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
    return math.degrees(lat), math.degrees(math.atan2(y, x)), p / math.cos(lat) - n


def velocity_ecef(latitude, longitude, track, speed, climb):
    lat, lon, heading = map(math.radians, (latitude, longitude, track))
    east, north = speed * math.sin(heading), speed * math.cos(heading)
    return (-math.sin(lon) * east - math.sin(lat) * math.cos(lon) * north + math.cos(lat) * math.cos(lon) * climb,
            math.cos(lon) * east - math.sin(lat) * math.sin(lon) * north + math.cos(lat) * math.sin(lon) * climb,
            math.cos(lat) * north + math.sin(lat) * climb)
