"""Build adult-proportioned boarding illustrations from preserved Kenney GLBs.

The source files stay untouched. Height stays 2.7 file units so the existing
1.65–1.85 m passenger height contract remains valid. These are illustrations,
not anthropometric scans. Write to a staging root and review before installing.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys


def build(root, output):
    sys.path.insert(0, str(root / 'project_support/tools/visual_assets'))
    from split_rotor_nodes import read_glb, write_glb, read_accessor, add_accessor
    records = []
    for path in sorted((root / 'digital_twin/model_library/visual_assets/people/civilian').glob('kenney_blocky_person_*/asset.json')):
        meta = json.loads(path.read_text(encoding='utf-8'))
        original = copy.deepcopy(meta.get('original_model', meta['model']))
        source = path.parent / original['path']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == original['sha256'], source
        doc, binary = read_glb(source)
        names = {n.get('name'): i for i, n in enumerate(doc['nodes'])}
        assert all(name in names for name in ('head', 'arm-left', 'arm-right', 'torso'))
        head = doc['nodes'][names['head']]
        assert head.get('scale') == [.1, .1, .1]
        # The acquired 0.8-unit cube head made up almost a third of the body.
        # With 1.75 m standing height this becomes a 0.24 x 0.25 x 0.26 m head.
        factors = {names['head']: [.6, .4, .7], names['arm-left']: [.5, 1, 1], names['arm-right']: [.5, 1, 1]}
        for index, factor in factors.items():
            node = doc['nodes'][index]
            node['scale'] = [a*b for a,b in zip(node.get('scale', [1,1,1]), factor)]
        # Preserve animation tracks, including the static pose's authored scale.
        for animation in doc.get('animations', []):
            for channel in animation['channels']:
                target = channel['target']
                if target['path'] != 'scale' or target['node'] not in factors:
                    continue
                old = animation['samplers'][channel['sampler']]
                sampler = copy.deepcopy(old)
                values = read_accessor(doc, binary, old['output'])
                values = [[a*b for a,b in zip(v, factors[target['node']])] for v in values]
                sampler['output'] = add_accessor(doc, binary, values, kind='VEC3', component=5126)
                channel['sampler'] = len(animation['samplers'])
                animation['samplers'].append(sampler)
        scene = doc['scenes'][doc.get('scene', 0)]
        assert scene['nodes'] == [0], 'Expected the acquired character root'
        scene['nodes'] = [len(doc['nodes'])]
        # All characters in this family have the same body and 2.7-unit height.
        # New rest top: 0.7 torso + 1.2 head anchor + 0.8*0.4 head = 2.22.
        # The source scene has one character root, at index zero; assert this
        # instead of folding animation-controlled nodes into a guessed frame.
        assert doc['nodes'][0].get('name', '').startswith('character-')
        doc['nodes'].append({'name':'Adult_boarding_proportions', 'children':[0],
                             'scale':[.77, 2.7/2.22, .72]})
        dest = output / path.parent.relative_to(root)
        dest.mkdir(parents=True, exist_ok=True)
        model = dest / 'boarding_model.glb'
        write_glb(model, doc, binary)
        meta['original_model'] = original
        meta['model'] = {**original, 'path':model.name, 'sha256':hashlib.sha256(model.read_bytes()).hexdigest(), 'bytes':model.stat().st_size}
        meta['display'].update(proportion_basis='Adult-proportioned boarding illustration; standing height normalized to 2.7 file units, rendered at 1.65–1.85 m. Original licensed model.glb retained.',
                               native_height=2.7, reference_height_m=1.75)
        (dest/'asset.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        records.append({'asset_id':meta['asset_id'], 'source_sha256':original['sha256'], 'derived_sha256':meta['model']['sha256']})
    return records


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert args.output.resolve() != args.root.resolve(), 'Use a staging root; preserve the live library until reviewed.'
    print(json.dumps(build(args.root, args.output), indent=2))
