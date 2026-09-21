"""Unreal-only read/export of original logo PNGs and Blueprint component templates.
Does not spawn the flight actor or save/modify source packages.
Set AERODT_LOGO_OUTPUT to the generated-output directory.
"""
import unreal, json, os, traceback
from pathlib import Path
out=os.environ.get('AERODT_LOGO_OUTPUT',str(Path(__file__).resolve().parents[3]/'data/workspace/visual_assets/kp2_decals'));os.makedirs(out,exist_ok=True)
result={}
try:
 for name in ['KADA_Logo','VIBUM_Logo']:
  tex=unreal.load_asset('/Game/KP2A/Material/'+name)
  task=unreal.AssetExportTask();task.object=tex;task.filename=out+'/'+name+'.png';task.automated=True;task.prompt=False;task.replace_identical=True;task.exporter=unreal.TextureExporterPNG()
  result[name]=unreal.Exporter.run_asset_export_task(task)
 bp=unreal.load_asset('/Game/KP2A/KP2A_Blueprint')
 subsystem=unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
 handles=subsystem.k2_gather_subobject_data_for_blueprint(bp)
 components=[]
 result["hierarchy"]=[]
 for h in handles:
  data=unreal.SubobjectDataBlueprintFunctionLibrary.get_data(h)
  obj=unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data)
  if isinstance(obj,unreal.SceneComponent):
   ph=unreal.SubobjectDataBlueprintFunctionLibrary.get_parent_handle(data)
   po=unreal.SubobjectDataBlueprintFunctionLibrary.get_object(unreal.SubobjectDataBlueprintFunctionLibrary.get_data(ph))
   loc=obj.get_editor_property('relative_location');rot=obj.get_editor_property('relative_rotation').quaternion();sc=obj.get_editor_property('relative_scale3d')
   result['hierarchy'].append({'name':obj.get_name(),'parent':po.get_name() if po else None,'translation_cm':[loc.x,loc.y,loc.z],'rotation_xyzw':[rot.x,rot.y,rot.z,rot.w],'scale':[sc.x,sc.y,sc.z]})
  if isinstance(obj,unreal.DecalComponent):components.append(obj)
 result['decals']=[]
 for c in components:
  p=c.get_editor_property('relative_location'); q=c.get_editor_property('relative_rotation').quaternion(); s=c.get_editor_property('relative_scale3d')
  ds=c.get_editor_property('decal_size');mat=c.get_editor_property('decal_material')
  result['decals'].append({'name':c.get_name(),'translation_cm':[p.x,p.y,p.z],'rotation_xyzw':[q.x,q.y,q.z,q.w],'scale':[s.x,s.y,s.z],'size_cm':[ds.x,ds.y,ds.z],'material':mat.get_name() if mat else None})
except Exception:result['error']=traceback.format_exc()
with open(out+'/decals.json','w') as f:json.dump(result,f,indent=2)


if "error" in result: raise RuntimeError(result["error"])
