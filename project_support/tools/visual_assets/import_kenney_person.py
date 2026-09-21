"""Import one CC0 passenger prototype; preserve geometry and animation channels."""
import argparse
import json
import struct
import zipfile
from pathlib import Path
from asset_library import ROOT, LIBRARY, add_asset, write_json


def embed_texture(raw, texture):
    length = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20 + length])
    offset = 20 + length
    binary_length = struct.unpack_from('<I', raw, offset)[0]
    binary = raw[offset + 8:offset + 8 + binary_length]
    binary += b'\0' * (-len(binary) % 4)
    view = len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(texture)})
    binary += texture
    doc['images'][0].pop('uri')
    doc['images'][0].update(bufferView=view, mimeType='image/png')
    doc['buffers'][0]['byteLength'] = len(binary)
    body = json.dumps(doc, separators=(',', ':')).encode()
    body += b' ' * (-len(body) % 4)
    binary += b'\0' * (-len(binary) % 4)
    return (struct.pack('<4sII', b'glTF', 2, 28 + len(body) + len(binary))
            + struct.pack('<I4s', len(body), b'JSON') + body
            + struct.pack('<I4s', len(binary), b'BIN\0') + binary), doc


def import_person(character):
    archive = ROOT / 'data/workspace/visual_assets/downloads/kenney_blocky_characters_20.zip'
    with zipfile.ZipFile(archive) as package:
        raw, doc = embed_texture(package.read(f'Models/GLB format/character-{character}.glb'),
                                 package.read(f'Models/GLB format/Textures/texture-{character}.png'))
        meta = add_asset(LIBRARY, f'kenney_blocky_person_{character}', 'people/civilian', raw, {
            'title': f'Kenney Blocky Person {character.upper()} — passenger prototype',
            'representation': 'representative',
            'aliases': [f'passenger_prototype_{character}'],
            'source': {'provider': 'Kenney', 'url': 'https://kenney.nl/assets/blocky-characters',
                       'original_file': f'Models/GLB format/character-{character}.glb', 'version': '2.0'},
            'rights': {'label': 'CC0-1.0', 'url': 'https://creativecommons.org/publicdomain/zero/1.0/',
                       'credit': 'Kenney', 'public_export': True,
                       'note': 'CC0 per included License.txt. Personal, educational and commercial use permitted.'},
            'display': {'scale_basis': 'Original GLB coordinates retained; human height not calibrated.'},
            'conversion': {'operation': 'embed_texture',
                           'note': 'Embedded the original PNG; positions, node transforms and animation channels unchanged.'},
            'animation_clips': [a['name'] for a in doc.get('animations', [])],
        })
        directory = LIBRARY / f'people/civilian/kenney_blocky_person_{character}'
        (directory / 'license.txt').write_bytes(package.read('License.txt'))
        (directory / 'source_preview.png').write_bytes(package.read(f'Previews/character-{character}.png'))
        (directory / 'README.md').write_text(
            '# 승객 모사 초안용 사람 모델\n\n'
            f'Kenney Blocky Characters 2.0, character-{character}. CC0.\n'
            '원본 PNG를 포함한 단일 GLB이며 형상과 동작은 그대로다.\n'
            'idle, walk, sit 등 27개 부품별 애니메이션. 스키닝 리그는 없다.\n'
            '원본 크기는 인체 실측 치수가 아니므로 배치 전 키를 보정해야 한다.\n'
            'source_preview.png는 제작자 제공 그림이며 앱 렌더 검증 자료가 아니다.\n'
            '탑승 경로, 문 통과, 좌석 정렬, 승객 상태 로직은 아직 구현하지 않았다.\n', encoding='utf-8')
    catalog_path = LIBRARY / 'catalog.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    if not any(a['asset_id'] == meta['asset_id'] for a in catalog['assets']):
        catalog['assets'].append({'asset_id': meta['asset_id'],
                                 'metadata': f'people/civilian/kenney_blocky_person_{character}/asset.json'})
        write_json(catalog_path, catalog)
    print(f'Imported kenney_blocky_person_{character}:', len(raw), 'bytes; 27 clips; no skin rig')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--characters', default='b', help='Selected source variants, e.g. abcefijkmpq')
    args = parser.parse_args()
    if not args.characters or any(c not in 'abcdefghijklmnopqr' for c in args.characters):
        parser.error('Unknown character variant')
    for character in dict.fromkeys(args.characters):
        import_person(character)
