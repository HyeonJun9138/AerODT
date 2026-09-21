"""Refit a generated cabin floor so it stays inside the airframe.

The cabin builders cut the floor as one rectangular slab, as wide as the widest
station of the cabin run and 86% of its length. A fuselage is not a box: the
cabin run is chosen for staying *near* full width, so the body is still tapering
at both of its ends, and the slab's corners come out through the skin -- a grey
plate showing under the nose and under the tail.

This reads the body the floor actually sits in and replaces the slab with a deck
of the same height and thickness whose plan outline follows that body:
shortened until the belly is below its underside, then narrowed station by
station. Seats, occupants, panel and glazing are not touched.

    python project_support/tools/visual_assets/fit_cabin_floor.py --check
    python project_support/tools/visual_assets/fit_cabin_floor.py --apply
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cabin_geometry import tapered_deck  # noqa: E402
from mesh_inside import Shell, widest_inside  # noqa: E402
from split_rotor_nodes import read_accessor, read_glb, write_glb  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SHELF = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian'
BACKUP = ROOT / 'data/workspace/visual_assets/cabin_floor_original'
FLOOR = 'Cabin_floor'
# Parts that surround the cabin without being the skin that holds it in. The
# glazing is deliberately NOT here: it fills the window openings, and leaving it
# out puts holes in the skin for a ray to escape through, which reads as though
# the cabin had no side at all.
NOT_BODY = ('gear', 'strut', 'skid', 'wheel', 'tyre', 'tire', 'rotor', 'prop', 'blade',
            'seat', 'occupant', 'console')
# The body runs well past the cabin it holds. Anything barely longer than the
# floor is furniture the floor happens to sit under, not the shell around it.
# Kept between the deck edge and the skin so the two never z-fight in a window.
# How far past the floor's own box to keep skin that might bound it.
AROUND_FLOOR = 0.6
MARGIN_M = 0.02
STATIONS = 24


def quaternion_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def local_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    if 'rotation' in node:
        m[:3, :3] = quaternion_matrix(node['rotation'])
    if 'scale' in node:
        m[:3, :3] = m[:3, :3] @ np.diag(node['scale'])
    if 'translation' in node:
        m[:3, 3] = node['translation']
    return m


def drawn(doc):
    """(node index, world matrix) for every mesh the scene actually draws."""
    out, stack = [], [(at, np.eye(4)) for s in doc.get('scenes', []) for at in s.get('nodes', [])]
    while stack:
        at, parent = stack.pop()
        node = doc['nodes'][at]
        world = parent @ local_matrix(node)
        if 'mesh' in node:
            out.append((at, world))
        stack.extend((kid, world) for kid in node.get('children', []))
    return out


def positions(doc, blob, mesh, cache):
    if mesh not in cache:
        points = []
        for prim in doc['meshes'][mesh]['primitives']:
            at = prim['attributes'].get('POSITION')
            # A sparse or zero-filled accessor carries no bufferView; it has no
            # geometry to bound the floor with either way.
            if at is None or 'bufferView' not in doc['accessors'][at]:
                continue
            points.extend(read_accessor(doc, blob, at))
        cache[mesh] = np.asarray(points, dtype=float) if points else np.zeros((0, 3))
    return cache[mesh]


def triangles_of(doc, blob, mesh, cache):
    """A mesh's triangles as (n, 3, 3), in its own coordinates."""
    if mesh in cache:
        return cache[mesh]
    faces = []
    for prim in doc['meshes'][mesh]['primitives']:
        at = prim['attributes'].get('POSITION')
        if at is None or 'bufferView' not in doc['accessors'][at]:
            continue
        points = np.asarray(read_accessor(doc, blob, at), dtype=np.float64)
        if 'indices' in prim:
            index = np.asarray(read_accessor(doc, blob, prim['indices']), dtype=np.int64).ravel()
        else:
            index = np.arange(len(points))
        index = index[:len(index) - len(index) % 3]
        if len(index):
            faces.append(points[index].reshape(-1, 3, 3))
    cache[mesh] = np.concatenate(faces) if faces else np.zeros((0, 3, 3))
    return cache[mesh]


