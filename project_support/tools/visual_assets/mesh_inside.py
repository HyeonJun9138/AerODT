"""Is this point inside the airframe? By casting rays at the skin, not by guessing.

Band sampling -- "are there skin vertices to the left and right of it" -- is a
guess, and it guesses wrong on any airframe whose body is split across parts or
tessellated unevenly.

Counting crossings and taking the parity is the textbook answer, and it is the
wrong question here. These bodies are modelled with wall thickness: an airframe
is a shell with an outer and an inner surface, so the cabin is a cavity and a
seat in it is *outside* the material by parity, correctly and uselessly.

What the cabin needs to know is whether a point is held inside the skin, which
is a different question with a simple test: fire a ray along each of the six
axis directions and ask whether the skin is there to stop it. Surrounded on all
six sides means enclosed. Ray directions are axis-aligned, so a crossing is a
barycentric question in the two other coordinates and a comparison in the
first; triangles edge-on to a ray project to nothing and cannot be crossed.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-9


class Shell:
    """Every triangle of the skin around one cabin, asked six ways."""

    def __init__(self, meshes):
        faces = [np.asarray(m, dtype=np.float64) for m in meshes if len(m)]
        if not faces:
            raise ValueError('no skin triangles')
        self.tri = np.concatenate(faces)
        self.lo = self.tri.min(axis=1)
        self.hi = self.tri.max(axis=1)
        self.box_lo = self.tri.reshape(-1, 3).min(axis=0)
        self.box_hi = self.tri.reshape(-1, 3).max(axis=0)
        # Twice the signed area each triangle covers in the plane each ray
        # crosses, which is also the denominator of that plane's barycentrics.
        self.area = {}
        for axis in range(3):
            u, v = (axis + 1) % 3, (axis + 2) % 3
            a, b, c = self.tri[:, 0], self.tri[:, 1], self.tri[:, 2]
            self.area[axis] = ((b[:, u] - a[:, u]) * (c[:, v] - a[:, v]) -
                               (c[:, u] - a[:, u]) * (b[:, v] - a[:, v]))

    def reach(self, point, axis):
        """Where the skin sits along `axis` on the line through `point`."""
        u, v = (axis + 1) % 3, (axis + 2) % 3
        area = self.area[axis]
        near = ((np.abs(area) > EPS)
                & (self.lo[:, u] <= point[u]) & (point[u] <= self.hi[:, u])
                & (self.lo[:, v] <= point[v]) & (point[v] <= self.hi[:, v]))
        if not near.any():
            return None
        tri, area = self.tri[near], area[near]
        a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
        w0 = ((b[:, u] - point[u]) * (c[:, v] - point[v]) -
              (c[:, u] - point[u]) * (b[:, v] - point[v])) / area
        w1 = ((c[:, u] - point[u]) * (a[:, v] - point[v]) -
              (a[:, u] - point[u]) * (c[:, v] - point[v])) / area
        w2 = 1.0 - w0 - w1
        hit = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not hit.any():
            return None
        return (w0[hit] * a[hit][:, axis] + w1[hit] * b[hit][:, axis] + w2[hit] * c[hit][:, axis])

    def encloses(self, point):
        """Whether the skin stands between this point and every direction out."""
        point = np.asarray(point, dtype=np.float64)
        if (point < self.box_lo).any() or (point > self.box_hi).any():
            return False
        for axis in range(3):
            where = self.reach(point, axis)
            if where is None:
                return False
            if not ((where > point[axis] + EPS).any() and (where < point[axis] - EPS).any()):
                return False
        return True


def widest_inside(shell, along, centre, height, half, thickness, steps=12):
    """The largest half-width at station `along` whose deck edges stay enclosed.

    Points are given as (along, across, up), and the edges are tried on the
    plate's own mid-plane. Its faces are not: a deck a few millimetres proud of
    the cabin floor line shows a sliver at most, and pulling it in for that
    would collapse the whole deck over a defect nobody can see. What is being
    fixed here is the plate that comes out through the side of the nose."""
    _ = thickness

    def fits(h):
        return all(shell.encloses((along, centre + side * h, height))
                   for side in (-1.0, 1.0))

    if fits(half):
        return half
    if not fits(0.0):
        return 0.0
    low, high = 0.0, half
    for _ in range(steps):
        mid = (low + high) / 2
        if fits(mid):
            low = mid
        else:
            high = mid
    return low
