"""Non-NASA premium cabin geometry and preservation regression tests."""
import copy,json,sys,shutil
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'project_support/tools/visual_assets'))
import build_premium_cabins as builder
from split_rotor_nodes import read_glb

@pytest.mark.parametrize('asset_id',list(builder.LAYOUTS))
def test_premium_cabin_preserves_input_geometry_and_profile(asset_id):
    original,binary=read_glb(builder.BACKUP/asset_id/'model.glb')
    current,current_binary=read_glb(builder.LIB/asset_id/'flight_model.glb')
    assert current_binary[:len(binary)]==binary
    for key in ('meshes','materials','accessors','bufferViews'):
        assert current[key][:len(original[key])]==original[key]
    for i,node in enumerate(original['nodes']):
        actual=copy.deepcopy(current['nodes'][i]); expected=copy.deepcopy(node)
        if node.get('extras',{}).get('cabin_role') in ('passenger_seat','pilot_seat') or node.get('name')=='Cabin_refinement_20260917':
            actual.pop('children',None);expected.pop('children',None)
        assert actual==expected
    before=json.loads((builder.BACKUP/asset_id/'asset.json').read_text(encoding='utf-8'))
    after=json.loads((builder.LIB/asset_id/'asset.json').read_text(encoding='utf-8'))
    for key in ('eye','screens','viewpoints','forward','up'):
        assert after['cockpit'].get(key)==before['cockpit'].get(key)
    assert sum(n.get('name')==builder.VERSION for n in current['nodes'])==1


def test_rebuild_is_idempotent_and_nasa_rejected(tmp_path,monkeypatch):
    original_backup=builder.BACKUP
    monkeypatch.setattr(builder,'LIB',tmp_path/'library')
    monkeypatch.setattr(builder,'BACKUP',tmp_path/'backup')
    asset='joby_s4';folder=builder.LIB/asset;folder.mkdir(parents=True)
    meta=json.loads((original_backup/asset/'asset.json').read_text(encoding='utf-8'))
    shutil.copy2(original_backup/asset/'model.glb',folder/meta['flight_visual']['path'])
    (folder/'asset.json').write_text(json.dumps(meta),encoding='utf-8')
    builder.build(asset);first=(folder/meta['flight_visual']['path']).read_bytes()
    builder.build(asset);assert first==(folder/meta['flight_visual']['path']).read_bytes()
    with pytest.raises(AssertionError):builder.build('nasa_anything')
