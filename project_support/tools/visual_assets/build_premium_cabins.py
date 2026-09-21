"""Four non-NASA display cabins; stable pre-upgrade backups, no exterior edits."""
import copy, hashlib, json, shutil, math
from pathlib import Path
from split_rotor_nodes import read_glb,write_glb
from cabin_geometry import rounded_box
from build_uam_cabins import LAYOUTS as ALL_LAYOUTS,LIB,ROOT
# X-57 is also a NASA aircraft: keep its assets untouched.
LAYOUTS={k:v for k,v in ALL_LAYOUTS.items() if k != "x_57"}
VERSION='premium_cabin_20260917'
BACKUP=ROOT/'project_support/cockpit_work/premium_20260917/originals'


def build(asset_id):
    assert asset_id in LAYOUTS and not asset_id.startswith('nasa_')
    folder=LIB/asset_id;meta_path=folder/'asset.json';current=json.loads(meta_path.read_text(encoding='utf-8'))
    target=folder/current['flight_visual']['path'];backup=BACKUP/asset_id;backup.mkdir(parents=True,exist_ok=True)
    if not (backup/'model.glb').exists():
        shutil.copy2(target,backup/'model.glb');shutil.copy2(meta_path,backup/'asset.json')
    d,b=read_glb(backup/'model.glb');meta=copy.deepcopy(current)
    layout=LAYOUTS[asset_id];s=layout['seat'];w=layout['width'];floor=layout['floor'];eye=layout['eye']
    materials={}
    for name,color,rough,metal,emission in [
        ('leather',[.13,.17,.19,1],.78,0,.035),('insert',[.27,.32,.33,1],.95,0,.035),
        ('shell',[.64,.61,.55,1],.67,0,.04),('liner',[.75,.73,.68,1],.90,0,.08),
        ('carpet',[.12,.14,.15,1],1,0,.015),('metal',[.32,.37,.39,1],.33,.72,0),
        ('belt',[.075,.085,.095,1],.94,0,.01),('seam',[.56,.55,.50,1],.92,0,.03),
        ('led',[1,.83,.58,1],.3,0,.85),('diffuser',[.89,.87,.80,1],.45,0,.18)]:
        materials[name]=len(d['materials']);d['materials'].append({'name':'Premium_'+name,
            'pbrMetallicRoughness':{'baseColorFactor':color,'roughnessFactor':rough,'metallicFactor':metal},
            'emissiveFactor':[c*emission for c in color[:3]],'doubleSided':True})
    cache={};parts=[]
    def shape(name,center,size,mat,parent,soft=False,rotation=None):
        key=(mat,tuple(size),soft)
        if key not in cache:cache[key]=rounded_box(d,b,size,min(size)*(.46 if soft else .25),materials[mat])
        n={'name':name,'mesh':cache[key],'translation':center}
        if rotation:n['rotation']=rotation
        index=len(d['nodes']);d['nodes'].append(n);d['nodes'][parent].setdefault('children',[]).append(index);parts.append(index)
        return index
    # Keep cabin roots, view points and all exterior/rotor nodes unchanged.
    seat_roots=[(i,n) for i,n in enumerate(d['nodes']) if n.get('extras',{}).get('cabin_role') in ('passenger_seat','pilot_seat')]
    for i,n in seat_roots:
        n['children']=[];name=n['name']
        shape(name+'_pedestal',[0,s*.20,0],[s*.58,s*.32,s*.58],'metal',i)
        shape(name+'_pan',[s*.02,s*.40,0],[s*.94,s*.12,s*.93],'shell',i)
        shape(name+'_cushion',[s*.06,s*.53,0],[s*1.02,s*.24,s*.90],'leather',i,True)
        shape(name+'_insert',[s*.07,s*.62,0],[s*.73,s*.045,s*.60],'insert',i)
        # Swept back shell and upholstered lumbar, shoulder and side bolsters.
        tilt=math.radians(7);rotation=[0,0,math.sin(tilt/2),math.cos(tilt/2)]
        shape(name+'_back_shell',[-s*.41,s*1.03,0],[s*.18,s*1.12,s*.94],'shell',i,rotation=rotation)
        shape(name+'_lumbar',[-s*.285,s*.83,0],[s*.23,s*.36,s*.68],'insert',i,True)
        shape(name+'_back_pad',[-s*.30,s*1.20,0],[s*.19,s*.52,s*.67],'insert',i,True)
        shape(name+'_headrest',[-s*.37,s*1.67,0],[s*.24,s*.31,s*.60],'leather',i,True)
        for side in [-1,1]:
            shape(name+f'_wing{side}',[-s*.285,s*1.63,side*s*.29],[s*.30,s*.29,s*.15],'leather',i,True)
            shape(name+f'_bolster{side}',[-s*.23,s*1.07,side*s*.37],[s*.27,s*.86,s*.15],'leather',i,True)
            shape(name+f'_arm{side}',[s*.02,s*.88,side*s*.50],[s*.77,s*.10,s*.13],'leather',i)
            shape(name+f'_support{side}',[-s*.20,s*.68,side*s*.50],[s*.07,s*.35,s*.07],'metal',i)
            shape(name+f'_belt{side}',[s*.12,s*.66,side*s*.22],[s*.12,s*.025,s*.35],'belt',i)
        shape(name+'_buckle',[s*.12,s*.68,0],[s*.14,s*.035,s*.11],'metal',i)
        for k in range(5):
            shape(name+f'_stitch{k}',[-s*.195,s*(.84+k*.115),0],[s*.013,s*.008,s*.53],'seam',i)
    # Remove old seat dress-up only; preserve dashboards and earlier partition.
    for n in d['nodes']:
        if n.get('name')=='Cabin_refinement_20260917':
            n['children']=[i for i in n.get('children',[]) if not d['nodes'][i].get('name','').startswith('Cabin_seat_')]
    root=len(d['nodes']);d['nodes'].append({'name':VERSION,'children':[],'extras':{'visual_only':True,'certified':False}})
    d['scenes'][d.get('scene',0)]['nodes'].append(root)
    front=max(layout['rows'])+s*.55;back=min(layout['rows'])-s*.60;length=front-back;middle=(front+back)/2
    roof=max(eye[1]+s*.62,floor+s*2.24)
    # Rear trim stays behind the final seat row; glazing remains uncovered.
    shape('Premium_rear_bulkhead',[back-s*.12,(floor+roof)/2,0],[s*.045,roof-floor,w*.88],'liner',root)
    shape('Premium_rear_access_panel',[back-s*.09,floor+(roof-floor)*.49,0],[s*.025,(roof-floor)*.74,w*.28],'shell',root)
    shape('Premium_rear_panel_grip',[back-s*.065,floor+(roof-floor)*.48,w*.09],[s*.025,s*.18,s*.025],'metal',root)
    # Segmented headliner covers the opaque cabin roof, not side glazing or cockpit.
    for row,x in enumerate(layout['rows']):
        panel_length=length/len(layout['rows'])*.98
        shape(f'Premium_headliner_{row}',[x,roof+s*.03,0],[panel_length,s*.035,w*.76],'liner',root)
    # Shallow outboard bins stay above the side window sightline.
    shape('Premium_carpet',[middle,floor+.012,0],[length,.012,w*.87],'carpet',root)
    for side in [-1,1]:
        shape(f'Premium_lower_liner{side}',[middle,floor+s*.40,side*w*.485],[length,s*.64,.025],'liner',root)
        shape(f'Premium_rail{side}',[middle,floor+s*.76,side*w*.47],[length,.015,.024],'metal',root)
        shape(f'Premium_light_cove{side}',[middle,roof,side*w*.39],[length,s*.10,w*.11],'liner',root)
        shape(f'Premium_LED{side}',[middle,roof-s*.058,side*w*.35],[length,s*.018,w*.035],'led',root)
        for row,x in enumerate(layout['rows']):
            bin_length=min(s*1.4,length/len(layout['rows'])*.90)
            shape(f'Premium_bin{side}_{row}',[x,roof-s*.13,side*w*.465],[bin_length,s*.27,w*.14],'liner',root)
            shape(f'Premium_bin_handle{side}_{row}',[x,roof-s*.275,side*w*.427],[s*.30,s*.022,w*.025],'metal',root)
            shape(f'Premium_reading_light{side}_{row}',[x+s*.18,roof-s*.285,side*w*.415],[s*.10,s*.014,s*.08],'diffuser',root)
    write_glb(target,d,b)
    meta['flight_visual'].update(sha256=hashlib.sha256(target.read_bytes()).hexdigest(),bytes=target.stat().st_size,validation='pending')
    meta['cockpit']['interior_refinement']=VERSION+'; contoured seats, matte trim, shallow bins, emissive light strips; display-only'
    meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return {'asset':asset_id,'seat_roots':len(seat_roots),'added_nodes':len(parts),'bytes':target.stat().st_size}

if __name__=='__main__':
    print(json.dumps([build(key) for key in LAYOUTS],indent=2))
