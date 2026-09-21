"""Give an airframe's propellers their own nodes, so a renderer can turn them.

Some models arrive with every part welded into one mesh. The blades are all
there, but nothing can turn them: a renderer moves nodes, and a model with one
node has one thing to move. This finds the propeller blades inside a primitive,
groups them into the rotors they belong to, and writes the model back with each
rotor as its own node standing on its own hub.

Nothing is redrawn or reshaped. Every vertex keeps its position, normal,
tangent and texture coordinate; the only change is that a rotor's vertices are
written relative to its hub and the node carries the hub instead. Rendered
still, the model is the same model.

The grouping is checked rather than assumed. Blades are found as connected
islands of geometry, and the tool looks for the one grouping distance that
splits them into exactly the number of rotors expected with exactly the same
number of blades on each. It then checks that each rotor's blades really do sit
at one radius about their hub, the way blades on a shaft must. If any of that
does not hold it stops and says so, because a wrong grouping would turn part of
an aircraft that is not a propeller.

    python project_support/tools/visual_assets/split_rotor_nodes.py <model.glb>
        --primitive 2 --rotors 6 --blades 5 [--out <path>] [--dry-run]
"""
import argparse
import json
import struct
import sys
from pathlib import Path

GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
COMPONENTS_OF = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
# How far a blade centre may sit from its rotor's mean radius before the group
# is not a rotor. Blades on a shaft are at one radius; a wing and a blade
# lumped together are not.
RADIUS_TOLERANCE = 0.25


def read_glb(path):
    raw = Path(path).read_bytes()
    magic, _, length = struct.unpack_from('<III', raw, 0)
    if magic != GLB_MAGIC:
        raise SystemExit(f'{path} is not a GLB')
    offset, chunks = 12, {}
    while offset < length:
        size, kind = struct.unpack_from('<II', raw, offset)
        chunks.setdefault(kind, raw[offset + 8:offset + 8 + size])
        offset += 8 + size + (-size % 4)
    return json.loads(chunks[JSON_CHUNK].decode('utf-8')), bytearray(chunks.get(BIN_CHUNK, b''))


def write_glb(path, document, binary):
    # The buffer grew, so say how long it is now: a view that runs past the
    # declared length is an invalid file, whatever the chunk actually holds.
    if document.get('buffers'):
        document['buffers'][0]['byteLength'] = len(binary)
    text = json.dumps(document, separators=(',', ':')).encode('utf-8')
    text += b' ' * (-len(text) % 4)
    body = bytes(binary) + b'\0' * (-len(binary) % 4)
    length = 12 + 8 + len(text) + (8 + len(body) if body else 0)
    out = bytearray(struct.pack('<III', GLB_MAGIC, 2, length))
    out += struct.pack('<II', len(text), JSON_CHUNK) + text
    if body:
        out += struct.pack('<II', len(body), BIN_CHUNK) + body
    Path(path).write_bytes(out)
    return length


def read_accessor(document, binary, index):
    """One accessor as a list of tuples, in the order it was written."""
    accessor = document['accessors'][index]
    view = document['bufferViews'][accessor['bufferView']]
    kind = COMPONENT[accessor['componentType']]
    width = COMPONENTS_OF[accessor['type']]
    size = struct.calcsize(kind)
    stride = view.get('byteStride') or size * width
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    form = '<' + kind * width
    return [struct.unpack_from(form, binary, start + at * stride) for at in range(accessor['count'])]


def add_accessor(document, binary, values, *, kind, component, target=None):
    """Append values to the buffer and return the new accessor's index."""
    width = COMPONENTS_OF[kind]
    form = '<' + COMPONENT[component] * width
    binary.extend(b'\0' * (-len(binary) % 4))
    offset = len(binary)
    for value in values:
        binary.extend(struct.pack(form, *value))
    view = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(binary) - offset}
    if target is not None:
        view['target'] = target
    document['bufferViews'].append(view)
    accessor = {'bufferView': len(document['bufferViews']) - 1, 'componentType': component,
                'count': len(values), 'type': kind}
    if kind != 'SCALAR':
        accessor['min'] = [min(value[axis] for value in values) for axis in range(width)]
        accessor['max'] = [max(value[axis] for value in values) for axis in range(width)]
    document['accessors'].append(accessor)
    return len(document['accessors']) - 1


