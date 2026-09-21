"""Repair the nine NASA visual-only GLBs without changing runtime dynamics.

Re-run from the immutable pre-repair snapshot, never compound transforms.
The saved OpenVSP mesh uses feet and +Y-up; the delivered scene uses metres
and +X-forward like the existing AirTaxi. Rotor local +Y follows its measured
shaft, not the global up axis. Tilt poses are illustrative visual mappings.
"""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import numpy as np
import math
sys.path.insert(0, str(Path(__file__).resolve().parent))
from split_rotor_nodes import read_glb, write_glb, read_accessor, add_accessor
from openvsp_register import CATALOGUE
ROOT = Path(__file__).resolve().parents[3]
SHELF = ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'
BACKUP = ROOT/'data/workspace/visual_assets/nasa_repair_original'
BUILD = ROOT/'data/workspace/visual_assets/intake_nasa/build'
FEET = .3048


def matrix_quaternion(m):
    # All repair bases have rotations below 180 degrees (positive trace).
    w=math.sqrt(max(0,1+np.trace(m)))/2
    if w<1e-8: raise ValueError('Unsupported half-turn basis')
    return [(m[2,1]-m[1,2])/(4*w),(m[0,2]-m[2,0])/(4*w),(m[1,0]-m[0,1])/(4*w),w]


def overwrite_vectors(doc, blob, index, matrix):
    accessor=doc['accessors'][index]; view=doc['bufferViews'][accessor['bufferView']]
    assert accessor['componentType']==5126 and accessor['type']=='VEC3'
    data=np.asarray(read_accessor(doc,blob,index),dtype=np.float64) @ matrix.T
    start=view.get('byteOffset',0)+accessor.get('byteOffset',0)
    stride=view.get('byteStride',12)
    for i,p in enumerate(data): blob[start+i*stride:start+i*stride+12]=np.asarray(p,dtype='<f4').tobytes()
    if 'min' in accessor: accessor['min']=data.min(axis=0).tolist()
    if 'max' in accessor: accessor['max']=data.max(axis=0).tolist()


def shaft_basis(points):
    points=np.asarray(points); centered=points-points.mean(axis=0)
    values,vectors=np.linalg.eigh(centered.T@centered)
    shaft=vectors[:,0]
    # Choose the physically equivalent sign towards up, or towards the nose.
    prefer=np.array([0,1,0]) if abs(shaft[1])>.5 else np.array([0,0,-1])
    if shaft@prefer<0: shaft=-shaft
    ref=np.array([1.,0,0]); x=ref-shaft*(ref@shaft); x/=np.linalg.norm(x)
    return np.column_stack([x,shaft,np.cross(x,shaft)])


def flatten_hinges(doc):
    nodes=doc['nodes']; roots=doc['scenes'][doc.get('scene',0)]['nodes']; result=[]
    for i in roots:
        n=nodes[i]
        if n.get('name','').startswith('AeroDT_Hinge_'):
            pivot=np.array(n.get('translation',[0,0,0]))
            for c in n.get('children',[]):
                nodes[c]['translation']=(pivot+np.array(nodes[c].get('translation',[0,0,0]))).tolist()
                result.append(c)
            n.pop('children',None)
            n['name']='Retired_'+n['name']
        else: result.append(i)
    roots[:]=result


def hinge(doc, name, children, pivot):
    nodes=doc['nodes']; roots=doc['scenes'][doc.get('scene',0)]['nodes']; pivot=np.asarray(pivot)
    for i in children:
        roots.remove(i)
        nodes[i]['translation']=(np.asarray(nodes[i].get('translation',[0,0,0]))-pivot).tolist()
    roots.append(len(nodes)); nodes.append({'name':name,'translation':pivot.tolist(),'children':children})


