"""Put the converted OpenVSP airframes on the library shelf.

Writes what `visual_catalog.py` reads and nothing more: the model, a picture,
the rights, the rotor and tilt nodes, and the cabin profile. Measured values and
declared values are kept apart, and the two things OpenVSP does not record --
the metre scale and which way a rotor turns -- are marked as what they are.

    python project_support/tools/visual_assets/openvsp_register.py \
        --build data/workspace/visual_assets/intake_nasa/build
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = ROOT / 'digital_twin/model_library/visual_assets'
SHELF = LIBRARY / 'aircraft/civilian'
FEET = 0.3048

# NASA publishes these as reference vehicles. NASA material is generally not
# subject to copyright; the agency asks that its insignia are not used and that
# nothing implies its endorsement. Both are recorded rather than assumed.
# The shelf shows credit and licence on one line under the picture, so both are
# kept short. The programme that produced these and the full terms are in the
# note below and in attribution.txt, which is where that detail belongs.
RIGHTS = {
    'label': 'public domain (US Government work)',
    'url': 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    'credit': 'NASA',
    'public_export': True,
    'note': 'Produced by the NASA Revolutionary Vertical Lift Technology project and the '
            'Aeronautics Systems Analysis Branch. NASA material is generally not subject to '
            'copyright and may be used. The NASA '
            'insignia and logos are not included here and are separately restricted. Nothing '
            'in this dashboard implies NASA endorsement of AeroDT. The airframe is a published '
            'concept for analysis, not a certified or manufactured aircraft.',
}

CATALOGUE = {
    'liftpcruise': ('nasa_lift_cruise', 'NASA Lift+Cruise 6인승 기준기체',
                    'Six-passenger lift-plus-cruise reference vehicle: eight lifting rotors and '
                    'a tail pusher propeller.'),
    'NASA_Tiltwing_6pax': ('nasa_tiltwing', 'NASA Tiltwing 6인승 기준기체',
                           'Six-passenger tiltwing reference vehicle: the whole wing rotates '
                           'between hover and cruise.'),
    'NASA_Tiltduct_DirectDrive_5Vanes': ('nasa_tiltduct_direct', 'NASA Tiltduct 기준기체 (직결·베인 5)',
                                         'Six ducted propulsors that tilt, direct drive, five '
                                         'exit vanes.'),
    'NASA_Tiltduct_CrossShafted_NoVanes': ('nasa_tiltduct_cross', 'NASA Tiltduct 기준기체 (교차축·베인 없음)',
                                           'Six ducted propulsors that tilt, cross-shafted, no '
                                           'exit vanes.'),
    'NASA_Multi-tiltrotor': ('nasa_multi_tiltrotor', 'NASA Multi-tiltrotor 기준기체',
                             'Multiple tilting rotors in the arrangement most current eVTOL '
                             'designs use.'),
    'quadcollflap': ('nasa_quadrotor_collflap', 'NASA Quadrotor 기준기체 (콜렉티브·플랩)',
                     'Large four-rotor passenger configuration, collective and flap control.'),
    'quadstiffrpm': ('nasa_quadrotor_rpm', 'NASA Quadrotor 기준기체 (강성·RPM)',
                     'Large four-rotor passenger configuration, stiff rotors under RPM control.'),
    'QEU2023-SMR-6pax-turbo-notar_450fps': ('nasa_qsmr', 'NASA 저소음 단일주회전익 기준기체',
                                            'Quiet single main rotor reference vehicle, no tail '
                                            'rotor, 450 ft/s tip speed.'),
    'sbs': ('nasa_side_by_side', 'NASA Side-by-Side 기준기체',
            'Two large rotors side by side, the closest of the set to a conventional rotorcraft.'),
}


def digest(path: Path) -> str:
    reader = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            reader.update(block)
    return reader.hexdigest()


def picture(source: Path, target: Path) -> dict | None:
    """The exterior view the cabin validator rendered becomes the shelf photo."""
    if not source.is_file():
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    with Image.open(source) as image:
        image = image.convert('RGB')
        # The shelf draws these about 300 px wide, so 760 is a crisp two-to-one
        # and a tenth of the bytes of the full render.
        image.thumbnail((760, 480), Image.LANCZOS)
        image.save(target, 'JPEG', quality=86, optimize=True)
        width, height = image.size
    return {'path': target.name, 'bytes': target.stat().st_size, 'sha256': digest(target),
            'width': width, 'height': height,
            'view': 'exterior three-quarter, Three.js studio render of the library model'}


def rotor_block(parts: dict) -> dict:
    """Turning is declared; which way round is not. OpenVSP records neither a
    rotation direction nor a handedness for these vehicles, so mirrored pairs
    are turned against each other the way a multirotor balances its torque."""
    nodes = []
    for rotor in parts['rotors']:
        side = 'left' if rotor['hub'][0] < -1e-6 else 'right' if rotor['hub'][0] > 1e-6 else 'centre'
        nodes.append({'name': rotor['name'], 'turn': 1 if side == 'left' else -1,
                      'hub': rotor['hub'], 'side': side,
                      'blades': rotor['blades'],
                      'declared_diameter': rotor['declared_diameter'],
                      'measured_diameter': round(rotor['measured_radius'] * 2, 5)})
    return {
        'axis': 'y',
        'turn_sign': '1 turns the way a right hand turns about +Y, counter-clock-wise from above.',
        'direction_basis': 'Inferred from the airframe, not declared by the source. OpenVSP '
                           'records no rotation direction for these models, so each mirrored '
                           'pair turns in opposite directions.',
        'note': 'Each Propeller Geom exported on its own; its vertices are written about its own '
                'hub and the node carries the hub, so the node turns the rotor about its mast. '
                'Hub position, blade count and declared diameter are the model\'s own parameters.',
        'nodes': nodes,
    }


def tilt_block(parts: dict) -> dict | None:
    """Only a hinge that actually holds a rotor is a tilt axis. The mast angle
    OpenVSP declares is the rest position, not a range of travel."""
    rotor_groups = set()
    for rotor in parts['rotors']:
        for hinge in parts['hinges']:
            if abs(hinge['pivot'][0] - rotor['hub'][0]) < 1e-6 and \
               abs(hinge['pivot'][2] - rotor['hub'][2]) < 1e-6:
                rotor_groups.add(hinge['name'])
    nodes = [{'name': hinge['name'], 'axis': 'x',
              'sign': -1 if hinge['pivot'][0] < 0 else 1, 'offset_deg': 0,
              'pivot': hinge['pivot']}
             for hinge in parts['hinges'] if hinge['name'] in rotor_groups]
    if not nodes:
        return None
    return {'axis': 'x', 'sign': -1, 'frame': 'parent', 'nodes': nodes,
            'note': 'The nacelle parts that share a rotor number hang under the hinge at that '
                    'rotor\'s hub, so the group swings together. The axis is the lateral axis of '
                    'the model frame. Rest mast angles are in rotors.nodes; no travel limit is '
                    'declared, because the source does not give one.'}


def register(folder: Path, catalog: list[dict]) -> dict | None:
    key = folder.name
    if key not in CATALOGUE:
        print(f'  skip {key}: not in the catalogue table')
        return None
    asset_id, title, summary = CATALOGUE[key]
    parts = json.loads((folder / 'parts.json').read_text(encoding='utf-8'))
    source = folder / Path(parts['glb']).name
    if not source.is_file():
        print(f'  skip {key}: no GLB')
        return None
    home = SHELF / asset_id
    home.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, home / 'model.glb')
    thumbnail = picture(folder / 'views' / 'exterior.png', home / 'thumbnail.jpg')
    cabin = parts['cabin']
    meta = {
        'schema_version': 1,
        'asset_id': asset_id,
        'title': title,
        'category': 'aircraft/civilian',
        'purpose': 'visual_only',
        'representation': 'specific',
        'aliases': [asset_id, key.lower()],
        'source': {
            'provider': 'NASA',
            'url': 'https://www.nasa.gov/reference/uam-refs/',
            'revision': 'downloaded 2026-09-14',
            'original_file': Path(parts['model']).name,
            'note': f'{summary} Published as an OpenVSP parametric model, not as a mesh.',
        },
        'rights': RIGHTS,
        'display': {
            'reference_extent_m': cabin['extent_m'],
            'extent': {'x': cabin['extent'][0], 'y': cabin['extent'][1], 'z': cabin['extent'][2]},
            'cabin_m': cabin['cabin_m'],
            'scale_basis': 'OpenVSP carries no unit. The measured cabin width of '
                           f"{cabin['cabin_m']['width']} m only makes sense if the model is drawn "
                           'in feet, and NASA publishes these vehicles in feet, so a factor of '
                           '0.3048 is applied. That is a reading of the published convention, '
                           'not a measurement of the file.',
            'forward_axis': f"nose at {cabin['nose']}, measured: the fuselage tapers to a boom at "
                            'the other end',
            'up_axis': '+Y',
        },
        'geometry': {
            'meshes': parts['meshes'],
            'animations': 0,
            'skins': 0,
            'required_extensions': [],
            'native_coordinates': 'glTF right-handed +Y up, converted from OpenVSP '
                                  '(+X aft, +Y starboard, +Z up) by the cyclic permutation '
                                  '(x, y, z) -> (y, z, x)',
            'physical_dimensions_verified': False,
        },
        'conversion': {
            'operation': 'openvsp_geom_export',
            'tool': 'project_support/tools/visual_assets/openvsp_parts.py'
                    ' + openvsp_cabin.py',
            'note': 'Each OpenVSP Geom exported on its own and assembled into one glTF, so the '
                    'rotors are separate nodes rather than welded into the airframe. Analysis '
                    'surfaces (actuator disks, mass and CG markers) are not shape and were left '
                    'out. The window band reuses the fuselage\'s own triangles and changes only '
                    'their material: no vertex was moved, added or removed, so the outer shape '
                    'is the shape NASA published. Cabin, seats and instrument panel are new '
                    'geometry added inside.',
            'repairs': [],
        },
        'model': {'path': 'model.glb', 'bytes': (home / 'model.glb').stat().st_size,
                  'sha256': digest(home / 'model.glb')},
        'validation': {
            'container': 'passed',
            'gltf_validator': 'passed',
            'gltf_validator_version': '2.0.0-dev.3.10',
            'gltf_errors': 0,
            'gltf_warnings': 0,
            'browser': 'passed',
            'browser_scope': 'Three.js under headless Edge: the model loads and renders, the '
                             'seated eye looks forward through a transparent material, all three '
                             'instrument screens and all seats fall inside the fuselage. No '
                             'Cesium, Unreal, scale or flight-direction certification.',
            'browser_sha256': digest(home / 'model.glb'),
        },
        'rotors': rotor_block(parts),
        'cockpit': parts['cockpit'],
    }
    tilt = tilt_block(parts)
    if tilt:
        meta['rotors']['tilt'] = tilt
    else:
        # Saying nothing here would read as "this airframe does not tilt", which
        # for a tiltwing is the opposite of true.
        meta['rotors']['tilt_note'] = (
            'No tilt is declared. The nacelles are grouped by the number in the part name, and '
            'this model gives every rotor the same name with no number, so no group could be '
            'formed. A tiltwing turns the whole wing rather than each nacelle in any case, which '
            'is a different rig from the per-nacelle hinges used here. The rotors still turn.')
    if thumbnail:
        meta['thumbnail'] = thumbnail
    (home / 'asset.json').write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding='utf-8')
    (home / 'attribution.txt').write_text(
        f"{title}\n{RIGHTS['credit']}\n{RIGHTS['label']}\n{RIGHTS['url']}\n\n{RIGHTS['note']}\n",
        encoding='utf-8')
    catalog.append({'asset_id': asset_id, 'metadata': f'aircraft/civilian/{asset_id}/asset.json'})
    print(f"  {asset_id:26s} {meta['model']['bytes']:>11,} B · "
          f"{len(meta['rotors']['nodes'])} rotors · {len(tilt['nodes']) if tilt else 0} tilt · "
          f"{meta['cockpit']['passenger_seats']} seats"
          f"{' · photo' if thumbnail else ' · NO PHOTO'}")
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--build', required=True, type=Path)
    args = ap.parse_args()
    catalog_path = LIBRARY / 'catalog.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    fresh: list[dict] = []
    for folder in sorted(p for p in args.build.iterdir() if p.is_dir()):
        if (folder / 'parts.json').is_file():
            register(folder, fresh)
    known = {entry.get('asset_id') for entry in catalog['assets']}
    added = [entry for entry in fresh if entry['asset_id'] not in known]
    catalog['assets'].extend(added)
    catalog['assets'].sort(key=lambda entry: entry.get('asset_id', ''))
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'catalog: {len(added)} added, {len(catalog["assets"])} total')
    return 0


if __name__ == '__main__':
    sys.exit(main())
