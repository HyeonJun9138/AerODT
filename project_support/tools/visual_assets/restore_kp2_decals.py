"""Restore source KP2 Unreal decals as clipped surface geometry in flight GLB.
Original PNG alpha is retained; user display layout is separate from authored placement.
"""
import json
import numpy as np
from split_rotor_nodes import read_accessor, add_accessor


def rotation(q):
    x,y,z,w=q
    return np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],
                     [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],
                     [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])


def restore(r):
    directory=r.directory/'decals'
    data=json.loads((directory/'placement.json').read_text(encoding='utf-8'))
    doc=r.doc
    # Unreal centimetres (X forward, Z up) to exported glTF metres (Y up).
    swap=np.array([[1,0,0],[0,0,1],[0,1,0]])
    hierarchy={n['name']:n for n in data['hierarchy']}
    def world(name):
        n=hierarchy[name];m=np.eye(4);m[:3,:3]=rotation(n['rotation_xyzw'])@np.diag(n['scale']);m[:3,3]=n['translation_cm']
        return world(n['parent'])@m if n['parent'] in hierarchy else m
    parents={c:i for i,n in enumerate(doc['nodes']) for c in n.get('children',[])}
    def mesh_world(i):
        n=doc['nodes'][i]
        if 'matrix' in n:m=np.array(n['matrix']).reshape(4,4).T
        else:
            m=np.eye(4);m[:3,:3]=rotation(n.get('rotation',[0,0,0,1]))@np.diag(n.get('scale',[1,1,1]));m[:3,3]=n.get('translation',[0,0,0])
        return mesh_world(parents[i])@m if i in parents else m
    triangles=[]; surfaces=[]
    # Decals belong on painted surfaces, not the transparent canopy or rotors.
    for i,n in enumerate(doc['nodes']):
        if 'mesh' not in n or not any(k in n.get('name','') for k in ['Parts_KP2A_Body','Parts_KP2A_Wing'] ) or 'Window' in n.get('name',''):continue
        matrix=mesh_world(i)
        for p in doc['meshes'][n['mesh']]['primitives']:
            vs=np.array(read_accessor(doc,r.bin,p['attributes']['POSITION']))
            vs=vs@matrix[:3,:3].T+matrix[:3,3]
            ix=np.array(read_accessor(doc,r.bin,p['indices'])).reshape(-1,3)
            triangles.extend(vs[ix]); surfaces.extend(['Wing' if 'Parts_KP2A_Wing' in n['name'] else 'Body']*len(ix))
    triangles=np.array(triangles)
    reports=[]
    layout=json.loads((directory/'display_layout.json').read_text(encoding='utf-8'))
    for mark in layout['marks']:
        name=mark['name']
        basis=np.array(mark['basis']) if 'basis' in mark else swap@world(name)[:3,:3]
        origin=np.array(mark['center_m']);half=np.array(mark['half_extent_m'])
        chosen=triangles if mark['surface']=='Top' else triangles[np.array(surfaces)==mark['surface']]
        facing=np.cross(chosen[:,1]-chosen[:,0],chosen[:,2]-chosen[:,0])
        lengths=np.linalg.norm(facing,axis=1)
        chosen=chosen[(facing@np.array(mark['normal']))>lengths*.3]
        local=(chosen-origin)@np.linalg.inv(basis).T
        candidates=local[np.all(local.max(axis=1)>=-half,axis=1)&np.all(local.min(axis=1)<=half,axis=1)]
        vertices=[];normals=[];uv=[]
        for tri in candidates:
            poly=list(tri)
            for axis in range(3):
                for sign in [-1,1]:
                    output=[]
                    for a,b in zip(poly,poly[1:]+poly[:1]):
                        da=half[axis]-sign*a[axis];db=half[axis]-sign*b[axis]
                        if da>=0:output.append(a)
                        if (da>=0)!=(db>=0):output.append(a+(b-a)*(da/(da-db)))
                    poly=output
                    if not poly:break
                if not poly:break
            for k in range(1,len(poly)-1):
                points=np.array([poly[0],poly[k],poly[k+1]])
                xyz=points@basis.T+origin
                normal=np.cross(xyz[1]-xyz[0],xyz[2]-xyz[0]);length=np.linalg.norm(normal)
                if length<1e-12:continue
                normal/=length
                vertices.extend((xyz+normal*.001).tolist());normals.extend([normal.tolist()]*3)
                uv.extend([[.5+p[2]/(2*half[2]),.5+p[1]/(2*half[1])] for p in points])
        assert vertices, f'No surface intersects {name}'
        png=mark['texture']
        raw=(directory/png).read_bytes()
        while len(r.bin)%4:r.bin.append(0)
        offset=len(r.bin);r.bin.extend(raw)
        vi=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(raw)})
        image=len(doc.setdefault('images',[]));doc['images'].append({'name':png,'bufferView':vi,'mimeType':'image/png'})
        tex=len(doc.setdefault('textures',[]));doc['textures'].append({'source':image})
        mat=len(doc['materials']);doc['materials'].append({'name':png[:-4]+'_restored','alphaMode':'BLEND','doubleSided':False,'pbrMetallicRoughness':{'baseColorTexture':{'index':tex},'metallicFactor':0,'roughnessFactor':.6}})
        attrs={'POSITION':add_accessor(doc,r.bin,vertices,kind='VEC3',component=5126,target=34962),'NORMAL':add_accessor(doc,r.bin,normals,kind='VEC3',component=5126,target=34962),'TEXCOORD_0':add_accessor(doc,r.bin,uv,kind='VEC2',component=5126,target=34962)}
        mesh=len(doc['meshes']);doc['meshes'].append({'name':name+'_surface','primitives':[{'attributes':attrs,'material':mat}]})
        node=r.node(name+'_restored',mesh=mesh);doc['scenes'][doc.get('scene',0)]['nodes'].append(node)
        reports.append({'decal':name,'texture':png,'triangles':len(vertices)//3})
    return reports
