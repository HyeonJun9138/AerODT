import json
from pathlib import Path
import sys
import unittest
import numpy as np
import math
import tempfile
import shutil
import hashlib
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'project_support/tools/visual_assets'))
from split_rotor_nodes import read_glb, read_accessor
SHELF = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian'

class NasaRepairTests(unittest.TestCase):
    def test_nine_models_have_meter_forward_frame(self):
        homes = list(SHELF.glob('nasa_*'))
        self.assertEqual(len(homes), 9)
        for home in homes:
            with self.subTest(asset=home.name):
                m = json.loads((home/'asset.json').read_text(encoding='utf-8'))
                self.assertEqual(m['display']['forward_axis'], '+X')
                self.assertEqual(m['cockpit']['coordinate_frame'], 'gltf_model_meters')
                d,_ = read_glb(home/'model.glb')
                roots = d['scenes'][d.get('scene',0)]['nodes']
                self.assertEqual(len(roots), 1)
                self.assertEqual(d['nodes'][roots[0]]['scale'], [.3048]*3)
                self.assertIn('translation',d['nodes'][roots[0]])

    def test_node_names_unique_and_all_seated_eyes_in_meters(self):
        for home in SHELF.glob('nasa_*'):
            with self.subTest(asset=home.name):
                d,_=read_glb(home/'model.glb')
                names=[n['name'] for n in d['nodes'] if n.get('name','').startswith('AeroDT_')]
                self.assertEqual(len(names),len(set(names)))
                m=json.loads((home/'asset.json').read_text(encoding='utf-8'))
                self.assertEqual(m['cockpit']['eye'],m['cockpit']['viewpoints'][0]['eye'])

    def test_quadrotor_source_nose_is_not_the_high_rear_rotor_end(self):
        for name in ['nasa_quadrotor_collflap','nasa_quadrotor_rpm']:
            d,_=read_glb(SHELF/name/'model.glb')
            root=d['nodes'][d['scenes'][0]['nodes'][0]]
            self.assertLess(root['rotation'][1],0)

    def test_tiltduct_ring_and_vanes_follow_rotor(self):
        for name in ['nasa_tiltduct_cross','nasa_tiltduct_direct']:
            d,_=read_glb(SHELF/name/'model.glb')
            for number in range(6):
                h=next(n for n in d['nodes'] if n.get('name')==f'AeroDT_Hinge_rotor_{number}')
                names=[d['nodes'][i]['name'] for i in h['children']]
                self.assertIn(f'VSP_Duct_{number}',names)
                if name.endswith('direct'): self.assertIn(f'VSP_HVane_{number}',names)

    def test_source_human_proxies_do_not_block_cockpit(self):
        for home in SHELF.glob('nasa_*'):
            d,_=read_glb(home/'model.glb')
            active=[]
            def visit(i):
                active.append(i)
                for c in d['nodes'][i].get('children',[]): visit(c)
            for i in d['scenes'][0]['nodes']: visit(i)
            self.assertFalse(any(d['nodes'][i].get('name')=='VSP_HumanGeom' for i in active))
            for i in active:
                n=d['nodes'][i]
                if n.get('name','').startswith('Cabin_occupant_'): self.assertLess(max(n['scale']),.001)

    def test_rotor_geometry_is_preserved_and_tilt_points_forward(self):
        def local(n):
            x,y,z,w=n.get('rotation',[0,0,0,1])
            m=np.eye(4)
            m[:3,:3]=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])@np.diag(n.get('scale',[1,1,1]))
            m[:3,3]=n.get('translation',[0,0,0]);return m
        def worlds(d, specs=None, angle=0):
            result={}
            def visit(i,parent):
                n=d['nodes'][i];m=local(n)
                if specs and n.get('name') in specs:
                    spec=specs[n['name']];a=math.radians(angle*spec['sign']+spec['offset_deg']);c=math.cos(a);s=math.sin(a)
                    m[:3,:3]=np.array([[1,0,0],[0,c,-s],[0,s,c]])@m[:3,:3]
                result[i]=parent@m
                for child in n.get('children',[]):visit(child,result[i])
            for i in d['scenes'][0]['nodes']:visit(i,np.eye(4))
            return result
        for home in SHELF.glob('nasa_*'):
            with self.subTest(asset=home.name):
                d,b=read_glb(home/'model.glb');old,ob=read_glb(ROOT/'data/workspace/visual_assets/nasa_repair_original'/home.name/'model.glb')
                m=json.loads((home/'asset.json').read_text(encoding='utf8'));world=worlds(d);ow=worlds(old)
                root=local(d['nodes'][d['scenes'][0]['nodes'][0]])
                for spec in m['rotors']['nodes']:
                    i=next(i for i,n in enumerate(d['nodes']) if n.get('name')==spec['name'])
                    oi=next(i for i,n in enumerate(old['nodes']) if n.get('name')==spec['name'])
                    def pts(doc,blob,idx):
                        prim=doc['meshes'][doc['nodes'][idx]['mesh']]['primitives'][0]
                        p=np.asarray(read_accessor(doc,blob,prim['attributes']['POSITION']))[::31]
                        return np.column_stack([p,np.ones(len(p))])
                    np.testing.assert_allclose(pts(d,b,i)@world[i].T,pts(old,ob,oi)@(root@ow[oi]).T,atol=2e-6)
                tilts={s['name']:s for s in m['rotors'].get('tilt',{}).get('nodes',[])}
                if tilts:
                    for angle,expected in [(0,np.array([0,1,0])),(90,np.array([1,0,0]))]:
                        posed=worlds(d,tilts,angle)
                        for spec in m['rotors']['nodes']:
                            i=next(i for i,n in enumerate(d['nodes']) if n.get('name')==spec['name'])
                            axis=posed[i][:3,1];axis/=np.linalg.norm(axis)
                            self.assertGreater(axis@expected,.999)

    def test_repair_is_repeatable_and_keeps_thumbnail_hash_valid(self):
        from repair_nasa_assets import repair
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder)/'nasa_tiltwing';home.mkdir()
            for filename in ['model.glb','asset.json','thumbnail.jpg']:
                shutil.copy2(SHELF/home.name/filename,home/filename)
            repair(home,'NASA_Tiltwing_6pax')
            first=hashlib.sha256((home/'model.glb').read_bytes()).hexdigest()
            repair(home,'NASA_Tiltwing_6pax')
            self.assertEqual(first,hashlib.sha256((home/'model.glb').read_bytes()).hexdigest())
            m=json.loads((home/'asset.json').read_text(encoding='utf8'))
            self.assertEqual(m['thumbnail']['sha256'],hashlib.sha256((home/'thumbnail.jpg').read_bytes()).hexdigest())

    def test_fixed_rotor_aircraft_do_not_tilt(self):
        for name in ['nasa_quadrotor_collflap','nasa_quadrotor_rpm','nasa_qsmr','nasa_side_by_side','nasa_lift_cruise']:
            m=json.loads((SHELF/name/'asset.json').read_text(encoding='utf-8'))
            with self.subTest(asset=name):
                self.assertNotIn('tilt',m['rotors'])

    def test_tiltwing_moves_main_wing_with_six_propellers(self):
        d,_=read_glb(SHELF/'nasa_tiltwing/model.glb')
        hinges=[n for n in d['nodes'] if n.get('name')=='AeroDT_MainWing_Tilt']
        self.assertEqual(len(hinges),1)
        names=[d['nodes'][i]['name'] for i in hinges[0]['children']]
        self.assertIn('VSP_Wing_1',names)
        self.assertEqual(sum(n.startswith('AeroDT_Rotor_') for n in names),6)

if __name__=='__main__': unittest.main()
