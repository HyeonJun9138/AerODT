"""Cabin/glazing contracts; geometry and rig preservation are checked separately."""
import json, math, sys
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'project_support/tools/visual_assets'))
from split_rotor_nodes import read_glb
LIB=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'
CAPACITIES={'joby_s4':2,'projectairsim_airtaxi':4,'kp2a':6,'amvlab_evtol':8,'x_57':4}
@pytest.mark.parametrize('asset_id,capacity',CAPACITIES.items())
def test_cabin_seats_and_authored_scene_profile(asset_id,capacity):
 meta=json.loads((LIB/asset_id/'asset.json').read_text(encoding='utf-8'))
 assert 'cockpit' in meta
 p=meta['cockpit']; assert p['schema_version']==1
 assert p['passenger_seats']==capacity
 assert p['forward']==[1,0,0] and p['up']==[0,1,0]
 assert len(p['eye'])==3 and all(math.isfinite(v) for v in p['eye'])
 assert len(p['screens'])==3
 for screen in p['screens']:
  assert screen['center'][0]>p['eye'][0] and screen['width']>0 and screen['height']>0
 d,b=read_glb(LIB/asset_id/meta.get('flight_visual',meta['model'])['path'])
 roles=[n.get('extras',{}).get('cabin_role') for n in d['nodes']]
 assert roles.count('pilot_seat')==1 and roles.count('passenger_seat')==capacity
 assert sum(n.get('name')=='AeroDT_Cabin' for n in d['nodes'])==1
@pytest.mark.parametrize('asset_id',CAPACITIES)
def test_glazing_is_separate_from_opaque_airframe(asset_id):
 meta=json.loads((LIB/asset_id/'asset.json').read_text(encoding='utf-8'))
 d,b=read_glb(LIB/asset_id/meta.get('flight_visual',meta['model'])['path'])
 names={'joby_s4':'03_-_Default','projectairsim_airtaxi':'AirTaxi_Glass','kp2a':'MI_Glass_Windshield_Tinted','amvlab_evtol':'AeroDT_Cabin_Glazing','x_57':'Dark blue cabin glass'}
 glass=next((m for m in d['materials'] if m.get('name')==names[asset_id]),{})
 assert glass.get('alphaMode')=='BLEND'
 assert glass['pbrMetallicRoughness']['baseColorFactor']==pytest.approx([.82,.87,.90,.12])
 assert glass['pbrMetallicRoughness']['metallicFactor']==0
 assert glass['pbrMetallicRoughness']['roughnessFactor']==pytest.approx(.12)
 if asset_id=='amvlab_evtol':
  body=next(m for m in d['materials'] if m.get('name')=='evtol_mat')
  assert body.get('alphaMode','OPAQUE')=='OPAQUE'

def digest(value):
 import hashlib
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

@pytest.mark.parametrize('asset_id',CAPACITIES)
def test_original_geometry_rigs_textures_and_kp2_non_glass_unchanged(asset_id):
 import hashlib,copy
 from collections import Counter
 from split_rotor_nodes import read_accessor
 baseline=json.loads((Path(__file__).with_name('uam_cabin_baseline.json')).read_text())[asset_id]
 meta=json.loads((LIB/asset_id/'asset.json').read_text(encoding='utf-8'))
 d,b=read_glb(LIB/asset_id/meta['flight_visual']['path'])
 assert hashlib.sha256((LIB/asset_id/'model.glb').read_bytes()).hexdigest()==baseline['source_sha256']
 assert hashlib.sha256(b[:baseline['binary_length']]).hexdigest()==baseline['binary_sha256']
 assert digest(d['nodes'][:baseline['node_count']])==baseline['nodes_sha256']
 meshes=copy.deepcopy(d['meshes'][:baseline['mesh_count']])
 if asset_id=='amvlab_evtol':
  original=baseline['partitioned_primitive'];parts=meshes[0]['primitives']
  assert len(parts)==2
  def triangles(p):
   values=[v[0] for v in read_accessor(d,b,p['indices'])]
   return Counter(tuple(values[i:i+3]) for i in range(0,len(values),3))
  assert triangles(parts[0])+triangles(parts[1])==triangles(original)
  assert parts[0]['attributes']==original['attributes']==parts[1]['attributes']
  meshes[0]['primitives']=[original]
 assert digest(meshes)==baseline['meshes_sha256']
 if asset_id=='kp2a':
  # Only the explicitly approved glass may differ from the pinned cabin input.
  original,_=read_glb(ROOT/'project_support/cockpit_work/assets/originals/kp2a/input.glb')
  materials=copy.deepcopy(d['materials'][:baseline['material_count']])
  for i,m in enumerate(materials):
   if m.get('name')=='MI_Glass_Windshield_Tinted':materials[i]=original['materials'][i]
  assert digest(materials)==baseline['kp2_materials_sha256']

