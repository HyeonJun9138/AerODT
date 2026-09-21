"""Authored facility geometry stays in the operational envelope; PBR stays local."""
import importlib.util
import sys
import json
import struct
import tempfile
import unittest
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[3]
TOOLS=ROOT/'project_support/tools/visual_assets'
sys.path.insert(0,str(TOOLS))
import build_vertiport_facilities as facilities

class FacilitySurfaceTests(unittest.TestCase):
 def test_bounds_winding_and_mesh_budget(self):
  for model in [facilities.terminal(),facilities.charger()]:
   self.assertLessEqual(len(model.parts),8)
   self.assertLess(sum(len(p[3])//3 for p in model.parts.values()),1000)
   for v,n,uv,ix in model.parts.values():
    v,n,ix=np.asarray(v),np.asarray(n),np.asarray(ix).reshape(-1,3)
    self.assertTrue(np.isfinite(v).all());self.assertTrue((np.abs(v)<=.50001).all())
    self.assertTrue(np.allclose(np.linalg.norm(n,axis=1),1))
    self.assertTrue((ix>=0).all() and (ix<len(v)).all())
    normal=np.cross(v[ix[:,1]]-v[ix[:,0]],v[ix[:,2]]-v[ix[:,0]])
    self.assertTrue(((normal*n[ix[:,0]]).sum(1)>=-1e-9).all(),'back-face winding')
 def test_self_contained_pbr_and_deterministic_asset(self):
  with tempfile.TemporaryDirectory() as temp:
   for build in [facilities.terminal,facilities.charger]:
    path=Path(temp)/'facility.glb';first=build().save(path);raw=path.read_bytes()
    second=build().save(path);self.assertEqual(first,second)
    magic,version,length=struct.unpack_from('<III',raw);self.assertEqual(length,len(raw));self.assertEqual(version,2)
    size=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+size])
    self.assertEqual(doc['nodes'][0]['name'],'Facility');self.assertLess(len(raw),950000)
    for image in doc['images']:self.assertNotIn('uri',image);self.assertEqual(image['mimeType'],'image/png')
    for material in doc['materials']:
     self.assertIn('normalTexture',material);self.assertIn('occlusionTexture',material)
     self.assertIn('metallicRoughnessTexture',material['pbrMetallicRoughness'])
    for view in doc['bufferViews']:
     self.assertEqual(view['byteOffset']%4,0)
     self.assertLessEqual(view['byteOffset']+view['byteLength'],doc['buffers'][0]['byteLength'])

if __name__=='__main__':unittest.main()
