"""Additive AirTaxi interior trim, preserving the current flight model/rig.
Research visualization only, not certified cabin dimensions/materials.
"""
import json, hashlib, shutil
from pathlib import Path
from split_rotor_nodes import read_glb,write_glb
from build_uam_cabins import box_mesh
from cabin_geometry import rounded_box
ROOT=Path(__file__).resolve().parents[3]
DIRECTORY=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian/projectairsim_airtaxi'


def refine():
    meta_path=DIRECTORY/'asset.json';meta=json.loads(meta_path.read_text(encoding='utf-8'))
    path=DIRECTORY/meta['flight_visual']['path'];d,b=read_glb(path)
    if any(n.get('name')=='Cabin_refinement_20260917' for n in d['nodes']):
        return {'status':'already_present'}
    backup=ROOT/'project_support/cockpit_work/interior_20260917'
    backup.mkdir(parents=True,exist_ok=True)
    if not (backup/path.name).exists():
        shutil.copy2(path,backup/path.name);shutil.copy2(meta_path,backup/'asset.json')
    palette={'Cabin_trim':([.115,.14,.16,1],.88,.05),'Cabin_seat':([.16,.19,.21,1],.93,0),
             'Cabin_cushion':([.27,.29,.29,1],.95,0),'Cabin_metal':([.31,.34,.36,1],.4,.7)}
    for m in d['materials']:
        if m.get('name') in palette:
            color,rough,metal=palette[m['name']];m['pbrMetallicRoughness'].update(baseColorFactor=color,roughnessFactor=rough,metallicFactor=metal)
    mats={m.get('name'):i for i,m in enumerate(d['materials'])}
    children=[]
    def box(name,center,size,material='Cabin_trim',rounding=True):
        mat=mats[material]
        mesh=rounded_box(d,b,size,min(size)*.18,mat) if rounding else box_mesh(d,b,mat)
        children.append(len(d['nodes']))
        d['nodes'].append({'name':name,'mesh':mesh,'translation':center,'scale':[1,1,1] if rounding else size})
    # Side panels leave the centre aisle open and separate only the front cockpit.
    for side in [-1,1]:
        box('Cabin_partition_side_'+str(side),[.84,1.27,side*.55],[.045,1.05,.53])
        box('Cabin_partition_inlay_'+str(side),[.813,1.27,side*.55],[.012,.84,.43],'Cabin_cushion')
        box('Cabin_partition_rail_'+str(side),[.805,1.20,side*.285],[.025,.76,.022],'Cabin_metal')
        box('Cabin_side_liner_'+str(side),[.15,.94,side*.805],[1.5,.40,.038],'Cabin_cushion')
        box('Cabin_sill_rail_'+str(side),[.35,1.155,side*.80],[1.75,.024,.035],'Cabin_metal')
    box('Cabin_partition_header',[.84,1.84,0],[.055,.11,1.62])
    box('Cabin_floor_runner',[.15,.726,0],[1.5,.012,.53],'Cabin_seat')
    # Small cushion pads provide visible seams without new bitmap textures.
    seats=[n for n in d['nodes'] if n.get('extras',{}).get('cabin_role') in ('pilot_seat','passenger_seat')]
    for index,seat in enumerate(seats):
        x,y,z=seat['translation']
        for side in [-1,1]:
            box(f'Cabin_seat_bolster_{index}_{side}',[x+.025,y+.27,z+side*.185],[.38,.08,.07],'Cabin_seat')
        for rib in [-1,0,1]:
            box(f'Cabin_seat_stitch_{index}_{rib}',[x-.146,y+.48,z+rib*.105],[.015,.35,.013],'Cabin_cushion')
        box(f'Cabin_seat_buckle_{index}',[x+.075,y+.29,z+.14],[.045,.02,.034],'Cabin_metal')
    root=len(d['nodes']);d['nodes'].append({'name':'Cabin_refinement_20260917','children':children,'extras':{'visual_only':True,'certified':False}})
    d['scenes'][d.get('scene',0)]['nodes'].append(root)
    write_glb(path,d,b)
    meta['flight_visual'].update(sha256=hashlib.sha256(path.read_bytes()).hexdigest(),bytes=path.stat().st_size,validation='pending')
    meta['cockpit']['interior_refinement']='20260917: matte trim, seat bolsters, front partition with open aisle; visual-only, not certified'
    meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return {'status':'updated','nodes_added':len(children)+1,'bytes':path.stat().st_size}

if __name__=='__main__':print(refine())