def test_builder_rejects_duplicate_cabin_input():
 import pytest
 from build_uam_cabins import add_cabin
 with pytest.raises(AssertionError,match='already contains'):
  add_cabin({'nodes':[{'name':'AeroDT_Cabin'}]},bytearray(),'joby_s4')

def test_metadata_eye_positions_are_aircraft_specific():
 eyes=[tuple(json.loads((LIB/id/'asset.json').read_text(encoding='utf-8'))['cockpit']['eye']) for id in CAPACITIES]
 assert len(set(eyes))==5

@pytest.mark.parametrize('asset_id',CAPACITIES)
def test_cockpit_shell_has_visible_interior_faces(asset_id):
 d,b=read_glb(LIB/asset_id/'flight_model.glb')
 assert all(m.get('doubleSided') is True for m in d['materials'] if m.get('alphaMode','OPAQUE')=='OPAQUE')

def test_airtaxi_three_screens_fit_forward_horizontal_70_degrees():
 meta=json.loads((LIB/'projectairsim_airtaxi'/'asset.json').read_text(encoding='utf-8'))
 profile=meta['cockpit'];eye=profile['eye']
 for screen in profile['screens']:
  far_side=abs(screen['center'][2]-eye[2])+screen['width']/2
  assert math.degrees(math.atan2(far_side,screen['center'][0]-eye[0]))<33

def test_x57_three_screens_fit_forward_horizontal_70_degrees():
 meta=json.loads((LIB/'x_57'/'asset.json').read_text(encoding='utf-8'))
 profile=meta['cockpit'];eye=profile['eye']
 for screen in profile['screens']:
  far_side=abs(screen['center'][2]-eye[2])+screen['width']/2
  assert math.degrees(math.atan2(far_side,screen['center'][0]-eye[0]))<33


@pytest.mark.parametrize('asset_id',CAPACITIES)
def test_clear_glazing_update_is_material_only_and_idempotent(asset_id,tmp_path):
 import copy,hashlib,shutil
 from clear_uam_glazing import update_asset,GLASS_NAMES
 target=tmp_path/asset_id;target.mkdir()
 for filename in ('flight_model.glb','asset.json','model.glb'):
  shutil.copy2(LIB/asset_id/filename,target/filename)
 before,binary=read_glb(target/'flight_model.glb')
 original=(target/'model.glb').read_bytes()
 meta=json.loads((target/'asset.json').read_text(encoding='utf-8'))
 update_asset(target)
 after,after_binary=read_glb(target/'flight_model.glb')
 assert binary==after_binary
 for i,m in enumerate(before['materials']):
  if m.get('name')==GLASS_NAMES[asset_id]:after['materials'][i]=copy.deepcopy(m)
 assert before==after  # Geometry, textures, rigs, cabin, and other materials.
 assert (target/'model.glb').read_bytes()==original
 result=json.loads((target/'asset.json').read_text(encoding='utf-8'))
 assert result['flight_visual']['sha256']==hashlib.sha256((target/'flight_model.glb').read_bytes()).hexdigest()
 assert result['flight_visual']['bytes']==(target/'flight_model.glb').stat().st_size
 for key in ('sha256','bytes','note'):
  result['flight_visual'].pop(key,None);meta['flight_visual'].pop(key,None)
 assert result==meta  # No cockpit/rotor/scale/capacity metadata reset.
 first=[(target/n).read_bytes() for n in ('flight_model.glb','asset.json')]
 update_asset(target)
 assert first==[(target/n).read_bytes() for n in ('flight_model.glb','asset.json')]
