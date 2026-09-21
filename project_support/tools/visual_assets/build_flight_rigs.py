"""Reproducible display-only rigs. Acquired model.glb files are never changed.

Run prepare_flight_mesh.mjs on X-57 first. Island IDs refer to the pinned local
source hashes; bounds/count assertions deliberately fail on a changed export.
No manufacturer kinematics or performance are claimed by these visual rigs.
"""
import copy
import hashlib
import json
import math
import subprocess
from pathlib import Path
from split_rotor_nodes import read_glb, write_glb, read_accessor, add_accessor, islands_of, centre_of
from build_control_surfaces import clipped_mesh, register, x57_controls, evtol_controls

ROOT = Path(__file__).resolve().parents[3]
LIB = ROOT / 'digital_twin/model_library/visual_assets/aircraft/civilian'


def multiply(a, b):
    return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def bake_rest_skins(r):
    """Bake the actual exported rest pose, not an assumed identity bind pose."""
    d = r.doc
    parents = {c: i for i, n in enumerate(d['nodes']) for c in n.get('children', [])}
    cache = {}
    def world(i):
        if i in cache: return cache[i]
        n = d['nodes'][i]; x, y, z, w = n.get('rotation', [0, 0, 0, 1])
        m = [[1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w, 0],
             [2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w, 0],
             [2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y, 0], [0, 0, 0, 1]]
        if 'matrix' in n: m = [[n['matrix'][c*4+a] for c in range(4)] for a in range(4)]
        else:
            for a in range(3):
                for c, scale in enumerate(n.get('scale', [1, 1, 1])): m[a][c] *= scale
                m[a][3] = n.get('translation', [0, 0, 0])[a]
        cache[i] = multiply(world(parents[i]), m) if i in parents else m
        return cache[i]
    for n in d['nodes']:
        if 'skin' not in n: continue
        assert not any(k in n for k in ('matrix', 'translation', 'rotation', 'scale'))
        skin = d['skins'][n['skin']]
        ib = read_accessor(d, r.bin, skin['inverseBindMatrices'])
        matrices = [multiply(world(j), [[v[c*4+a] for c in range(4)] for a in range(4)]) for j, v in zip(skin['joints'], ib)]
        for p in d['meshes'][n['mesh']]['primitives']:
            attrs = p['attributes']; joints = read_accessor(d, r.bin, attrs['JOINTS_0']); weights = read_accessor(d, r.bin, attrs['WEIGHTS_0'])
            for key in ('POSITION', 'NORMAL'):
                values = read_accessor(d, r.bin, attrs[key]); out = []
                for v, js, ws in zip(values, joints, weights):
                    total = sum(ws); assert total > 0
                    # Export bones have orthogonal rotations and uniform scale.
                    # Normals use inverse-scale rotations, then renormalize.
                    result = [0., 0., 0.]
                    for j, weight in zip(js, ws):
                        if not weight: continue
                        m = matrices[j]
                        scale2 = sum(m[a][0]**2 for a in range(3))
                        for a in range(3):
                            value = sum(m[a][c]*v[c] for c in range(3))
                            value = value + m[a][3] if key == 'POSITION' else value/max(scale2, 1e-16)
                            result[a] += value*weight/total
                    if key == 'NORMAL':
                        length = math.sqrt(sum(v*v for v in result)) or 1
                        result = [v/length for v in result]
                    out.append(result)
                attrs[key] = add_accessor(d, r.bin, out, kind='VEC3', component=5126, target=34962)
            for key in list(attrs):
                if key.startswith(('JOINTS_', 'WEIGHTS_')): del attrs[key]
        n.pop('skin'); n.pop('children', None)


