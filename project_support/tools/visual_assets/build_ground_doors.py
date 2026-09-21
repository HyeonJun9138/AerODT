"""Split illustrative side hatches in an existing cabin rig, preserving its rig.

Writes a NEW turnaround_model.glb. Acquired originals and flight_model.glb are
never overwritten. Closed surfaces preserve geometry/UVs; exact planar cuts
interpolate attributes. These hatches are simulation visuals, not certified doors.
"""
import argparse,copy,hashlib,json,math
from pathlib import Path
import numpy as np
from split_rotor_nodes import read_glb,write_glb,read_accessor,add_accessor

# x interval, vertical interval, side envelope, in authored flight-scene units.
HATCHES={'projectairsim_airtaxi':(-.45,.35,.73,1.94,1.45),
         'joby_s4':(-.20,.34,.38,1.10,.80),
         'kp2a':(.1,.72,.56,1.46,1.05),
         'amvlab_evtol':(.40,.94,.31,.92,.70),
         'x_57':(1.25,1.95,.81,1.51,.90)}

def matrix(node):
 if 'matrix' in node:return np.array(node['matrix']).reshape(4,4,order='F')
 x,y,z,w=node.get('rotation',[0,0,0,1]);r=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
 m=np.eye(4);m[:3,:3]=r@np.diag(node.get('scale',[1,1,1]));m[:3,3]=node.get('translation',[0,0,0]);return m

def split(poly,axis,bound,sign):
 inside=[];outside=[]
 for a,b in zip(poly,poly[1:]+poly[:1]):
  da=(a[axis]-bound)*sign;db=(b[axis]-bound)*sign
  (inside if da>=0 else outside).append(a)
  if (da>=0)!=(db>=0):
   p=a+(b-a)*(da/(da-db));inside.append(p);outside.append(p)
 return inside,outside

def triangles(poly):return [[poly[0],poly[i],poly[i+1]] for i in range(1,len(poly)-1)]

