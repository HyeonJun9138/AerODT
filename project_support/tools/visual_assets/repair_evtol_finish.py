"""Reduce EVTOL paint sheen, without touching the paint atlas or flight rig."""
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ASSET = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian/amvlab_evtol'

def repair(document):
    result = copy.deepcopy(document)
    for material in result.get('materials', []):
        if material.get('name') != 'evtol_mat':
            continue
        # A moderate satin finish, not a white specular veil over the atlas.
        material.setdefault('pbrMetallicRoughness', {}).update(roughnessFactor=.55, metallicFactor=0)
        extensions = material.setdefault('extensions', {})
        for name in ('KHR_materials_clearcoat', 'KHR_materials_anisotropy', 'KHR_materials_ior'):
            extensions.pop(name, None)
        extensions['KHR_materials_specular'] = {'specularFactor': .25}
    return result

def main():
    from recolour_evtol_livery import read_glb, write_glb
    meta = json.loads((ASSET / 'asset.json').read_text(encoding='utf-8'))
    for key in ('model', 'flight_visual'):
        path = ASSET / meta[key]['path']
        document, chunks = read_glb(path.read_bytes())
        fixed = repair(document)
        # Keep declarations aligned with material extensions still present.
        used = set()
        def walk(value):
            if isinstance(value, dict):
                used.update(value.get('extensions', {}).keys())
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(fixed)
        fixed['extensionsUsed'] = sorted(used)
        if 'extensionsRequired' in fixed:
            fixed['extensionsRequired'] = [x for x in fixed['extensionsRequired'] if x in used]
        data = write_glb(fixed, chunks)
        path.write_bytes(data)
        meta[key]['sha256'] = hashlib.sha256(data).hexdigest()
        if 'bytes' in meta[key]:
            meta[key]['bytes'] = len(data)
    meta['flight_visual']['source_sha256'] = meta['model']['sha256']
    meta['conversion']['note'] = 'Recoloured atlas and EVTOL-only satin reflectance; original geometry preserved.'
    meta['conversion']['finish'] = 'repair_evtol_finish.py: source/flight roughness 0.55, nonmetal, specular factor 0.25; atlas unchanged'
    (ASSET / 'asset.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    catalog_path = ROOT / 'digital_twin/model_library/visual_assets/web_catalog.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    for item in catalog['assets']:
        if item.get('asset_id') == 'amvlab_evtol':
            item['sha256'] = meta['model']['sha256']
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

if __name__ == '__main__':
    main()
