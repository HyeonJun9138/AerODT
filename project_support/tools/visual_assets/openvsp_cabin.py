"""Give an OpenVSP airframe a cabin, glazing, instrument screens and a livery.

The reference vehicles are research outer surfaces: one colour, no windows, no
interior. A cockpit view inside one of them would look at the inside of an
opaque shell. So this does four things, in the order that keeps each honest:

  measure   the fuselage says which end is the nose and how much room is inside.
            Nothing here is assumed; the taper is read off the file.
  glaze     the window band reuses the fuselage's own triangles and changes only
            their material. No vertex is moved, added or removed, so the outer
            shape stays exactly the shape NASA published.
  furnish   floor, seats, occupants and an instrument panel are new geometry,
            added inside. They are illustrative, fitted to the measured envelope,
            and are not claimed as certified cabin dimensions. The floor is cut
            as one rectangle here, which is wider than the body at both ends of
            the cabin run; run fit_cabin_floor.py afterwards to taper it to the
            skin, or it shows as a plate through the nose and the tail.
  paint     materials by part: airframe, rotor, duct, gear, glass, cabin, screen.

    python project_support/tools/visual_assets/openvsp_cabin.py \
        --build data/workspace/visual_assets/intake_nasa/build/liftpcruise
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from split_rotor_nodes import read_glb, write_glb, read_accessor, add_accessor  # noqa: E402
from cabin_geometry import mesh as build_mesh, rounded_box, ellipsoid  # noqa: E402

# A UAM cabin is between 1.5 and 2.1 m across. Whatever number the model gives
# for that width says which unit it was drawn in; OpenVSP does not record one.
FEET = 0.3048
CABIN_WIDTH_M = (1.4, 2.2)

# Seat and panel sizes in metres, scaled into model units once the unit is known.
SEAT_WIDTH = .50
SEAT_DEPTH = .52
SEAT_PAN = .42          # height of the seat pan above the cabin floor
SEAT_BACK = .62
AISLE = .14
PANEL_DROP = .30        # screen centre below the eye
SCREEN_W = .20
SCREEN_H = .16
SCREEN_GAP = .035
EYE_ABOVE_PAN = .68


def bounds(points):
    lo = [min(p[axis] for p in points) for axis in range(3)]
    hi = [max(p[axis] for p in points) for axis in range(3)]
    return lo, hi


class Airframe:
    def __init__(self, folder: Path):
        self.folder = folder
        self.parts = json.loads((folder / 'parts.json').read_text(encoding='utf-8'))
        self.glb = folder / f"{Path(self.parts['model']).stem}.glb"
        self.doc, self.blob = read_glb(self.glb)
        self.by_name = {node.get('name', ''): at for at, node in enumerate(self.doc['nodes'])}
        self.types = {f"VSP_{geom['name']}": geom['type'] for geom in self.parts['geoms']}

    def positions(self, at: int):
        prim = self.doc['meshes'][self.doc['nodes'][at]['mesh']]['primitives'][0]
        return read_accessor(self.doc, self.blob, prim['attributes']['POSITION'])

    # ---------------------------------------------------------------- measure

    def fuselage(self) -> int:
        """The body with people in it: the largest Fuselage-type part. Rotor
        supports and fairings are Fuselage geoms too, and much smaller."""
        best, best_volume = None, 0.0
        for name, at in self.by_name.items():
            if self.types.get(name) != 'Fuselage' or 'mesh' not in self.doc['nodes'][at]:
                continue
            lo, hi = bounds(self.positions(at))
            volume = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])
            if volume > best_volume:
                best, best_volume = at, volume
        if best is None:
            raise SystemExit('no fuselage geom in this model')
        return best

    def envelope(self, at: int) -> dict:
        """Where the cabin is, which way the nose points, and in what unit."""
        xyz = self.positions(at)
        lo, hi = bounds(xyz)
        span = hi[2] - lo[2]
        # Width profile along the long axis. The nose is the end that tapers to
        # nothing over a shorter run; the tail boom tapers further and thinner.
        slices = []
        for step in range(20):
            a, b = lo[2] + span * step / 20, lo[2] + span * (step + 1) / 20
            band = [p for p in xyz if a <= p[2] < b]
            slices.append(0.0 if not band
                          else max(p[0] for p in band) - min(p[0] for p in band))
        widest = max(slices)
        front = sum(slices[:4]) / 4
        back = sum(slices[-4:]) / 4
        nose_at_low_z = front > back          # the tail is the thinner end
        # The cabin is the run that stays near full width.
        keep = [step for step, width in enumerate(slices) if width > widest * .80]
        first, last = min(keep), max(keep) + 1
        z0, z1 = lo[2] + span * first / 20, lo[2] + span * last / 20
        band = [p for p in xyz if z0 <= p[2] <= z1]
        blo, bhi = bounds(band)
        width = bhi[0] - blo[0]
        unit = FEET if width * FEET < CABIN_WIDTH_M[1] else 1.0
        if not CABIN_WIDTH_M[0] <= width * unit <= CABIN_WIDTH_M[1]:
            unit = 1.0 if CABIN_WIDTH_M[0] <= width <= CABIN_WIDTH_M[1] else unit
        height = bhi[1] - blo[1]
        return {'node': at, 'lo': lo, 'hi': hi, 'z0': z0, 'z1': z1,
                'blo': blo, 'bhi': bhi, 'width': width, 'height': height,
                'nose_low_z': nose_at_low_z, 'unit': unit,
                'floor': blo[1] + height * .16,
                'cabin_width_m': round(width * unit, 3),
                'cabin_length_m': round((z1 - z0) * unit, 3),
                'cabin_height_m': round(height * unit, 3)}


def plan(env: dict, seats: int) -> dict:
    """Where everything goes, worked out once. Glazing needs to know where the
    eye and the front row are -- a canopy is defined by what has to be seen
    through it, not by a band chosen in advance."""
    unit = env['unit']
    to_model = (lambda metres: metres / unit) if unit != 1.0 else (lambda metres: metres)
    forward = -1 if env['nose_low_z'] else 1
    nose_end = env['z0'] if env['nose_low_z'] else env['z1']
    seat_w, seat_d = to_model(SEAT_WIDTH), to_model(SEAT_DEPTH)
    pan = to_model(SEAT_PAN)
    rows = max(1, math.ceil(seats / 2))
    return {'to_model': to_model, 'forward': forward, 'nose_end': nose_end,
            'tip': env['lo'][2] if env['nose_low_z'] else env['hi'][2],
            'centre_x': (env['blo'][0] + env['bhi'][0]) / 2,
            'seat_w': seat_w, 'seat_d': seat_d, 'pan': pan,
            'back': to_model(SEAT_BACK), 'pitch': seat_d + to_model(.22),
            'offset': (seat_w + to_model(AISLE)) / 2, 'rows': rows,
            'first_row': nose_end - forward * (env['z1'] - env['z0']) * .22,
            'panel_z': nose_end - forward * to_model(.12),
            'eye_y': env['floor'] + pan + to_model(EYE_ABOVE_PAN)}


# ---------------------------------------------------------------------- glazing

def glaze(air: Airframe, env: dict, layout: dict, glass: int) -> dict:
    """Move the window triangles onto the glass material. The vertices they use
    are the fuselage's own and are not touched, so the shape is unchanged."""
    doc, blob = air.doc, air.blob
    prim = doc['meshes'][doc['nodes'][env['node']]['mesh']]['primitives'][0]
    xyz = read_accessor(doc, blob, prim['attributes']['POSITION'])
    normal = read_accessor(doc, blob, prim['attributes']['NORMAL'])
    index = [value[0] for value in read_accessor(doc, blob, prim['indices'])]
    floor, height = env['floor'], env['height']
    low = floor + height * .18                    # above the seat pan
    high = floor + height * .72                   # below the cabin roof
    # Everything forward of the front row is canopy: that is the glass the seated
    # eye has to see through, and on these airframes the front of the cabin
    # slopes straight into the nose with no separate windscreen panel to find.
    ahead_of = layout['first_row']
    canopy_lo = floor + height * .18
    windows, solid = [], []
    for at in range(0, len(index), 3):
        corners = index[at:at + 3]
        mid = [sum(xyz[c][axis] for c in corners) / 3 for axis in range(3)]
        face = [sum(normal[c][axis] for c in corners) / 3 for axis in range(3)]
        length = math.sqrt(sum(value * value for value in face)) or 1.0
        face = [value / length for value in face]
        # Side windows: the cabin band, above the seat pan, facing outward.
        side = (env['z0'] <= mid[2] <= env['z1'] and low <= mid[1] <= high
                and abs(face[0]) > .55)
        # Windscreen: the whole nose cone ahead of the cabin, at eye height. A
        # blunt UAM nose has almost no triangle facing far enough forward to be
        # found by its normal, which is why the direction is not tested here.
        ahead = mid[2] <= ahead_of if env['nose_low_z'] else mid[2] >= ahead_of
        canopy = ahead and mid[1] >= canopy_lo
        (windows if side or canopy else solid).extend(corners)
    if len(windows) < 30:                          # nothing sensible to glaze
        return {'window_triangles': 0}
    prim['indices'] = add_accessor(doc, blob, [(value,) for value in solid],
                                   kind='SCALAR', component=5125, target=34963)
    doc['meshes'][doc['nodes'][env['node']]['mesh']]['primitives'].append({
        'attributes': dict(prim['attributes']),
        'indices': add_accessor(doc, blob, [(value,) for value in windows],
                                kind='SCALAR', component=5125, target=34963),
        'material': glass})
    return {'window_triangles': len(windows) // 3, 'solid_triangles': len(solid) // 3}


# ---------------------------------------------------------------------- furnish

def furnish(air: Airframe, env: dict, layout: dict, seats: int, materials: dict) -> dict:
    """Floor, seats, occupants and an instrument panel, fitted to the measured
    envelope. Illustrative geometry, not certified cabin dimensions."""
    doc, blob = air.doc, air.blob
    to_model = layout['to_model']
    floor = env['floor']
    z0, z1 = env['z0'], env['z1']
    forward, nose_end, centre_x = layout['forward'], layout['nose_end'], layout['centre_x']
    seat_w, seat_d = layout['seat_w'], layout['seat_d']
    pan, back, pitch = layout['pan'], layout['back'], layout['pitch']
    per_row, rows, offset = 2, layout['rows'], layout['offset']

    nodes: list[int] = []
    cabin_children: list[int] = []

    def place(name, mesh_index, translation, scale=None):
        node = {'name': name, 'mesh': mesh_index,
                'translation': [round(value, 5) for value in translation]}
        if scale:
            node['scale'] = [round(value, 6) for value in scale]
        doc['nodes'].append(node)
        return len(doc['nodes']) - 1

    # A floor, so the cabin does not read as furniture floating in a shell.
    deck = rounded_box(doc, blob, [env['width'] * .86, to_model(.04), (z1 - z0) * .86],
                       to_model(.03), materials['cabin'])
    cabin_children.append(place('Cabin_floor', deck, [centre_x, floor, (z0 + z1) / 2]))

    # Rows run back from just behind the panel.
    first_row = layout['first_row']
    viewpoints, occupant_nodes, seat_nodes = [], [], []
    made = 0
    for row in range(rows):
        z = first_row - forward * row * pitch
        for side in range(per_row):
            if made >= seats:
                break
            made += 1
            x = centre_x + (offset if side else -offset)
            cushion = rounded_box(doc, blob, [seat_w, to_model(.10), seat_d],
                                  to_model(.05), materials['seat'])
            rest = rounded_box(doc, blob, [seat_w, back, to_model(.10)],
                               to_model(.05), materials['seat'])
            name = f'Cabin_passenger_{made:02d}'
            cabin_children.append(place(name, cushion, [x, floor + pan, z]))
            cabin_children.append(place(f'{name}_back', rest,
                                        [x, floor + pan + back / 2, z + forward * -seat_d / 2]))
            seat_nodes.append(name)
            # An occupant, scaled away by default: the cabin is shown empty
            # unless someone asks for the seated illustration.
            body = ellipsoid(doc, blob, materials['occupant'])
            occupant = f'Cabin_occupant_{made:02d}'
            nodes.append(place(occupant, body,
                               [x, floor + pan + to_model(.34), z + forward * to_model(.02)],
                               [to_model(.22), to_model(.42), to_model(.20)]))
            occupant_nodes.append(occupant)
            viewpoints.append({'id': f'seat_{made:02d}', 'label': f'승객석 {made}',
                               'eye': [round(x, 4), round(floor + pan + to_model(EYE_ABOVE_PAN), 4),
                                       round(z, 4)],
                               'occupant_node': occupant})
    cabin_children.extend(nodes)

    # The instrument panel: a shelf across the front of the cabin, with the
    # three screens the cockpit panel projects onto it.
    panel_z, eye_y = layout['panel_z'], layout['eye_y']
    panel_y = eye_y - to_model(PANEL_DROP)
    shelf = rounded_box(doc, blob, [env['width'] * .70, to_model(.34), to_model(.07)],
                        to_model(.03), materials['cabin'])
    cabin_children.append(place('Cabin_panel', shelf, [centre_x, panel_y, panel_z]))
    screen_w, screen_h = to_model(SCREEN_W), to_model(SCREEN_H)
    step = screen_w + to_model(SCREEN_GAP)
    screens = []
    for at, name in enumerate(('pfd', 'nav', 'system')):
        x = centre_x + (at - 1) * step
        face = build_mesh(doc, blob, f'Cabin_screen_{name}',
                          [(-screen_w / 2, -screen_h / 2, 0), (screen_w / 2, -screen_h / 2, 0),
                           (screen_w / 2, screen_h / 2, 0), (-screen_w / 2, screen_h / 2, 0)],
                          [(0, 0, -forward)] * 4, [0, 1, 2, 0, 2, 3], materials['screen'])
        cabin_children.append(place(f'Cabin_screen_{name}', face,
                                    [x, panel_y + to_model(.02),
                                     panel_z - forward * to_model(.045)]))
        screens.append({'id': name,
                        'center': [round(x, 4), round(panel_y + to_model(.02), 4),
                                   round(panel_z - forward * to_model(.045), 4)],
                        'width': round(screen_w, 4), 'height': round(screen_h, 4),
                        'right': [1, 0, 0], 'up': [0, 1, 0]})

    doc['nodes'].append({'name': 'AeroDT_Cabin', 'children': cabin_children})
    doc['scenes'][0]['nodes'].append(len(doc['nodes']) - 1)
    front = viewpoints[0]['eye'] if viewpoints else [centre_x, eye_y, panel_z]
    return {'cockpit': {'schema_version': 1, 'viewpoints': viewpoints,
                        'occupant_nodes': occupant_nodes, 'occupant_default_scale': 0.0001,
                        'eye': [round(value, 4) for value in front],
                        'forward': [0, 0, forward], 'up': [0, 1, 0],
                        'passenger_seats': made, 'screens': screens,
                        'seat_nodes': seat_nodes,
                        'interior': 'AeroDT_Cabin: illustrative geometry fitted to the measured '
                                    'fuselage envelope, not certified cabin dimensions',
                        'coordinate_frame': 'openvsp_glb_scene_before_display_scale'},
            'rows': rows, 'seats': made}


# ------------------------------------------------------------------------ paint

PAINT = {
    'airframe': {'name': 'AeroDT_Airframe', 'pbrMetallicRoughness': {
        'baseColorFactor': [.923, .933, .941, 1], 'metallicFactor': .08, 'roughnessFactor': .42}},
    'rotor': {'name': 'AeroDT_Rotor', 'pbrMetallicRoughness': {
        'baseColorFactor': [.129, .145, .161, 1], 'metallicFactor': .25, 'roughnessFactor': .38}},
    'duct': {'name': 'AeroDT_Duct', 'pbrMetallicRoughness': {
        'baseColorFactor': [.258, .353, .404, 1], 'metallicFactor': .18, 'roughnessFactor': .45}},
    'gear': {'name': 'AeroDT_Gear', 'pbrMetallicRoughness': {
        'baseColorFactor': [.365, .404, .435, 1], 'metallicFactor': .35, 'roughnessFactor': .50}},
    'glass': {'name': 'AeroDT_Glazing', 'alphaMode': 'BLEND', 'doubleSided': True,
              'pbrMetallicRoughness': {'baseColorFactor': [.784, .855, .890, .16],
                                       'metallicFactor': 0, 'roughnessFactor': .10}},
    'cabin': {'name': 'AeroDT_Cabin_Trim', 'pbrMetallicRoughness': {
        'baseColorFactor': [.208, .231, .251, 1], 'metallicFactor': .05, 'roughnessFactor': .68}},
    'seat': {'name': 'AeroDT_Seat', 'pbrMetallicRoughness': {
        'baseColorFactor': [.129, .180, .208, 1], 'metallicFactor': 0, 'roughnessFactor': .85}},
    'occupant': {'name': 'AeroDT_Occupant', 'pbrMetallicRoughness': {
        'baseColorFactor': [.451, .494, .533, 1], 'metallicFactor': 0, 'roughnessFactor': .90}},
    'screen': {'name': 'AeroDT_Screen', 'emissiveFactor': [.055, .208, .251],
               'pbrMetallicRoughness': {'baseColorFactor': [.020, .063, .078, 1],
                                        'metallicFactor': 0, 'roughnessFactor': .30}},
}

DUCT_WORDS = ('duct', 'shroud', 'cowl', 'nacelle', 'fan')
GEAR_WORDS = ('gear', 'strut', 'skid', 'wheel')


def repaint(air: Airframe) -> dict:
    """One material per role, chosen from the part's own name and Geom type."""
    doc = air.doc
    doc['materials'] = [json.loads(json.dumps(PAINT[key])) for key in PAINT]
    slot = {key: at for at, key in enumerate(PAINT)}
    counts = {key: 0 for key in PAINT}
    for at, node in enumerate(doc['nodes']):
        if 'mesh' not in node:
            continue
        name = node.get('name', '')
        lower = name.lower()
        if name.startswith('AeroDT_Rotor') or 'blade' in lower or 'prop' in lower:
            key = 'rotor'
        elif any(word in lower for word in DUCT_WORDS):
            key = 'duct'
        elif any(word in lower for word in GEAR_WORDS):
            key = 'gear'
        else:
            key = 'airframe'
        counts[key] += 1
        for prim in doc['meshes'][node['mesh']]['primitives']:
            prim['material'] = slot[key]
    return {'slots': slot, 'painted': counts}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--build', required=True, type=Path, help='folder openvsp_parts.py wrote')
    ap.add_argument('--seats', type=int, default=6)
    args = ap.parse_args()
    air = Airframe(args.build)
    fuselage = air.fuselage()
    env = air.envelope(fuselage)
    layout = plan(env, args.seats)
    paint = repaint(air)
    glazing = glaze(air, env, layout, paint['slots']['glass'])
    cabin = furnish(air, env, layout, args.seats, paint['slots'])
    write_glb(air.glb, air.doc, air.blob)
    whole = []
    for node in air.doc['nodes']:
        if 'mesh' in node and not node.get('name', '').startswith('Cabin_'):
            shift = node.get('translation', [0, 0, 0])
            lo, hi = bounds(air.positions(air.by_name[node['name']]))
            whole.append([[lo[a] + shift[a], hi[a] + shift[a]] for a in range(3)])
    extent = [round(max(p[a][1] for p in whole) - min(p[a][0] for p in whole), 4)
              for a in range(3)] if whole else [0, 0, 0]
    report = {'fuselage': air.doc['nodes'][fuselage]['name'],
              'extent': extent, 'extent_m': round(max(extent) * env['unit'], 3),
              'unit': 'feet' if env['unit'] == FEET else 'model units taken as metres',
              'nose': '-Z' if env['nose_low_z'] else '+Z',
              'cabin_m': {'width': env['cabin_width_m'], 'length': env['cabin_length_m'],
                          'height': env['cabin_height_m']},
              **glazing, **{k: v for k, v in cabin.items() if k != 'cockpit'},
              'materials': paint['painted'], 'bytes': air.glb.stat().st_size}
    merged = air.parts | {'cabin': report, 'cockpit': cabin['cockpit']}
    (args.build / 'parts.json').write_text(json.dumps(merged, indent=2), encoding='utf-8')
    print(f"{args.build.name}: {report['fuselage']} · nose {report['nose']} · {report['unit']}")
    print(f"  cabin {report['cabin_m']['width']} x {report['cabin_m']['length']} x "
          f"{report['cabin_m']['height']} m · {cabin['seats']} seats in {cabin['rows']} rows")
    print(f"  glazed {glazing.get('window_triangles', 0)} triangles · "
          f"3 screens · {air.glb.stat().st_size:,} bytes")
    return 0


if __name__ == '__main__':
    sys.exit(main())