def survey(glb):
    """The floor slab, and the skin around it as solids, in the floor's frame."""
    doc, blob = read_glb(glb)
    cache, floor, skin = {}, None, []
    for at, world in drawn(doc):
        node = doc['nodes'][at]
        name = node.get('name', '')
        faces = triangles_of(doc, blob, node['mesh'], cache)
        if not len(faces):
            continue
        if name == FLOOR:
            floor = (at, world, faces)
        elif not name.startswith('Cabin_') and not any(w in name.lower() for w in NOT_BODY):
            flat = faces.reshape(-1, 3)
            skin.append((name, (world[:3, :3] @ flat.T).T + world[:3, 3], faces.shape))
    if floor is None or not skin:
        return None
    at, world, slab_faces = floor
    slab = slab_faces.reshape(-1, 3)
    inverse = np.linalg.inv(world)
    # What one local unit is worth in metres along each of the node's own axes.
    # Several of these nodes carry a non-uniform scale, so one number will not
    # do -- and which local axis runs along the cabin has to be judged on the
    # scaled spans, not the raw ones.
    scale = np.array([float(np.linalg.norm(world[:3, k])) or 1.0 for k in range(3)])
    span = np.ptp(slab, axis=0) * scale
    axis = int(np.argmax(span))              # along the cabin
    up = int(np.argmin(span))                # the slab's thickness
    side = ({0, 1, 2} - {axis, up}).pop()    # across the cabin
    order = [axis, side, up]
    lo, hi = slab.min(axis=0), slab.max(axis=0)
    margin = (hi - lo) * AROUND_FLOOR + np.ptp(slab, axis=0).max() * 0.05
    solids = []
    for name, points, shape in skin:
        local = (inverse[:3, :3] @ points.T).T + inverse[:3, 3]
        # Only skin that reaches the floor's own neighbourhood can bound it.
        if (local.max(axis=0) < lo - margin).any() or (local.min(axis=0) > hi + margin).any():
            continue
        solids.append(local.reshape(shape)[:, :, order])
    if not solids:
        return None
    return {'doc': doc, 'blob': blob, 'node': at, 'slab': slab[:, order],
            'shell': Shell(solids), 'scale': scale[order],
            'parts': len(solids), 'axis': axis, 'up': up, 'side': side,
            'material': doc['meshes'][doc['nodes'][at]['mesh']]['primitives'][0].get('material', 0)}


def stations(found):
    """(along, half the slab is, half it may be) for each station."""
    slab = found['slab']
    lo, hi = float(slab[:, 0].min()), float(slab[:, 0].max())
    thickness = float(np.ptp(slab[:, 2]))
    height = float((slab[:, 2].min() + slab[:, 2].max()) / 2)
    centre = float((slab[:, 1].min() + slab[:, 1].max()) / 2)
    half = float(np.ptp(slab[:, 1])) / 2
    room = MARGIN_M / found['scale'][1]
    band = (hi - lo) / (2 * STATIONS)
    out = []
    for i in range(STATIONS + 1):
        along = lo + (hi - lo) * i / STATIONS
        # What the deck is at this station, not what its widest station is: a
        # refitted deck tapers, and measuring it against its own maximum
        # reports the taper itself as overhang.
        here = slab[np.abs(slab[:, 0] - along) <= band]
        is_here = float(np.ptp(here[:, 1])) / 2 if len(here) else 0.0
        widest = widest_inside(found['shell'], along, centre, height, half, thickness)
        # `widest` is where the skin is; `may` also gives up the clearance that
        # keeps the deck edge from z-fighting the skin it sits against.
        out.append((along, is_here, widest, max(0.0, widest - room) if widest > 0 else 0.0))
    return out, centre, height, thickness


def overhang(found):
    """How far, in metres across the body, the slab reaches past the skin."""
    rows, *_ = stations(found)
    return max((is_ - widest for _, is_, widest, _ in rows), default=0.0) * found['scale'][1]