class Rig:
    def __init__(self, identifier, source=None):
        self.directory = LIB / identifier
        self.meta = json.loads((self.directory / 'asset.json').read_text(encoding='utf-8'))
        assert hashlib.sha256((self.directory / 'model.glb').read_bytes()).hexdigest() == self.meta['model']['sha256'], 'source hash changed'
        self.doc, self.bin = read_glb(source or self.directory / 'model.glb')
        self.spin, self.tilt, self.controls = [], [], []

    def node(self, name, **props):
        index = len(self.doc['nodes'])
        self.doc['nodes'].append(dict(name=name, **props))
        return index

    def split(self, mesh, primitive, groups):
        """Extract disjoint vertex sets as new meshes, retaining every attribute."""
        p = self.doc['meshes'][mesh]['primitives'][primitive]
        attrs = {k: read_accessor(self.doc, self.bin, a) for k, a in p['attributes'].items()}
        indices = [v[0] for v in read_accessor(self.doc, self.bin, p['indices'])]
        taken = set()
        results = []
        for vertices, pivot in groups:
            vertices = set(vertices)
            assert not taken.intersection(vertices)
            taken.update(vertices)
            results.append(self.submesh(p, attrs, indices, vertices, pivot))
        left = set(range(len(attrs['POSITION']))) - taken
        if left:
            replacement = self.submesh(p, attrs, indices, left, [0, 0, 0])
            self.doc['meshes'][mesh]['primitives'][primitive] = self.doc['meshes'][replacement]['primitives'][0]
        else:
            del self.doc['meshes'][mesh]['primitives'][primitive]
        return results

    def submesh(self, p, attrs, indices, vertices, pivot):
        used = sorted(vertices)
        lookup = {v: i for i, v in enumerate(used)}
        triangles = []
        for i in range(0, len(indices), 3):
            tri = indices[i:i+3]
            inside = [v in vertices for v in tri]
            assert all(inside) or not any(inside), 'split cuts a connected triangle'
            if all(inside): triangles.extend((lookup[v],) for v in tri)
        assert triangles, 'empty part'
        part = {k: copy.deepcopy(v) for k, v in p.items() if k not in ('attributes', 'indices')}
        part['attributes'] = {}
        for key, values in attrs.items():
            if key.startswith(('JOINTS_', 'WEIGHTS_')): continue
            old = self.doc['accessors'][p['attributes'][key]]
            selected = [values[v] for v in used]
            if key == 'POSITION': selected = [[v[a]-pivot[a] for a in range(3)] for v in selected]
            part['attributes'][key] = add_accessor(self.doc, self.bin, selected, kind=old['type'], component=old['componentType'], target=34962)
        part['indices'] = add_accessor(self.doc, self.bin, triangles, kind='SCALAR', component=5125, target=34963)
        index = len(self.doc['meshes'])
        self.doc['meshes'].append({'primitives': [part]})
        return index

    def islands(self, mesh=0, primitive=0):
        p = self.doc['meshes'][mesh]['primitives'][primitive]
        ps = read_accessor(self.doc, self.bin, p['attributes']['POSITION'])
        ix = [v[0] for v in read_accessor(self.doc, self.bin, p['indices'])]
        return ps, islands_of(ps, ix)

    def hinge(self, name, pivot, children, axis, sign, offset=0):
        # Children already have mesh-local pivots; their origins are relative
        # to the new hinge, not the aircraft origin.
        for child in children:
            n = self.doc['nodes'][child]
            n['translation'] = [v-p for v, p in zip(n.get('translation', [0, 0, 0]), pivot)]
        h = self.node(name, translation=pivot, children=children)
        self.tilt.append(dict(name=name, axis=axis, sign=sign, offset_deg=offset))
        return h

    def finish(self, note):
        # Thin propeller surfaces must remain visible from below and during
        # reverse transition, not vanish when their back face turns to camera.
        for item in self.spin:
            node = next(n for n in self.doc['nodes'] if n.get('name') == item['name'])
            for p in self.doc['meshes'][node['mesh']]['primitives']:
                mat = copy.deepcopy(self.doc.get('materials', [])[p['material']]) if 'material' in p else {}
                mat['doubleSided'] = True
                p['material'] = len(self.doc.setdefault('materials', [])); self.doc['materials'].append(mat)
        dest = self.directory / 'flight_model.glb'
        write_glb(dest, self.doc, self.bin)
        compact = self.directory / 'flight_compact.glb'
        subprocess.run(['node', str(Path(__file__).with_name('prepare_flight_mesh.mjs')), str(dest), str(compact), 'floor',
                        *(['airtaxi'] if self.meta['asset_id'] in ('kp2a', 'amvlab_evtol', 'joby_s4') else [])], check=True)
        compact.replace(dest)
        rig = {'axis': 'y', 'nodes': self.spin, 'tilt': {'axis': 'z', 'sign': -1, 'frame': 'parent', 'nodes': self.tilt}}
        rig['control_surfaces']={'source':'attitude_proxy_not_actuator_telemetry','nodes':self.controls}
        self.meta['flight_visual'] = {'path': dest.name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(),
            'source_sha256': self.meta['model']['sha256'], 'rotors': rig, 'note': note,
            'purpose': 'AirTaxi dynamics visual substitute; not manufacturer simulation', 'validation': 'pending'}
        (self.directory / 'asset.json').write_text(json.dumps(self.meta, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print(self.meta['asset_id'], len(self.spin), 'spinners', len(self.tilt), 'hinges')


def joby():
    r = Rig('joby_s4'); d = r.doc
    assert len(d['nodes']) == 7
    # Display-only livery: retain the authored window geometry, not a painted
    # rectangle on the fuselage. Imported FBX default grey is not the livery.
    for index, color, metal, rough in [(1,[.92,.94,.96,1],.05,.3),
                                     (4,[.018,.045,.07,1],.2,.16),
                                     (2,[.055,.065,.075,1],.1,.4)]:
        d['materials'][index]['pbrMetallicRoughness'] = dict(
            baseColorFactor=color, metallicFactor=metal, roughnessFactor=rough)
    # The source has six independently deflected wing flap/aileron islands.
    # Neutralize their rest planes against the adjacent wing, rigidly (no
    # flattening vertices), while retaining the original acquired model.
    import numpy as np
    ps, groups = r.islands(0, 1)
    positions = np.array(ps, dtype=float)
    primitive = d['meshes'][0]['primitives'][1]
    normals = np.array(read_accessor(d, r.bin, primitive['attributes']['NORMAL']), dtype=float)
    def plane(points):
        normal = np.linalg.eigh(np.cov(points.T))[1][:,0]
        return normal if normal[1] > 0 else -normal
    for surface, wing in [(5,4),(6,4),(7,4),(8,9),(10,9),(11,9)]:
        ids = groups[surface]; points = positions[ids]
        a, b = plane(points), plane(positions[groups[wing]])
        cross = np.cross(a,b); c = float(np.dot(a,b))
        skew = np.array([[0,-cross[2],cross[1]],[cross[2],0,-cross[0]],[-cross[1],cross[0],0]])
        rotation = np.eye(3) + skew + skew@skew/(1+c)
        pivot = points[points[:,2] <= points[:,2].min()+.003].mean(axis=0)
        positions[ids] = (points-pivot)@rotation.T+pivot
        normals[ids] = normals[ids]@rotation.T
    primitive['attributes']['POSITION'] = add_accessor(d,r.bin,positions.tolist(),kind='VEC3',component=5126,target=34962)
    primitive['attributes']['NORMAL'] = add_accessor(d,r.bin,normals.tolist(),kind='VEC3',component=5126,target=34962)
    control_nodes=[]
    # Authored independent wing surfaces, now neutral, keep their exact shapes.
    selected_surfaces=[5,6,7,8,10,11]
    pivots=[]
    for g in selected_surfaces:
        pts=positions[groups[g]];edge=pts[pts[:,2]<=pts[:,2].min()+.003];pivots.append(edge.mean(axis=0).tolist())
    meshes=r.split(0,1,[(groups[g],pivot) for g,pivot in zip(selected_surfaces,pivots)])
    for i,(mesh,pivot) in enumerate(zip(meshes,pivots)):
        side=1 if pivot[0]>0 else -1
        control_nodes.append(register(r,f'Joby_wing_surface_{i+1}',mesh,pivot,[1,0,0],{'roll':-side}))
    for side in [-1,1]:
        pivot=[side*.075,-.018,-.152]
        mesh=clipped_mesh(r,0,1,[(0,side*.027,side),(2,-.152,1),(2,-.12,-1)],pivot)
        control_nodes.append(register(r,f'Joby_ruddervator_{side}',mesh,pivot,[1,-side*.7,0],{'pitch':-1,'yaw':side*.7}))
    hubs = [d['nodes'][i]['translation'] for i in range(1, 7)]
    # Six hub caps; four long nacelles; the front pair's short attachment pins.
    selected = {0: {0: 4, 1: 5, 2: 2, 3: 3, 4: 1, 5: 0},
                1: {0: 4, 1: 2, 2: 3, 3: 5}, 4: {0: 0, 1: 1}}
    pieces = [[] for _ in hubs]
    for pi, assignment in selected.items():
        ps, groups = r.islands(0, pi)
        meshes = r.split(0, pi, [(groups[g], hubs[rotor]) for g, rotor in assignment.items()])
        for rotor, mesh in zip(assignment.values(), meshes):
            pieces[rotor].append(r.node(f'Joby_nacelle_{pi}_{rotor}', mesh=mesh, translation=hubs[rotor]))
    hinges = []
    for i, hub in enumerate(hubs):
        rotor = i+1
        r.spin.append(dict(name=d['nodes'][rotor]['name'], turn=1 if i % 2 else -1, axis='y'))
        # Hinge meets the supporting strut/wing, below the disc.
        pivot = [hub[0], (-.0158 if i < 2 else -.02 if i < 4 else .001), hub[2]]
        if i < 2:
            # Move the front disc assembly back onto the authored pod tip.
            # Its short tilt neck joins the stationary pod at the hinge, so
            # the disc cannot float away during the 0..90 degree transition.
            pivot = [hub[0], -.0158, -.465]
            for child in [rotor, *pieces[i]]:
                d['nodes'][child]['translation'] = [hub[0], pivot[1]+.025, pivot[2]]
            verts, norms, triangles = [], [], []
            for y in [0,.025]:
                for k in range(12):
                    angle=2*math.pi*k/12
                    verts.append([.004*math.cos(angle),y,.004*math.sin(angle)])
                    norms.append([math.cos(angle),0,math.sin(angle)])
            for k in range(12):
                j=(k+1)%12
                triangles.extend([(k,),(j,),(12+k,),(j,),(12+j,),(12+k,)])
            mesh=len(d['meshes'])
            d['meshes'].append({'primitives':[{'attributes':{
                'POSITION':add_accessor(d,r.bin,verts,kind='VEC3',component=5126,target=34962),
                'NORMAL':add_accessor(d,r.bin,norms,kind='VEC3',component=5126,target=34962)},
                'indices':add_accessor(d,r.bin,triangles,kind='SCALAR',component=5125,target=34963), 'material':0}]})
            pieces[i].append(r.node(f'Joby_tilt_neck_{i+1}',mesh=mesh,translation=pivot))
        hinges.append(r.hinge(f'Joby_hinge_{i+1}', pivot, [rotor, *pieces[i]], 'x', -1 if i < 4 else 1))
    d['nodes'][0]['children'] = hinges+control_nodes
    # Native nose -Z -> +X. Source metre scale retained.
    d['nodes'][0]['rotation'] = [0, -math.sqrt(.5), 0, math.sqrt(.5)]
    d['nodes'][0]['translation'] = [-4.08, 1.953, 0]
    r.finish('AirTaxi-matched display extent; -Z nose normalized to +X. Front four tilt forward and rear pair backward; front disc hubs aligned to pod-tip hinges with short connecting necks. Pearl-white body, dark authored windows, wing control surfaces neutralized. Visual geometry only, not engineering joint data.')


def kp2():
    r = Rig('kp2a'); d = r.doc
    bake_rest_skins(r)
    from restore_kp2_decals import restore
    print('KP2 decals:', restore(r))
    scene = d['scenes'][d.get('scene', 0)]
    controls=[]
    # The export already supplies four distinct FlightSurface primitives.
    for i,p in enumerate(list(d['meshes'][0]['primitives'])):
        attrs={k:read_accessor(d,r.bin,a) for k,a in p['attributes'].items()}
        ps=attrs['POSITION'];edge=max(v[0] for v in ps)
        leading=[v for v in ps if v[0]>=edge-.04]
        pivot=[sum(v[a] for v in leading)/len(leading) for a in range(3)]
        indices=[v[0] for v in read_accessor(d,r.bin,p['indices'])]
        mesh=r.submesh(p,attrs,indices,set(range(len(ps))),pivot)
        side=1 if pivot[2]>0 else -1
        wing=i in (0,3)
        controls.append(register(r,f'KP2_control_surface_{i}',mesh,pivot,[0,0 if wing else side*.85,1],
            {'roll':-side} if wing else {'pitch':-1,'yaw':side*.7}))
    d['nodes'][0].pop('mesh',None);scene['nodes'].extend(controls)
    for side, sign in [('L', -1), ('R', 1)]:
        ids = [25 if side == 'L' else 50, 77 if side == 'L' else 76]
        ids += [n for n in (98, 99, 100, 101, 104, 105, 108, 109, 112, 113) if d['nodes'][n]['name'].endswith('_'+side)]
        h = r.hinge('KP2_front_'+side, [1.7112711, .0951081, sign*2.2499001], ids, 'z', -1, 90)
        scene['nodes'] = [n for n in scene['nodes'] if n not in ids]+[h]
    r.spin = copy.deepcopy(r.meta['rotors']['nodes'])
    # Rest of the aircraft, including aft vertical rotors, remains unchanged.
    r.finish('Front assemblies authored horizontal: +90 deg at VTOL, 0 deg at cruise. Pivot from source TiltServoMain; AirTaxi-matched display extent. Rear rotors remain vertical. Original KADA/VIBUM PNGs retained; enlarged side marks below canopy and two horizontal top rows use the user display layout.')


def evtol():
    r = Rig('amvlab_evtol'); d = r.doc
    # Source exports zero-strength anisotropy without tangent/normal map. The
    # Cesium shader path cannot compile that combination; base-colour texture
    # and core metallic/roughness material are sufficient for this flight rig.
    for material in d.get('materials', []): material.pop('extensions', None)
    for key in ('extensionsUsed', 'extensionsRequired'):
        d[key] = [ext for ext in d.get(key, []) if not ext.startswith('KHR_materials_')]
    ps, gs = r.islands()
    assert len(gs) == 48
    sets = [(0,[1,2,3,4]),(5,[6,7,8,9]),(13,[14,15,16,17]),(None,[18,19,20,21]),
            (23,[24,25,26,27]),(28,[29,30,31,32]),(35,[36,37,38,39]),(None,[40,41,42,43])]
    groups, pivots = [], []
    for cap, blades in sets:
        verts = sum((gs[j] for j in blades), [])
        hub = centre_of(ps, verts); pivots.append(hub)
        groups.append((verts, hub))
        if cap is not None: groups.append((gs[cap], hub))
    meshes = iter(r.split(0, 0, groups)); hinges=[]
    for i, ((cap, blades), hub) in enumerate(zip(sets, pivots)):
        rotor = r.node(f'EVTOL_rotor_{i+1}', mesh=next(meshes), translation=hub)
        kids=[rotor]
        if cap is not None: kids.append(r.node(f'EVTOL_motor_{i+1}', mesh=next(meshes), translation=hub))
        # Root maps native -Y to forward +X and native -Z to up +Y.
        hinges.append(r.hinge(f'EVTOL_hinge_{i+1}', hub, kids, 'x', -1, 90))
        r.spin.append(dict(name=d['nodes'][rotor]['name'], turn=(-1 if i%2 else 1), axis='y'))
    d['nodes'][0]['children'] = hinges+evtol_controls(r)
    r.finish('Eight original propellers split from welded mesh; authored cruise -> +90 X for VTOL. AirTaxi-matched display extent; synthetic visual hinges only.')


def x57():
    r = Rig('x_57', ROOT/'data/workspace/visual_assets/x57_light.glb'); d=r.doc
    ps, gs=r.islands(); assert len(gs)==77
    hubs=[[-23.7, 5.3, 189.73],[-23.7, 5.3, -189.73]]
    groups=[]
    for rotor,h in enumerate(hubs):
        groups.extend([(sum((gs[i] for i in ([0,1,2] if rotor==0 else [3,4,5])),[]),h),
                       (sum((gs[i] for i in ([6,8,10,12] if rotor==0 else [7,9,11,13])),[]),h)])
    meshes=r.split(0,0,groups); hinges=[]
    for i,hub in enumerate(hubs):
        rotor=r.node(f'X57_tip_rotor_{i+1}',mesh=meshes[i*2],translation=hub)
        pod=r.node(f'X57_tip_motor_{i+1}',mesh=meshes[i*2+1],translation=hub)
        hinges.append(r.hinge(f'X57_tip_hinge_{i+1}',[0,5.3,hub[2]],[rotor,pod],'z',1,-90))
        r.spin.append(dict(name=d['nodes'][rotor]['name'],turn=1 if i else -1,axis='x'))
    # The small blades are partly welded to nacelles in this source. Partition
    # complete triangles in each thin propeller plane, never move the nacelles.
    def extract(predicate, pivot):
        p=d['meshes'][0]['primitives'][0]
        attrs={k:read_accessor(d,r.bin,a) for k,a in p['attributes'].items()}
        ix=[v[0] for v in read_accessor(d,r.bin,p['indices'])]
        take=[];left=[]
        for j in range(0,len(ix),3):
            tri=ix[j:j+3];xyz=[sum(attrs['POSITION'][v][a] for v in tri)/3 for a in range(3)]
            (take if predicate(xyz) else left).extend(tri)
        assert take and left
        part=copy.deepcopy(p);part['indices']=add_accessor(d,r.bin,[(v,) for v in take],kind='SCALAR',component=5125,target=34963)
        mesh=r.submesh(part,attrs,take,set(take),pivot)
        p['indices']=add_accessor(d,r.bin,[(v,) for v in left],kind='SCALAR',component=5125,target=34963)
        return mesh
    for side in [-1,1]:
        for i,(x,z) in enumerate([(-20.55,148.37),(-24.07,125.69),(-22.09,103.01),(-25.55,80.33),(-23.57,57.65),(-25.55,34.97)]):
            hub=[x,.03,side*z]
            mesh=extract(lambda p:abs(p[0]-x)<1.65 and abs(p[2]-side*z)<11.6 and abs(p[1]-.03)<11.6,hub)
            node=r.node(f'X57_inboard_rotor_{side}_{i+1}',mesh=mesh,translation=hub);hinges.append(node)
            r.spin.append(dict(name=d['nodes'][node]['name'],axis='x',turn=side,start_at_tilt_deg=85))
    # Synthetic display livery: the NASA source has no separate glass material.
    # Reuse the fuselage surface for paired cabin windows and windshield.
    # Clip triangles at window borders instead of selecting their centroids:
    # the low-poly fuselage otherwise leaves a visibly jagged glazing edge.
    p=d['meshes'][0]['primitives'][0]
    attrs={k:read_accessor(d,r.bin,a) for k,a in p['attributes'].items()}
    ix=[v[0] for v in read_accessor(d,r.bin,p['indices'])]
    faces=[[{k:list(values[v]) for k,values in attrs.items()} for v in ix[j:j+3]] for j in range(0,len(ix),3)]
    glass=[]
    def cut(poly,axis,bound,sign):
        yes=[];no=[]
        for a,b in zip(poly,poly[1:]+poly[:1]):
            da=(a['POSITION'][axis]-bound)*sign;db=(b['POSITION'][axis]-bound)*sign
            (yes if da>=0 else no).append(a)
            if (da>=0)!=(db>=0):
                t=da/(da-db);v={k:[x+(y-x)*t for x,y in zip(a[k],b[k])] for k in a}
                yes.append(v);no.append(v)
        return yes,no
    for side in [-1,1]:
        for x0,x1,z0 in [(-100,-70,5),(-64,-49,15),(-44,-29,15)]:
            bounds=[(0,x0,1),(0,x1,-1),(1,-5,1),(1,20,-1),(2,side*z0,side)]
            remaining=[]
            for face in faces:
                inside=face
                for axis,bound,sign in bounds:
                    if len(inside)<3:break
                    inside,outside=cut(inside,axis,bound,sign)
                    if len(outside)>=3:remaining.append(outside)
                if len(inside)>=3:glass.append(inside)
            faces=remaining
    def surface(polygons):
        vertices=[];indices=[];lookup={}
        for poly in polygons:
            for j in range(1,len(poly)-1):
                tri=(poly[0],poly[j],poly[j+1])
                a,b,c=[v['POSITION'] for v in tri];u=[b[k]-a[k] for k in range(3)];v=[c[k]-a[k] for k in range(3)]
                if sum((u[(k+1)%3]*v[(k+2)%3]-u[(k+2)%3]*v[(k+1)%3])**2 for k in range(3))<1e-12:continue
                for v in tri:
                    key=tuple(x for k in attrs for x in v[k])
                    if key not in lookup:lookup[key]=len(vertices);vertices.append(v)
                    indices.append((lookup[key],))
        primitive={'attributes':{},'indices':add_accessor(d,r.bin,indices,kind='SCALAR',component=5125,target=34963)}
        for k in attrs:
            values=[v[k] for v in vertices]
            if k=='NORMAL':values=[[x/(math.sqrt(sum(y*y for y in v)) or 1) for x in v] for v in values]
            old=d['accessors'][p['attributes'][k]]
            primitive['attributes'][k]=add_accessor(d,r.bin,values,kind=old['type'],component=old['componentType'],target=34962)
        return primitive
    d['meshes'][0]['primitives'][0]=surface(faces)
    window=len(d['meshes']);d['meshes'].append({'primitives':[surface(glass)]})
    hinges.append(r.node('X57_cabin_glazing',mesh=window))
    d['nodes'][0].update(rotation=[0,1,0,0],scale=[.0254]*3,children=hinges,translation=[.82,1.098,0])
    d['materials']=[{'name':'Pearl white fuselage','pbrMetallicRoughness':{'baseColorFactor':[.92,.94,.96,1],'metallicFactor':.05,'roughnessFactor':.3}},
                    {'name':'Dark blue cabin glass','pbrMetallicRoughness':{'baseColorFactor':[.018,.045,.07,1],'metallicFactor':.2,'roughnessFactor':.16}},
                    {'name':'Graphite propellers','pbrMetallicRoughness':{'baseColorFactor':[.055,.065,.075,1],'metallicFactor':.1,'roughnessFactor':.4}}]
    for m in d['meshes']:
        for p in m['primitives']:p['material']=0
    d['meshes'][window]['primitives'][0]['material']=1
    for spec in r.spin:
        node=next(n for n in d['nodes'] if n.get('name')==spec['name'])
        d['meshes'][node['mesh']]['primitives'][0]['material']=2
    black=len(d['materials'])
    d['materials'].append({'name':'Satin black tip propulsion', 'pbrMetallicRoughness':{
        'baseColorFactor':[.009,.012,.016,1],'metallicFactor':.05,'roughnessFactor':.48}})
    for node in d['nodes']:
        if node.get('name','').startswith(('X57_tip_rotor_','X57_tip_motor_')):
            for primitive in d['meshes'][node['mesh']]['primitives']:primitive['material']=black
    d['nodes'][0]['children'].extend(x57_controls(r))
    r.finish('Hypothetical wing-tip VTOL conversion, not real X-57 capability. Twelve inboard propellers rotate only at tilt >=85 deg by user display policy; not actual X-57 high-lift operation. Synthetic pearl-white livery and dark cabin glazing. Original NASA model preserved; .0254 visual scale retained.')


if __name__ == '__main__':
    joby(); kp2(); evtol(); x57()
