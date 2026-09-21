"""Turn an OpenVSP model into a rigged glTF binary, part by part.

A single OpenVSP export welds the whole aircraft into one MeshGeom, which leaves
the rotors unable to turn -- the same problem the Unreal exports had, solved
afterwards by guessing which triangles were blades. OpenVSP does not need to be
guessed at: it already knows which Geom is a Propeller, where its hub sits, how
many blades it has and how far its mast is tilted. So each Geom is exported on
its own and the declared numbers are carried through to the rig.

What is measured and what is declared is kept apart. Hub positions, mast angles
and blade counts come from the model's own parameters. The nose direction and
the metre scale do not: OpenVSP carries no unit and no nose convention, so those
stay unverified here and are settled by whoever writes the intake spec.

    python project_support/tools/visual_assets/openvsp_parts.py \
        --model data/workspace/visual_assets/intake_nasa/vsp/sbs.vsp3 \
        --out data/workspace/visual_assets/intake_nasa/build/sbs
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VSPSCRIPT = ROOT / 'project_support/environment/openvsp/OpenVSP-3.51.3-win64/vspscript.exe'

# OpenVSP is +X aft, +Y starboard, +Z up. glTF is +Y up with the nose toward -Z.
# (x, y, z) -> (y, z, x) is a cyclic permutation, so it keeps the right-handed
# frame and puts the longitudinal axis on Z without mirroring anything. Which
# end of that axis is the nose is not declared by OpenVSP and is not assumed.
def to_gltf(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (y, z, x)


# The parameters worth carrying into a rig. Anything else stays in the model.
WANTED = ('X_Location', 'Y_Location', 'Z_Location', 'X_Rotation', 'Y_Rotation', 'Z_Rotation',
          'Diameter', 'NumBlade', 'Rotate', 'ReverseFlag')

SCRIPT = '''
void main()
{{
    ReadVSPFile( "{model}" );
    array< string > @geoms = FindGeoms();
    for ( uint i = 0; i < geoms.size(); i++ )
    {{
        string id = geoms[i];
        Print( "META|" + i + "|" + GetGeomTypeName( id ) + "|" + GetGeomName( id )
               + "|" + GetGeomParent( id ) );
        array< string > @parms = GetGeomParmIDs( id );
        for ( uint p = 0; p < parms.size(); p++ )
        {{
            string name = GetParmName( parms[p] );
            {wanted}
            Print( "PARM|" + i + "|" + name + "|" + GetParmVal( parms[p] ) );
        }}
    }}
    for ( uint i = 0; i < geoms.size(); i++ )
    {{
        // Each OBJ export runs CompGeom, which leaves its result behind as a new
        // MeshGeom. That geom is not in the list captured above, so its set flags
        // are never cleared and the next export carries the previous part along
        // with it -- every file ends up holding the whole accumulated aircraft.
        array< string > @stale = FindGeoms();
        for ( uint k = 0; k < stale.size(); k++ )
            if ( GetGeomTypeName( stale[k] ) == "Mesh" ) DeleteGeom( stale[k] );
        array< string > @live = FindGeoms();
        for ( uint k = 0; k < live.size(); k++ ) SetSetFlag( live[k], 3, false );
        SetSetFlag( geoms[i], 3, true );
        ExportFile( "{out}/part_" + i + ".obj", 3, EXPORT_OBJ );
        Print( "PART|" + i );
    }}
    Print( "END" );
}}
'''


def script_for(model: Path, out: Path) -> str:
    keep = ' && '.join(f'name != "{name}"' for name in WANTED)
    return SCRIPT.format(model=model.as_posix(), out=out.as_posix(),
                         wanted=f'if ( {keep} ) continue;')


def run_vsp(model: Path, out: Path) -> str:
    """Run the batch interpreter and hand back everything it printed."""
    if not VSPSCRIPT.exists():
        raise SystemExit(f'OpenVSP is not unpacked at {VSPSCRIPT}')
    out.mkdir(parents=True, exist_ok=True)
    script = out / 'export.vspscript'
    script.write_text(script_for(model, out), encoding='ascii')
    done = subprocess.run([str(VSPSCRIPT), '-script', str(script)],
                          capture_output=True, text=True, cwd=ROOT)
    if 'END' not in done.stdout:
        raise SystemExit(f'OpenVSP did not finish:\n{done.stdout[-2000:]}\n{done.stderr[-2000:]}')
    return done.stdout


def parse(output: str) -> list[dict]:
    """The printed lines back into one record per Geom."""
    parts: dict[int, dict] = {}
    for line in output.splitlines():
        line = line.strip()
        fields = line.split('|')
        if fields[0] == 'META' and len(fields) >= 5:
            index = int(fields[1])
            parts[index] = {'index': index, 'type': fields[2].strip(),
                            'name': fields[3].strip(), 'parent': fields[4].strip(), 'parms': {}}
        elif fields[0] == 'PARM' and len(fields) >= 4 and int(fields[1]) in parts:
            try:
                parts[int(fields[1])]['parms'][fields[2].strip()] = float(fields[3])
            except ValueError:
                pass
    return [parts[key] for key in sorted(parts)]


def read_obj(path: Path) -> tuple[list[tuple[float, float, float]], list[int]]:
    """OpenVSP writes plain v/f triangles with no normals and no groups."""
    positions: list[tuple[float, float, float]] = []
    indices: list[int] = []
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if line.startswith('v '):
            x, y, z = (float(value) for value in line.split()[1:4])
            positions.append(to_gltf(x, y, z))
        elif line.startswith('f '):
            corners = [int(field.split('/')[0]) for field in line.split()[1:]]
            corners = [c - 1 if c > 0 else len(positions) + c for c in corners]
            for at in range(1, len(corners) - 1):      # a fan covers quads too
                indices.extend((corners[0], corners[at], corners[at + 1]))
    return positions, indices


def normals_for(positions, indices) -> list[tuple[float, float, float]]:
    """Area-weighted vertex normals. The export carries none and a renderer
    without them lights every surface flat."""
    total = [[0.0, 0.0, 0.0] for _ in positions]
    for at in range(0, len(indices), 3):
        a, b, c = indices[at], indices[at + 1], indices[at + 2]
        pa, pb, pc = positions[a], positions[b], positions[c]
        u = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        v = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        face = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        for corner in (a, b, c):
            for axis in range(3):
                total[corner][axis] += face[axis]
    out = []
    for vector in total:
        length = (vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2) ** .5
        out.append((0.0, 1.0, 0.0) if length < 1e-12
                   else (vector[0] / length, vector[1] / length, vector[2] / length))
    return out


def hub_of(part: dict) -> tuple[float, float, float]:
    parms = part['parms']
    return to_gltf(parms.get('X_Location', 0.0), parms.get('Y_Location', 0.0),
                   parms.get('Z_Location', 0.0))


# Rotor_1_blades, Rotor_1_hub, Rotor_1_cowling and EngineGroup_1 are one nacelle:
# on a tiltrotor they swing together. The grouping is the source's own naming,
# not a guess about geometry.
GROUP = re.compile(r'(rotor|prop|nacelle|engine(?:group)?|motor)[_\- ]?(\d+)', re.I)

# An actuator disk is an analysis surface, not airframe: OpenVSP draws the swept
# disc so that a rotor's inflow can be modelled. Rendered, it is a solid plate
# hanging where the air should be. Mass and CG markers are likewise not shape.
NOT_SHAPE = re.compile(r'(_disk|_disc|disk|_mass|_cg|ndarc)', re.I)


def group_of(name: str) -> str | None:
    found = GROUP.search(name)
    return f'rotor_{int(found.group(2))}' if found else None


class Builder:
    """Accumulates meshes into one binary glTF buffer."""

    def __init__(self):
        self.blob = bytearray()
        self.views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.nodes: list[dict] = []

    def _view(self, payload: bytes, target: int | None) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        view = {'buffer': 0, 'byteOffset': len(self.blob), 'byteLength': len(payload)}
        if target is not None:
            view['target'] = target
        self.blob.extend(payload)
        self.views.append(view)
        return len(self.views) - 1

    def _vectors(self, values) -> int:
        payload = b''.join(struct.pack('<fff', *value) for value in values)
        view = self._view(payload, 34962)
        low = [min(value[axis] for value in values) for axis in range(3)]
        high = [max(value[axis] for value in values) for axis in range(3)]
        self.accessors.append({'bufferView': view, 'componentType': 5126, 'count': len(values),
                               'type': 'VEC3', 'min': low, 'max': high})
        return len(self.accessors) - 1

    def _indices(self, values) -> int:
        payload = struct.pack(f'<{len(values)}I', *values)
        view = self._view(payload, 34963)
        self.accessors.append({'bufferView': view, 'componentType': 5125,
                               'count': len(values), 'type': 'SCALAR'})
        return len(self.accessors) - 1

    def add(self, name: str, positions, indices, translation=None, material: int = 0) -> int:
        mesh = {'primitives': [{'attributes': {'POSITION': self._vectors(positions),
                                               'NORMAL': self._vectors(normals_for(positions, indices))},
                                'indices': self._indices(indices), 'material': material}], 'name': name}
        self.meshes.append(mesh)
        node = {'name': name, 'mesh': len(self.meshes) - 1}
        if translation and any(abs(value) > 1e-9 for value in translation):
            node['translation'] = [round(value, 6) for value in translation]
        self.nodes.append(node)
        return len(self.nodes) - 1

    def write(self, path: Path, materials, roots: list[int]) -> None:
        doc = {'asset': {'version': '2.0', 'generator': 'AeroDT openvsp_parts.py'},
               'scene': 0, 'scenes': [{'nodes': roots}], 'nodes': self.nodes,
               'meshes': self.meshes, 'materials': materials, 'accessors': self.accessors,
               'bufferViews': self.views, 'buffers': [{'byteLength': len(self.blob)}]}
        text = json.dumps(doc, separators=(',', ':')).encode('utf-8')
        text += b' ' * (-len(text) % 4)
        blob = bytes(self.blob) + b'\x00' * (-len(self.blob) % 4)
        body = (struct.pack('<II', len(text), 0x4E4F534A) + text
                + struct.pack('<II', len(blob), 0x004E4942) + blob)
        path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


MATERIALS = [
    {'name': 'airframe', 'pbrMetallicRoughness': {
        'baseColorFactor': [.88, .90, .92, 1], 'metallicFactor': .1, 'roughnessFactor': .55}},
    {'name': 'rotor', 'pbrMetallicRoughness': {
        'baseColorFactor': [.20, .22, .25, 1], 'metallicFactor': .2, 'roughnessFactor': .45}},
]


def assemble(parts: list[dict], folder: Path, out: Path) -> dict:
    """One node per Geom; a propeller's vertices are rewritten about its own hub
    and the hub is carried by the node, so the node can be turned. Each nacelle
    gets a hinge node above it so the whole group can be tilted together."""
    builder = Builder()
    groups: dict[str, list[int]] = {}
    loose: list[int] = []
    rotors: list[dict] = []
    skipped: list[str] = []
    for part in parts:
        if NOT_SHAPE.search(part['name']):
            skipped.append(f"{part['name']}: analysis surface, not airframe")
            continue
        source = folder / f"part_{part['index']}.obj"
        if not source.exists():
            skipped.append(f"{part['name']}: not exported")
            continue
        positions, indices = read_obj(source)
        if not positions or not indices:
            skipped.append(f"{part['name']}: empty")
            continue
        spinner = part['type'] == 'Propeller'
        name = f"AeroDT_Rotor_{part['index']}" if spinner else f"VSP_{part['name']}"
        translation = None
        if spinner:
            hub = hub_of(part)
            positions = [(p[0] - hub[0], p[1] - hub[1], p[2] - hub[2]) for p in positions]
            translation = hub
            radius = max((p[0] ** 2 + p[1] ** 2 + p[2] ** 2) ** .5 for p in positions)
            rotors.append({'name': name, 'source_name': part['name'],
                           'hub': [round(value, 5) for value in hub],
                           'blades': int(part['parms'].get('NumBlade', 0)) or None,
                           'declared_diameter': part['parms'].get('Diameter'),
                           'measured_radius': round(radius, 5),
                           'mast_deg': {axis: part['parms'].get(f'{axis}_Rotation', 0.0)
                                        for axis in 'XYZ'}})
        node = builder.add(name, positions, indices, translation, 1 if spinner else 0)
        group = group_of(part['name'])
        (groups.setdefault(group, []) if group else loose).append(node)
    roots = list(loose)
    hinges = []
    for group, children in sorted(groups.items()):
        # The hinge sits at the rotor hub of its own group when there is one, so
        # tilting turns the nacelle about the mast rather than about the origin.
        at = next((rotor['hub'] for rotor in rotors
                   if group_of(rotor['source_name']) == group), [0.0, 0.0, 0.0])
        for child in children:
            node = builder.nodes[child]
            shift = node.get('translation', [0.0, 0.0, 0.0])
            node['translation'] = [round(shift[axis] - at[axis], 6) for axis in range(3)]
            if not any(abs(value) > 1e-9 for value in node['translation']):
                node.pop('translation')
        builder.nodes.append({'name': f'AeroDT_Hinge_{group}', 'children': children,
                              'translation': [round(value, 6) for value in at]})
        hinges.append({'name': f'AeroDT_Hinge_{group}', 'group': group,
                       'pivot': [round(value, 5) for value in at]})
        roots.append(len(builder.nodes) - 1)
    # A nacelle's parts were moved relative to its hinge, so the parts that were
    # not in a group keep the positions the export gave them and need no shift.
    builder.write(out, MATERIALS, roots)
    return {'rotors': rotors, 'hinges': hinges, 'skipped': skipped,
            'nodes': len(builder.nodes), 'meshes': len(builder.meshes)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--model', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--keep-obj', action='store_true')
    args = ap.parse_args()
    work = args.out
    work.mkdir(parents=True, exist_ok=True)
    parts = parse(run_vsp(args.model.resolve(), work.resolve()))
    if not parts:
        raise SystemExit('OpenVSP reported no Geoms')
    glb = work / f'{args.model.stem}.glb'
    report = assemble(parts, work, glb)
    report.update({'model': str(args.model), 'glb': str(glb), 'bytes': glb.stat().st_size,
                   'geoms': [{'name': p['name'], 'type': p['type']} for p in parts]})
    (work / 'parts.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    if not args.keep_obj:
        for obj in work.glob('part_*.obj'):
            obj.unlink()
        shutil.rmtree(work / 'texture', ignore_errors=True)
    print(f"{args.model.name}: {len(parts)} geoms -> {report['nodes']} nodes, "
          f"{len(report['rotors'])} rotors, {len(report['hinges'])} hinges, "
          f"{report['bytes']:,} bytes")
    for note in report['skipped']:
        print('  skipped', note)
    return 0


if __name__ == '__main__':
    sys.exit(main())
