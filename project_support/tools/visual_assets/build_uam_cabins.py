"""Reproducible display-only cabins, authored in the final flight GLB scene frame.

Preserves acquired model.glb files. EVTOL glazing reuses complete textured
triangles (positions/UVs/normals are untouched); only their material changes.
Re-running reads a pinned pre-cabin flight backup, so seats never accumulate.
"""
import copy, hashlib, io, json, math, shutil
from pathlib import Path
import numpy as np
from PIL import Image
from split_rotor_nodes import read_glb, write_glb, read_accessor, add_accessor
ROOT=Path(__file__).resolve().parents[3]
LIB=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'
BACKUP=ROOT/'project_support/cockpit_work/assets/originals'
# Measured glazing envelope, not whole-aircraft bounds. Dimensions intentionally
# fitted to these illustrative bodies, not claimed as certified human dimensions.
LAYOUTS={
 'joby_s4':dict(eye=[.68,.77,0],floor=.37,width=.59,rear=-.32,seat=.24,rows=[.30,-.12],capacity=2),
 'projectairsim_airtaxi':dict(eye=[1.30,1.70,-.27],floor=.72,width=1.65,rear=-.65,seat=.48,rows=[.45,-.35],capacity=4),
 'kp2a':dict(eye=[1.80,1.14,0],floor=.55,width=.92,rear=-.20,seat=.32,rows=[1.15,.57,-.01],capacity=6),
 'amvlab_evtol':dict(eye=[1.79,.77,0],floor=.30,width=.53,rear=.17,seat=.19,rows=[1.38,1.02,.66,.30],capacity=8),
 'x_57':dict(eye=[2.43,1.06,-.20],floor=.80,width=.77,rear=1.20,seat=.27,rows=[1.98,1.44],capacity=4),
}
from clear_uam_glazing import GLASS_NAMES, clear_material
from cabin_geometry import rounded_box, ellipsoid