def islands_of(positions, indices):
    """Connected pieces of geometry. Vertices split for a seam share a position,
    so they are welded first: otherwise one blade comes apart into its faces."""
    same = {}
    root_of = {}
    for at, point in enumerate(positions):
        root_of[at] = same.setdefault(tuple(round(value, 5) for value in point), at)
    parent = list(range(len(positions)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for at in range(0, len(indices), 3):
        for first, second in ((indices[at], indices[at + 1]), (indices[at + 1], indices[at + 2])):
            one, two = find(root_of[first]), find(root_of[second])
            if one != two:
                parent[one] = two
    groups = {}
    for at in range(len(positions)):
        groups.setdefault(find(root_of[at]), []).append(at)
    return list(groups.values())


def centre_of(positions, vertices):
    low = [min(positions[at][axis] for at in vertices) for axis in range(3)]
    high = [max(positions[at][axis] for at in vertices) for axis in range(3)]
    return [(low[axis] + high[axis]) / 2 for axis in range(3)]


def group_at(centres, distance, axes):
    """Single-linkage grouping: blades closer than `distance` across the plane
    the rotors are spread over belong to the same rotor."""
    parent = list(range(len(centres)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for one in range(len(centres)):
        for two in range(one + 1, len(centres)):
            gap = max(abs(centres[one][axis] - centres[two][axis]) for axis in axes)
            if gap <= distance:
                a, b = find(one), find(two)
                if a != b:
                    parent[a] = b
    groups = {}
    for at in range(len(centres)):
        groups.setdefault(find(at), []).append(at)
    return list(groups.values())


def find_rotors(centres, rotors, blades, axes):
    """The grouping distance that splits the blades into the rotors expected,
    or None when no distance does. Searched rather than chosen, so the answer
    does not depend on a number somebody tuned by eye."""
    spread = max(max(abs(a[axis] - b[axis]) for axis in axes) for a in centres for b in centres)
    best = None
    for step in range(1, 400):
        distance = spread * step / 400
        groups = group_at(centres, distance, axes)
        if len(groups) == rotors and all(len(group) == blades for group in groups):
            best = groups if best is None else best
    return best


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('model', help='the .glb to split')
    parser.add_argument('--mesh', type=int, default=0, help='mesh holding the blades')
    parser.add_argument('--primitive', type=int, required=True, help='primitive holding the blades')
    parser.add_argument('--rotors', type=int, required=True, help='how many rotors are expected')
    parser.add_argument('--blades', type=int, required=True, help='blades on each rotor')
    parser.add_argument('--axis', default='y', choices=('x', 'y', 'z'), help='the axis a rotor turns about')
    parser.add_argument('--name', default='Rotor', help='what to call the new nodes')
    parser.add_argument('--out', help='where to write (default: over the input)')
    parser.add_argument('--dry-run', action='store_true', help='report the grouping and stop')
    args = parser.parse_args(argv)

    document, binary = read_glb(args.model)
    mesh = document['meshes'][args.mesh]
    primitive = mesh['primitives'][args.primitive]
    positions = read_accessor(document, binary, primitive['attributes']['POSITION'])
    indices = [value[0] for value in read_accessor(document, binary, primitive['indices'])]

    pieces = islands_of(positions, indices)
    print(f'{len(pieces)} connected pieces in mesh {args.mesh} primitive {args.primitive}')
    if len(pieces) != args.rotors * args.blades:
        raise SystemExit(f'expected {args.rotors * args.blades} blades, found {len(pieces)}: '
                         'this primitive is not the propellers alone')
    turning = 'xyz'.index(args.axis)
    across = [axis for axis in range(3) if axis != turning]
    centres = [centre_of(positions, piece) for piece in pieces]
    groups = find_rotors(centres, args.rotors, args.blades, across)
    if groups is None:
        raise SystemExit(f'no grouping distance splits {len(pieces)} blades into '
                         f'{args.rotors} rotors of {args.blades}')

    rotors = []
    for group in groups:
        hub = [sum(centres[at][axis] for at in group) / len(group) for axis in range(3)]
        radii = [max(abs(centres[at][axis] - hub[axis]) for axis in across) for at in group]
        mean = sum(radii) / len(radii)
        if mean <= 0 or max(abs(radius - mean) for radius in radii) / mean > RADIUS_TOLERANCE:
            raise SystemExit(f'a group at {hub} is not blades on one shaft: radii {radii}')
        rotors.append({'hub': hub, 'blades': group, 'radius': mean,
                       'vertices': sorted({at for piece in group for at in pieces[piece]})})
    rotors.sort(key=lambda rotor: (round(rotor['hub'][across[1]], 3), rotor['hub'][across[0]]))
    for at, rotor in enumerate(rotors, start=1):
        hub = [round(value, 4) for value in rotor['hub']]
        print(f"  rotor {at}: hub={hub} radius={rotor['radius']:.4f} "
              f"blades={len(rotor['blades'])} vertices={len(rotor['vertices'])}")
    if args.dry_run:
        return 0

    # Each rotor becomes its own mesh, its vertices written about its hub so the
    # node can turn them where they stand.
    attributes = primitive['attributes']
    source = {name: read_accessor(document, binary, index) for name, index in attributes.items()}
    parent_node = next((node for node in document['nodes'] if node.get('mesh') == args.mesh), None)
    if parent_node is None:
        raise SystemExit(f'no node carries mesh {args.mesh}')
    children = parent_node.setdefault('children', [])
    for at, rotor in enumerate(rotors, start=1):
        keep = rotor['vertices']
        renumber = {old: new for new, old in enumerate(keep)}
        moved = {}
        for name, values in source.items():
            if name == 'POSITION':
                moved[name] = add_accessor(document, binary,
                    [tuple(values[old][axis] - rotor['hub'][axis] for axis in range(3)) for old in keep],
                    kind='VEC3', component=5126, target=34962)
            else:
                accessor = document['accessors'][attributes[name]]
                moved[name] = add_accessor(document, binary, [values[old] for old in keep],
                                           kind=accessor['type'], component=accessor['componentType'],
                                           target=34962)
        triangles = []
        for start in range(0, len(indices), 3):
            face = indices[start:start + 3]
            if all(vertex in renumber for vertex in face):
                triangles.extend((renumber[vertex],) for vertex in face)
        blade_mesh = {'name': f'{args.name}_{at}',
                      'primitives': [{'attributes': moved,
                                      'indices': add_accessor(document, binary, triangles,
                                                              kind='SCALAR', component=5125,
                                                              target=34963)}]}
        if 'material' in primitive:
            blade_mesh['primitives'][0]['material'] = primitive['material']
        document['meshes'].append(blade_mesh)
        document['nodes'].append({'name': f'{args.name}_{at}',
                                  'mesh': len(document['meshes']) - 1,
                                  'translation': [round(value, 6) for value in rotor['hub']]})
        children.append(len(document['nodes']) - 1)
        print(f'  wrote node {args.name}_{at} with {len(triangles) // 3} triangles')

    # The blades are drawn by their own nodes now, so the primitive they came
    # from goes: leaving it would draw every blade twice, one set standing still.
    mesh['primitives'].pop(args.primitive)
    out = args.out or args.model
    size = write_glb(out, document, binary)
    print(f'wrote {out} ({size:,} bytes, {len(document["nodes"])} nodes, {len(document["meshes"])} meshes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
