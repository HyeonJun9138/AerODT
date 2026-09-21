"""Apply clear cockpit glazing to current derived GLBs without rebuilding rigs."""
import copy
import hashlib
import json
import struct
from pathlib import Path

from split_rotor_nodes import read_glb

ROOT = Path(__file__).resolve().parents[3]
LIB = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian'
GLASS_NAMES = {
    'joby_s4': '03_-_Default',
    'projectairsim_airtaxi': 'AirTaxi_Glass',
    'kp2a': 'MI_Glass_Windshield_Tinted',
    'amvlab_evtol': 'AeroDT_Cabin_Glazing',
    'x_57': 'Dark blue cabin glass',
}
NOTE = 'Clear cockpit glazing: clear_uam_glazing.py; pale cool tint, alpha 0.12, nonmetal.'


def clear_material(material):
    """Display-only alpha blending, not physically simulated glass transmission."""
    material['alphaMode'] = 'BLEND'
    material['doubleSided'] = True
    material['pbrMetallicRoughness'] = {
        'baseColorFactor': [.82, .87, .90, .12],
        'roughnessFactor': .12,
        'metallicFactor': 0,
    }
    for key in ('normalTexture', 'occlusionTexture'):
        material.pop(key, None)


def update_asset(directory):
    """Change one named glass material, retaining every non-JSON GLB chunk verbatim."""
    directory = Path(directory)
    name = GLASS_NAMES[directory.name]
    path = directory / 'flight_model.glb'
    raw = path.read_bytes()
    document, binary = read_glb(path)
    matches = [i for i, m in enumerate(document['materials']) if m.get('name') == name]
    if len(matches) != 1:
        raise ValueError(f'{directory.name}: expected one named glazing material, got {matches}')
    before = copy.deepcopy(document)
    index = matches[0]
    clear_material(document['materials'][index])
    restored = copy.deepcopy(document)
    restored['materials'][index] = before['materials'][index]
    assert restored == before, 'Non-glass model data changed'
    if document != before:
        json_length, chunk_type = struct.unpack_from('<II', raw, 12)
        assert chunk_type == 0x4E4F534A, 'Expected glTF JSON first'
        encoded = json.dumps(document, separators=(',', ':')).encode('utf-8')
        encoded += b' ' * (-len(encoded) % 4)
        tail = raw[20 + json_length:]
        output = struct.pack('<III', 0x46546C67, 2, 20 + len(encoded) + len(tail))
        output += struct.pack('<II', len(encoded), chunk_type) + encoded + tail
        path.write_bytes(output)
    after, after_binary = read_glb(path)
    assert after == document and after_binary == binary
    meta_path = directory / 'asset.json'
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    flight = meta['flight_visual']
    assert flight['path'] == path.name
    flight['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    flight['bytes'] = path.stat().st_size
    if NOTE not in flight.get('note', ''):
        flight['note'] = (flight.get('note', '') + ' ' + NOTE).strip()
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'asset_id': directory.name, 'sha256': flight['sha256'],
            'bytes': flight['bytes'], 'binary_unchanged': True,
            'non_glass_document_unchanged': True}


if __name__ == '__main__':
    print(json.dumps([update_asset(LIB / asset) for asset in GLASS_NAMES], indent=2))