def glazing(d,b,asset_id):
 if asset_id=='amvlab_evtol':
  p=d['meshes'][0]['primitives'][0]
  xyz=np.asarray(read_accessor(d,b,p['attributes']['POSITION']))
  uv=np.asarray(read_accessor(d,b,p['attributes']['TEXCOORD_0']))
  ix=np.asarray(read_accessor(d,b,p['indices']),dtype=np.int64).reshape(-1,3)
  centers=xyz[ix].mean(axis=1);tex=uv[ix].mean(axis=1)
  image=d['images'][d['textures'][d['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']]
  view=d['bufferViews'][image['bufferView']];offset=view.get('byteOffset',0)
  pixels=np.asarray(Image.open(io.BytesIO(b[offset:offset+view['byteLength']])).convert('RGB'))
  rgb=pixels[(tex[:,1]*(pixels.shape[0]-1)).astype(int).clip(0,pixels.shape[0]-1),(tex[:,0]*(pixels.shape[1]-1)).astype(int).clip(0,pixels.shape[1]-1)]
  # Only the dark cockpit/cabin atlas islands on the fuselage, not dark motors,
  # nacelles, logo graphics or the blue paint. Original atlas bytes retained.
  mask=(rgb.max(axis=1)<50)&(np.abs(centers[:,0])<1.1)&(centers[:,1]<-.5)&(centers[:,2]>-.15)
  assert 250<int(mask.sum())<700, 'EVTOL source changed: review glazing selection'
  glass=copy.deepcopy(p);glass['indices']=add_accessor(d,b,[(int(v),) for v in ix[mask].flat],kind='SCALAR',component=5125,target=34963)
  p['indices']=add_accessor(d,b,[(int(v),) for v in ix[~mask].flat],kind='SCALAR',component=5125,target=34963)
  glass['material']=len(d['materials']);d['materials'].append({'name':'AeroDT_Cabin_Glazing'})
  d['meshes'][0]['primitives'].append(glass)
  material=d['materials'][-1]
 else: material=next(m for m in d['materials'] if m.get('name')==GLASS_NAMES[asset_id])
 clear_material(material)

def box_mesh(d,b,material):
 vertices=[];normals=[];indices=[]
 for axis in range(3):
  u=(axis+1)%3;v=(axis+2)%3
  for sign in [-1,1]:
   start=len(vertices)
   for a,c in [(-1,-1),(1,-1),(1,1),(-1,1)]:
    point=[0,0,0];point[axis]=sign*.5;point[u]=a*.5;point[v]=c*.5
    normal=[0,0,0];normal[axis]=sign;vertices.append(point);normals.append(normal)
   order=[0,1,2,0,2,3] if sign==1 else [0,2,1,0,3,2]
   indices.extend((start+i,) for i in order)
 p={'attributes':{'POSITION':add_accessor(d,b,vertices,kind='VEC3',component=5126,target=34962),'NORMAL':add_accessor(d,b,normals,kind='VEC3',component=5126,target=34962)},'indices':add_accessor(d,b,indices,kind='SCALAR',component=5123,target=34963),'material':material}
 index=len(d['meshes']);d['meshes'].append({'name':'Cabin_unit_box','primitives':[p]});return index

def add_cabin(d,b,asset_id):
 assert not any(n.get('name')=='AeroDT_Cabin' for n in d['nodes']), 'input already contains a cabin'
 layout=LAYOUTS[asset_id];eye=layout['eye'];floor=layout['floor'];w=layout['width'];s=layout['seat'];rear=layout['rear']
 meshes={};materials={};viewpoints=[];occupants=[]
 for name,color in [('trim',[.19,.22,.25,1]),('seat',[.30,.37,.42,1]),('cushion',[.43,.51,.56,1]),('metal',[.37,.39,.40,1]),('screen',[.025,.045,.065,1]),('light',[.6,.83,.94,1]),('clothing',[.10,.20,.27,1]),('skin',[.57,.36,.24,1])]:
  material={'name':'Cabin_'+name,'pbrMetallicRoughness':{'baseColorFactor':color,'roughnessFactor':.82,'metallicFactor':.05},'doubleSided':True}
  if name in ('screen','light'):material['emissiveFactor']=[c*.4 for c in color[:3]]
  d['materials'].append(material);materials[name]=len(d['materials'])-1;meshes[name]=box_mesh(d,b,len(d['materials'])-1)
 def node(name,**kw):
  i=len(d['nodes']);d['nodes'].append(dict(name=name,**kw));return i
 children=[]
 def box(name,center,size,mat='trim',parent=None,rounded=False):
  shape=rounded_box(d,b,size,min(size)*.20,materials[mat]) if rounded else meshes[mat]
  i=node(name,mesh=shape,translation=center,scale=[1,1,1] if rounded else size)
  (children if parent is None else d['nodes'][parent].setdefault('children',[])).append(i);return i
 def seat(name,x,z,role):
  root=node(name,translation=[x,floor,z],extras={'cabin_role':role});children.append(root)
  box(name+'_base',[0,s*.23,0],[s*.68,s*.40,s*.67],'metal',root)
  box(name+'_cushion',[s*.06,s*.48,0],[s*.96,s*.17,s*.92],'cushion',root,rounded=True)
  box(name+'_back',[-s*.40,s*.94,0],[s*.17,s*1.12,s*.92],'seat',root,rounded=True)
  box(name+'_headrest',[-s*.39,s*1.59,0],[s*.22,s*.27,s*.58],'cushion',root,rounded=True)
  for side in [-1,1]:box(name+'_arm_'+str(side),[0,s*.81,side*s*.48],[s*.8,s*.10,s*.10],'trim',root)
 soft={name:ellipsoid(d,b,materials[name]) for name in ['clothing','skin']}
 def occupant(index,x,z):
  name='Cabin_occupant_%02d'%index
  root=node(name,translation=[x,floor,z],scale=[.0001]*3,extras={'illustration_only':True});children.append(root);occupants.append(name)
  def part(label,center,size,mat='clothing'):
   child=node(name+'_'+label,mesh=soft[mat],translation=center,scale=size);d['nodes'][root].setdefault('children',[]).append(child)
  part('torso',[-s*.08,s*1.01,0],[s*.40,s*.80,s*.65])
  part('head',[-s*.04,s*1.61,0],[s*.33,s*.40,s*.34],'skin')
  for side in [-1,1]:
   part('thigh'+str(side),[s*.24,s*.61,side*s*.19],[s*.73,s*.26,s*.25])
   part('shin'+str(side),[s*.54,s*.33,side*s*.19],[s*.23,s*.57,s*.23])
   part('shoe'+str(side),[s*.64,s*.08,side*s*.19],[s*.41,s*.14,s*.25])
   part('arm'+str(side),[0,s*1.02,side*s*.35],[s*.22,s*.62,s*.21])
   part('hand'+str(side),[s*.21,s*.79,side*s*.34],[s*.29,s*.13,s*.16],'skin')
 seat('Cabin_pilot',eye[0]-.10,eye[2],'pilot_seat')
 i=0
 for row in layout['rows']:
  zs=[0] if layout['capacity']==2 else [-w*.27,w*.27]
  for z in zs:
   i+=1;seat('Cabin_passenger_%02d'%i,row,z,'passenger_seat');occupant(i,row,z)
   viewpoints.append(dict(id='seat_%02d'%i,label='승객석 %d'%i,eye=[row+s*.06,floor+s*1.67,z],occupant_node='Cabin_occupant_%02d'%i))
 front=eye[0]+s*1.95;length=front-rear
 box('Cabin_floor',[(front+rear)/2,floor-.025,0],[length,.045,w])
 # Side sills below glazing; no tall opaque liner blocks the windows.
 for side in [-1,1]:box('Cabin_sill_'+str(side),[(front+rear)/2,floor+s*.4,side*w*.5],[length,s*.55,.035])
 panel_width=w*(.8 if asset_id in ('projectairsim_airtaxi','x_57') else 1)
 screen_width=panel_width*.20;screen_height=s*.45;panel_x=eye[0]+s*1.75;panel_y=eye[1]-s*.65
 panel_z=eye[2]*(1 if asset_id=='projectairsim_airtaxi' else .8 if asset_id=='x_57' else .6)
 box('Cabin_dashboard',[panel_x+.025,panel_y,panel_z],[s*.30,screen_height*1.32,panel_width*.69],rounded=True)
 lower=panel_y-screen_height*.66
 box('Cabin_dashboard_pedestal',[panel_x+.025,(lower+floor)/2,panel_z],[s*.28,max(.025,lower-floor),panel_width*.57],rounded=True)
 screens=[]
 for index,name in enumerate(['pfd','nav','system']):
  z=panel_z+(index-1)*panel_width*.225;center=[panel_x-s*.165,panel_y,z]
  box('Cabin_screen_'+name,center,[.008,screen_height,screen_width],'screen')
  screens.append(dict(id=name,center=[center[0]-.006,center[1],center[2]],width=screen_width,height=screen_height,right=[0,0,1],up=[0,1,0]))
 box('Cabin_sidestic_base',[eye[0]+s*.15,floor+s*.60,w*.38],[s*.35,s*.16,s*.22])
 box('Cabin_sidestick',[eye[0]+s*.15,floor+s*.88,w*.38],[s*.07,s*.47,s*.08],'metal')
 cabin=node('AeroDT_Cabin',children=children,extras={'generator':'build_uam_cabins.py','visual_only':True})
 d['scenes'][d.get('scene',0)]['nodes'].append(cabin)
 return dict(schema_version=1,viewpoints=viewpoints,occupant_nodes=occupants,occupant_default_scale=.0001,eye=eye,forward=[1,0,0],up=[0,1,0],passenger_seats=layout['capacity'],screens=screens,interior='flight_model.glb: AeroDT_Cabin; illustrative geometry fitted to glazing envelope, not certified dimensions',coordinate_frame='flight_glb_scene_before_display_scale',seat_nodes=['Cabin_passenger_%02d'%(j+1) for j in range(layout['capacity'])])

def build(asset_id):
 directory=LIB/asset_id;meta_path=directory/'asset.json';meta=json.loads(meta_path.read_text(encoding='utf-8'))
 backup=BACKUP/asset_id;backup.mkdir(parents=True,exist_ok=True)
 source=directory/meta.get('flight_visual',meta['model'])['path']
 if not (backup/'input.glb').exists():
  shutil.copy2(source,backup/'input.glb');shutil.copy2(meta_path,backup/'asset.json')
 original=json.loads((backup/'asset.json').read_text(encoding='utf-8'))
 d,b=read_glb(backup/'input.glb');glazing(d,b,asset_id)
 # The outside shell is also the cabin boundary: do not cull its inner faces.
 # Transparent source materials (especially KP2 glazing/logos) remain untouched.
 for material in d['materials']:
  if material.get('alphaMode','OPAQUE')=='OPAQUE':material['doubleSided']=True
 profile=add_cabin(d,b,asset_id)
 output=directory/'flight_model.glb';write_glb(output,d,b)
 flight=copy.deepcopy(original.get('flight_visual',{}))
 flight.setdefault('purpose','visual_only cabin and original AirTaxi rig')
 flight.setdefault('validation','pending')
 flight.update(path=output.name,sha256=hashlib.sha256(output.read_bytes()).hexdigest(),bytes=output.stat().st_size,source_sha256=meta['model']['sha256'])
 if not flight.get('rotors'):flight['rotors']=copy.deepcopy(original.get('rotors',{}))
 flight['note']=flight.get('note','')+' Cabin and clear low-opacity glazing: build_uam_cabins.py; exterior vertex positions and rig nodes retained.'
 meta['flight_visual']=flight;meta['cockpit']=profile
 meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 return profile
if __name__=='__main__':
 profiles={asset_id:build(asset_id) for asset_id in LAYOUTS}
 (BACKUP.parent/'profiles.json').write_text(json.dumps(profiles,indent=2)+'\n',encoding='utf-8')
 print('Built five non-accumulating visual-only cabins; source models retained.')