def build(root,aid):
 folder=root/'digital_twin/model_library/visual_assets/aircraft/civilian'/aid
 path=folder/'asset.json';meta=json.loads(path.read_text(encoding='utf-8'))
 d,b=read_glb(folder/'flight_model.glb');original=copy.deepcopy(d);xmin,xmax,ymin,ymax,zmax=HATCHES[aid]
 worlds={}
 def visit(i,parent):
  worlds[i]=parent@matrix(d['nodes'][i])
  for child in d['nodes'][i].get('children',[]):visit(child,worlds[i])
 for i in d['scenes'][d.get('scene',0)]['nodes']:visit(i,np.eye(4))
 doors={-1:[],1:[]};zvalues={-1:[],1:[]};cuts=0
 for i,n in list(enumerate(d['nodes'])):
  name=n.get('name','')
  eligible=name.startswith(('AeroDTExport_00_Frame','AeroDTExport_joby','Cabin_sill','Premium_lower_liner','Premium_rail')) or name in ('x57','X57_cabin_glazing','eVTOL') or 'KP2A_Parts_KP2A_Body' in name
  if not eligible or 'mesh' not in n or i not in worlds:continue
  # Work on a per-node copy so instancing elsewhere cannot be changed.
  mesh=copy.deepcopy(d['meshes'][n['mesh']]);new_primitives=[];m=worlds[i];inverse=np.linalg.inv(m)
  for primitive in mesh['primitives']:
   if primitive.get('mode',4)!=4 or 'indices' not in primitive or 'targets' in primitive:raise ValueError('unsupported hatch primitive')
   keys=['POSITION']+[k for k in primitive['attributes'] if k!='POSITION'];arrays=[np.asarray(read_accessor(d,b,primitive['attributes'][k]),dtype=float) for k in keys]
   sizes=[a.shape[1] for a in arrays];values=np.concatenate(arrays,axis=1)
   values[:,:3]=(np.c_[arrays[0],np.ones(len(arrays[0]))]@m.T)[:,:3]
   inds=np.asarray(read_accessor(d,b,primitive['indices']),dtype=int).reshape(-1,3)
   lo=values[inds,:3].min(axis=1);hi=values[inds,:3].max(axis=1)
   candidates=(hi[:,0]>=xmin)&(lo[:,0]<=xmax)&(hi[:,1]>=ymin)&(lo[:,1]<=ymax)&(lo[:,2]<=zmax)&(hi[:,2]>=-zmax)
   remaining=[];pieces={-1:[],1:[]}
   for ids in inds[candidates]:
    todo=[list(values[ids])]
    for side in [-1,1]:
     next_todo=[]
     for poly in todo:
      current=poly
      for axis,bound,sign in [(0,xmin,1),(0,xmax,-1),(1,ymin,1),(1,ymax,-1),(2,side*.08,side),(2,side*zmax,-side)]:
       if not current:break
       current,out=split(current,axis,bound,sign)
       next_todo.extend(triangles(out))
      if len(current)>=3:pieces[side].extend(triangles(current))
     todo=next_todo
    remaining.extend(todo)
   if not any(pieces.values()):new_primitives.append(primitive);continue
   cuts+=1
   def append_primitive(tris,world=False,pivot=None):
    if not tris:return None
    v=np.asarray(tris).reshape(-1,sum(sizes)).copy();p=copy.deepcopy(primitive);p['attributes']={};at=0
    if world:
     v[:,:3]-=pivot
    else:v[:,:3]=(np.c_[v[:,:3],np.ones(len(v))]@inverse.T)[:,:3]
    for key,size in zip(keys,sizes):
     a=v[:,at:at+size];at+=size
     if world and key in ('NORMAL','TANGENT'):
      a[:,:3]=a[:,:3]@np.linalg.inv(m[:3,:3]);a[:,:3]/=np.maximum(1e-10,np.linalg.norm(a[:,:3],axis=1))[:,None]
     p['attributes'][key]=add_accessor(d,b,a.tolist(),kind=f'VEC{size}',component=5126,target=34962)
    p['indices']=add_accessor(d,b,[(v,) for v in range(len(v))],kind='SCALAR',component=5125,target=34963)
    return p
   # Retain uncut triangles via original accessor/index buffer.
   untouched=copy.deepcopy(primitive);untouched['indices']=add_accessor(d,b,[(int(v),) for v in inds[~candidates].flat],kind='SCALAR',component=5125,target=34963)
   if len(inds[~candidates]):new_primitives.append(untouched)
   rest=append_primitive(remaining)
   if rest:new_primitives.append(rest)
   for side,tris in pieces.items():
    if not tris:continue
    zvalues[side].extend(np.asarray(tris)[:,:,2].ravel().tolist())
    # Hinges in the scene frame. Door faces use pivot-relative scene positions.
    pivot=np.array([xmax,ymin,side*zmax*.7]);doors[side].append(append_primitive(tris,True,pivot))
  mesh['primitives']=new_primitives;n['mesh']=len(d['meshes']);d['meshes'].append(mesh)
 assert cuts and all(doors.values()),(aid,'no door surface',cuts)
 names={}
 for side,primitives in doors.items():
  # +z is the airframe's starboard side. Every node the original authors named
  # carries that: L sits at negative z and R at positive z in both source models
  # (the position lights, which are port and starboard by definition, settle it).
  # This used to name the negative-z hatch 'right', so the door that opened was
  # the one opposite the side the passengers walked to.
  name='Ground_door_'+('right' if side>0 else 'left');names['right' if side>0 else 'left']=name
  mesh=len(d['meshes']);d['meshes'].append({'name':name,'primitives':primitives});node=len(d['nodes'])
  d['nodes'].append({'name':name,'mesh':mesh,'translation':[xmax,ymin,side*zmax*.7]})
  d['scenes'][d.get('scene',0)]['nodes'].append(node)
 output=folder/'turnaround_model.glb';write_glb(output,d,b)
 flight=meta.get('flight_visual',{});measured=flight.get('measured_extent_m',meta.get('measured_extent_m',1));display=flight.get('display_extent_m',meta.get('display_extent_m',1));scale=display/measured
 # Metadata uses physical display metres for staff/door rendezvous.
 meta['cockpit']['ground_door']={'nodes':names,'forward_m':(xmin+xmax)/2*scale,'right_m':float(max(np.quantile(np.abs(zvalues[-1]),.85),np.quantile(np.abs(zvalues[1]),.85)))*scale+.12,'height_m':ymin*scale,'open_deg':78,'purpose':'illustrative side hatch; not certified geometry'}
 flight.update(path=output.name,sha256=hashlib.sha256(output.read_bytes()).hexdigest(),bytes=output.stat().st_size)
 meta['flight_visual']=flight;path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 return {'asset':aid,'pieces':[len(doors[s]) for s in [-1,1]],'nodes_added':len(d['nodes'])-len(original['nodes']),'door':meta['cockpit']['ground_door'],'bytes':output.stat().st_size}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);args=p.parse_args()
 print(json.dumps([build(args.root,n) for n in HATCHES],ensure_ascii=False,indent=2))
