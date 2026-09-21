"""EVTOL-only reflectance repair must leave geometry, rig and atlas untouched."""
import copy
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

def tool():
    spec = importlib.util.spec_from_file_location('evtol_finish', ROOT / 'project_support/tools/visual_assets/repair_evtol_finish.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def test_finish_is_shared_and_idempotent_without_changing_other_materials():
    source = {'materials': [{'name': 'evtol_mat', 'doubleSided': True,
        'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'roughnessFactor': .75, 'metallicFactor': 0},
        'extensions': {'KHR_materials_specular': {'specularColorFactor': [2, 2, 2]}, 'KHR_materials_ior': {'ior': 1.52}}},
        {'name': 'unrelated', 'pbrMetallicRoughness': {'metallicFactor': 1}}],
        'nodes': [{'name': 'rotor', 'rotation': [0, 0, 0, 1]}]}
    before = copy.deepcopy(source)
    fixed = tool().repair(source)
    assert source == before
    assert fixed['materials'][1] == before['materials'][1]
    assert fixed['nodes'] == before['nodes']
    material = fixed['materials'][0]
    assert material['pbrMetallicRoughness']['baseColorTexture'] == {'index': 0}
    assert material['extensions'] == {'KHR_materials_specular': {'specularFactor': .25}}
    assert material['pbrMetallicRoughness']['roughnessFactor'] == .55
    assert tool().repair(fixed) == fixed

def test_source_and_flight_receive_identical_finish():
    mod = tool()
    source = {'materials': [{'name': 'evtol_mat', 'extensions': {'KHR_materials_ior': {'ior': 1.52}}}]}
    flight = {'materials': [{'name': 'evtol_mat'}]}
    assert mod.repair(source)['materials'] == mod.repair(flight)['materials']

def test_published_evtol_pair_has_same_finish_and_valid_digests():
    import hashlib
    import json
    import struct
    directory = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian/amvlab_evtol'
    meta = json.loads((directory / 'asset.json').read_text(encoding='utf-8'))
    materials = []
    for key in ('model', 'flight_visual'):
        binary = (directory / meta[key]['path']).read_bytes()
        assert hashlib.sha256(binary).hexdigest() == meta[key]['sha256']
        size = struct.unpack_from('<I', binary, 12)[0]
        document = json.loads(binary[20:20+size])
        material = next(m for m in document['materials'] if m['name'] == 'evtol_mat')
        materials.append(material)
        assert material['extensions']['KHR_materials_specular']['specularFactor'] == .25
        assert 'KHR_materials_specular' in document['extensionsUsed']
    assert materials[0] == materials[1]
    assert meta['flight_visual']['source_sha256'] == meta['model']['sha256']
    assert meta['thumbnail']['source_model_sha256'] == meta['flight_visual']['sha256']