def refit(found):
    """A deck profile for this floor, in the floor's own frame."""
    rows, centre, height, thickness = stations(found)
    # The deck's edge runs straight between stations while the skin curves, so
    # a chord can cut outside even with both of its ends inside. Pulling each
    # station in to its neighbours keeps the whole edge on the inside.
    may = [row[3] for row in rows]
    may = [min(may[max(i - 1, 0):i + 2]) for i in range(len(may))]
    profile = [(rows[i][0], may[i]) for i in range(len(rows))]
    solid = [i for i, h in enumerate(may) if h > 0]
    if solid:
        first, last = max(solid[0] - 1, 0), min(solid[-1] + 1, len(profile) - 1)
        profile = profile[first:last + 1]
    across, along_scale = found['scale'][1], found['scale'][0]
    widths = [h * 2 * across for _, h in profile]
    was_half = max(row[1] for row in rows)
    return profile, {
        'was': [round(was_half * 2 * across, 3),
                round((rows[-1][0] - rows[0][0]) * along_scale, 3)],
        'now': [round(max(widths), 3),
                round((profile[-1][0] - profile[0][0]) * along_scale, 3)],
        'ends': [round(widths[0], 3), round(widths[-1], 3)],
        'centre': centre, 'height': height, 'thickness': thickness}


def install(found, profile, sizes):
    """Write the profile in as the floor's mesh, in the floor's own frame."""
    doc, blob = found['doc'], found['blob']
    mesh = tapered_deck(doc, blob, profile, sizes['thickness'], found['material'])
    # tapered_deck builds in (across, up, along) about its own origin. Put that
    # back on the slab's centreline and height, then into the node's own axes.
    order = [found['axis'], found['side'], found['up']]
    for prim in doc['meshes'][mesh]['primitives']:
        for key in ('POSITION', 'NORMAL'):
            at = prim['attributes'][key]
            values = np.asarray(read_accessor(doc, blob, at), dtype=float)
            local = np.zeros_like(values)
            shift = (0.0, sizes['centre'], sizes['height']) if key == 'POSITION' else (0, 0, 0)
            local[:, order[0]] = values[:, 2] + shift[0]
            local[:, order[1]] = values[:, 0] + shift[1]
            local[:, order[2]] = values[:, 1] + shift[2]
            write_vectors(doc, blob, at, local)
    doc['nodes'][found['node']]['mesh'] = mesh
    return mesh


def write_vectors(doc, blob, index, values):
    accessor = doc['accessors'][index]
    view = doc['bufferViews'][accessor['bufferView']]
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    stride = view.get('byteStride', 12)
    for i, point in enumerate(values):
        blob[start + i * stride:start + i * stride + 12] = np.asarray(point, dtype='<f4').tobytes()
    accessor['min'] = values.min(axis=0).tolist()
    accessor['max'] = values.max(axis=0).tolist()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--apply', action='store_true', help='write the refitted floors')
    ap.add_argument('--only', help='just this folder, for a first look')
    args = ap.parse_args(argv)
    written = 0
    for folder in sorted(SHELF.iterdir()):
        if args.only and args.only != folder.name:
            continue
        for glb in sorted(folder.glob('*.glb')):
            found = survey(glb)
            if found is None:
                continue
            name = f'{folder.name}/{glb.name}'
            profile, sizes = refit(found)
            before = overhang(found)
            if before <= MARGIN_M:
                print(f'ok   {name}: inside ({before * 1000:.0f} mm, {found["parts"]} skin parts)')
                continue
            if not args.apply:
                print(f'OUT  {name}: {before * 1000:.0f} mm out · {sizes["was"]} -> '
                      f'{sizes["now"]} m, ends {sizes["ends"]} · {found["parts"]} skin parts')
                continue
            install(found, profile, sizes)
            BACKUP.mkdir(parents=True, exist_ok=True)
            keep = BACKUP / f'{folder.name}__{glb.name}'
            if not keep.exists():
                shutil.copy2(glb, keep)
            write_glb(glb, found['doc'], found['blob'])
            after = overhang(survey(glb))
            written += 1
            print(f'{"OK  " if after <= MARGIN_M else "WARN"} {name}: '
                  f'{before * 1000:.0f} -> {after * 1000:.0f} mm out · '
                  f'{sizes["was"]} -> {sizes["now"]} m')
    if args.apply:
        print(f'\nrewrote {written} model(s); originals in {BACKUP}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