def repair(home, source):
    saved=BACKUP/home.name
    if not saved.exists():
        saved.mkdir(parents=True)
        for filename in ['model.glb','asset.json','thumbnail.jpg']: shutil.copy2(home/filename,saved/filename)
    meta=json.loads((saved/'asset.json').read_text(encoding='utf-8'))
    # A repeat repair must not reset metadata to the pre-repair thumbnail hash.
    if (home/'asset.json').exists() and (home/'thumbnail.jpg').exists():
        current=json.loads((home/'asset.json').read_text(encoding='utf-8'))
        picture=current.get('thumbnail',{})
        if picture.get('sha256')==hashlib.sha256((home/'thumbnail.jpg').read_bytes()).hexdigest():
            meta['thumbnail']=copy.deepcopy(picture)
    doc,blob=read_glb(saved/'model.glb')
    parts=json.loads((BUILD/source/'parts.json').read_text(encoding='utf-8'))
    nodes=doc['nodes']; by_name={n.get('name'):i for i,n in enumerate(nodes)}
    if home.name in ['nasa_quadrotor_collflap','nasa_quadrotor_rpm']:
        # The generic taper heuristic selected the rear on these short cabins.
        # OpenVSP cabin origin is at X=-11 ft; the high rear rotors are at +X.
        # Rebuild illustrative cabin and windscreen facing the source nose (-Z).
        from openvsp_cabin import Airframe, plan, glaze, furnish, PAINT
        air=Airframe(BUILD/source); air.doc=doc; air.blob=blob
        body=air.fuselage(); env=air.envelope(body); env['nose_low_z']=True
        layout=plan(env,6); primitives=doc['meshes'][nodes[body]['mesh']]['primitives']
        indices=[]
        for primitive in primitives: indices.extend(read_accessor(doc,blob,primitive['indices']))
        primitives[0]['indices']=add_accessor(doc,blob,indices,kind='SCALAR',component=5125,target=34963)
        del primitives[1:]
        roots=doc['scenes'][doc.get('scene',0)]['nodes']
        roots[:]=[i for i in roots if nodes[i].get('name')!='AeroDT_Cabin']
        for n in nodes:
            if n.get('name','').startswith('Cabin_') or n.get('name')=='AeroDT_Cabin': n['name']='Retired_'+n['name']
        slots={key:i for i,key in enumerate(PAINT)}
        glaze(air,env,layout,slots['glass'])
        meta['cockpit']=furnish(air,env,layout,6,slots)['cockpit']
        parts['cabin']['nose']='-Z'
    # Source ergonomic proxy humans are not cabin render assets. The imported
    # proxies and the supposedly hidden illustrative occupants obscured the eye.
    hidden={i for i,n in enumerate(nodes) if n.get('name')=='VSP_HumanGeom'}
    for n in nodes:
        if 'children' in n: n['children']=[i for i in n['children'] if i not in hidden]
        if n.get('name','').startswith('Cabin_occupant_'):
            n['scale']=[v*meta['cockpit'].get('occupant_default_scale',.0001) for v in n.get('scale',[1,1,1])]
    for scene in doc['scenes']: scene['nodes']=[i for i in scene['nodes'] if i not in hidden]
    original_hinges=copy.deepcopy(parts['hinges'])
    flatten_hinges(doc)
    points=[]
    for n in nodes:
        if 'mesh' not in n or n.get('name')=='VSP_HumanGeom' or not n.get('name','').startswith(('VSP_','AeroDT_Rotor_')): continue
        for primitive in doc['meshes'][n['mesh']]['primitives']:
            xyz=np.asarray(read_accessor(doc,blob,primitive['attributes']['POSITION']))
            points.append(xyz+np.asarray(n.get('translation',[0,0,0])))
    points=np.concatenate(points); lo=points.min(axis=0); hi=points.max(axis=0)
    origin=(lo+hi)/2; origin[1]=lo[1]
    measured_extent=hi-lo
    for spec in meta['rotors']['nodes']:
        node=nodes[by_name[spec['name']]]; mesh=doc['meshes'][node['mesh']]
        points=[]
        for p in mesh['primitives']: points.extend(read_accessor(doc,blob,p['attributes']['POSITION']))
        basis=shaft_basis(points)
        for p in mesh['primitives']:
            for attr in ['POSITION','NORMAL']:
                if attr in p['attributes']: overwrite_vectors(doc,blob,p['attributes'][attr],basis.T)
        node['rotation']=matrix_quaternion(basis)
        spec['source_shaft_axis']=basis[:,1].tolist()
        spec['axis']='y'
    meta['rotors'].pop('tilt',None); meta['rotors'].pop('tilt_note',None)
    tilts=[]
    if home.name=='nasa_tiltwing':
        groups=[('AeroDT_MainWing_Tilt',[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18],[0,8.5,11.36486225]),
                ('AeroDT_RearLeft_Tilt',[20,21,22],[5.04032,13.802877,25.1683288]),
                ('AeroDT_RearRight_Tilt',[23,24,25],[-5.04032,13.802877,25.1683288])]
        # Indices are from this versioned NASA OpenVSP source; fail closed if changed.
        assert nodes[0]['name']=='VSP_Wing_1' and nodes[22]['name']=='AeroDT_Rotor_51'
        for name,children,pivot in groups:
            hinge(doc,name,children,pivot)
            tilts.append({'name':name,'axis':'x','sign':-1,'offset_deg':90})
    elif home.name in ['nasa_tiltduct_cross','nasa_tiltduct_direct','nasa_multi_tiltrotor']:
        # Recover the authored nacelle group membership from the original GLB.
        old,_=read_glb(saved/'model.glb')
        for h in original_hinges:
            oldnode=next((n for n in old['nodes'] if n.get('name')==h['name']),None)
            children=(oldnode or {}).get('children',[])
            rotors=[i for i in children if nodes[i].get('name','').startswith('AeroDT_Rotor_')]
            if not rotors: continue
            if 'tiltduct' in home.name:
                number=h['name'].rsplit('_',1)[1]
                children=list(children)+[i for i,n in enumerate(nodes) if n.get('name') in
                    [f'VSP_{role}_{number}' for role in ['Duct','DuctStrut','HVane','VVane','YVane']]]
            hinge(doc,h['name'],children,h['pivot'])
            tilts.append({'name':h['name'],'axis':'x','sign':-1,
                          'offset_deg':90 if 'tiltduct' in home.name else 0})
        # Coaxial upper/lower rotors must counter-rotate on each rear nacelle.
        if home.name=='nasa_multi_tiltrotor':
            for a,b in [('AeroDT_Rotor_36','AeroDT_Rotor_38'),('AeroDT_Rotor_40','AeroDT_Rotor_42')]:
                pair=[s for s in meta['rotors']['nodes'] if s['name'] in [a,b]]
                if len(pair)==2: pair[1]['turn']=-pair[0]['turn']
    if tilts:
        meta['rotors']['tilt']={'axis':'x','sign':-1,'frame':'parent','nodes':tilts,
            'note':'Visual transition: 0 deg hover, 90 deg cruise. Source-authored cruise assemblies have a 90 deg hover offset; no dynamics are modified.'}
    meta['rotors']['note']='Each rotor is re-based to its measured blade-plane normal with local +Y as its shaft. The rest geometry and hub are preserved.'
    # NASA concept render palette, converted from sRGB into linear glTF factors.
    def linear(rgb): return [((c+.055)/1.055)**2.4 if c>.04045 else c/12.92 for c in rgb]
    palette={'AeroDT_Airframe':([.035,.32,.82],.25,.29),
             'AeroDT_Duct':([.05,.28,.70],.22,.32),
             'AeroDT_Rotor':([.12,.14,.17],.12,.43),
             'AeroDT_Gear':([.22,.25,.29],.65,.32)}
    for mat in doc.get('materials',[]):
        name=mat.get('name',''); pbr=mat.setdefault('pbrMetallicRoughness',{})
        if name in palette:
            rgb,metal,rough=palette[name]; pbr.update(baseColorFactor=linear(rgb)+[1],metallicFactor=metal,roughnessFactor=rough)
        elif name=='AeroDT_Glazing':
            pbr.update(baseColorFactor=linear([.10,.17,.24])+[.78],metallicFactor=.1,roughnessFactor=.14)
            mat['alphaMode']='BLEND'; mat['doubleSided']=True
    # A single source-to-display transform also applies to all cabin coordinates.
    nose=1 if parts['cabin']['nose']=='+Z' else -1
    angle=math.radians(90*nose)
    matrix=np.array([[math.cos(angle),0,math.sin(angle)],[0,1,0],[-math.sin(angle),0,math.cos(angle)]])
    roots=doc['scenes'][doc.get('scene',0)]['nodes']
    root_index=len(nodes)
    nodes.append({'name':'AeroDT_Meter_Forward_Frame','rotation':matrix_quaternion(matrix),
                  'scale':[FEET]*3,'translation':(-matrix@origin*FEET).tolist(),'children':list(roots)})
    roots[:]=[root_index]
    def point(v): return (matrix@(np.array(v)-origin)*FEET).tolist()
    def direction(v): return (matrix@np.array(v)).tolist()
    cockpit=meta['cockpit']; cockpit['eye']=point(cockpit['eye'])
    for k in ['forward','up']: cockpit[k]=direction(cockpit[k])
    for seat in cockpit.get('viewpoints',[]): seat['eye']=point(seat['eye'])
    for screen in cockpit.get('screens',[]):
        screen['center']=point(screen['center'])
        for k in ['right','up']: screen[k]=direction(screen[k])
        for k in ['width','height']: screen[k]*=FEET
    cockpit['coordinate_frame']='gltf_model_meters'
    for spec in meta['rotors']['nodes']:
        spec['hub']=point(spec['hub'])
        for k in ['declared_diameter','measured_diameter']: spec[k]*=FEET
    display=meta['display']; extent=measured_extent
    display['reference_extent_m']=round(float(max(extent)*FEET),6)
    display['origin']='Visual footprint centre at ground level; not a mass-property or CG definition'
    display.update(forward_axis='+X',up_axis='+Y',extent={'x':extent[2]*FEET,'y':extent[1]*FEET,'z':extent[0]*FEET},
                   scale_basis='Source feet converted once by the GLB root scale 0.3048. NASA reference convention, not certified physical measurements.')
    meta['geometry']['native_coordinates']='glTF metre scene, +X nose, +Y up; original feet mesh under the canonical root'
    meta['conversion']['repairs']=['feet_to_meters_root','canonical_forward_axis','measured_rotor_shaft_basis','airframe_specific_tilt','nasa_reference_blue_pbr','cockpit_frame_conversion']
    meta['conversion']['repair_tool']='project_support/tools/visual_assets/repair_nasa_assets.py'
    write_glb(home/'model.glb',doc,blob)
    meta['model'].update(bytes=(home/'model.glb').stat().st_size,sha256=hashlib.sha256((home/'model.glb').read_bytes()).hexdigest())
    meta['validation']={'container':'pending','gltf_validator':'pending','browser':'pending','physical_dimensions_verified':False}
    (home/'asset.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    print(home.name,len(meta['rotors']['nodes']),len(tilts),meta['model']['bytes'])

if __name__=='__main__':
    for source,(asset,*_) in CATALOGUE.items(): repair(SHELF/asset,source)
