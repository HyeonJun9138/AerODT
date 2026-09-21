"""Display-only trailing-edge splits. Do not claim manufacturer hinge geometry."""
import copy
import math
from split_rotor_nodes import read_accessor, add_accessor


def clipped_mesh(r, mesh, primitive, planes, pivot):
    """Partition complete surfaces with interpolated edge vertices, not jagged face masks."""
    d,b=r.doc,r.bin;p=d['meshes'][mesh]['primitives'][primitive]
    attrs={k:read_accessor(d,b,a) for k,a in p['attributes'].items()}
    ix=[v[0] for v in read_accessor(d,b,p['indices'])]
    fixed=[];moving=[]
    def cut(poly,axis,bound,sign):
        yes=[];no=[]
        for a,c in zip(poly,poly[1:]+poly[:1]):
            da=(a['POSITION'][axis]-bound)*sign;dc=(c['POSITION'][axis]-bound)*sign
            (yes if da>=0 else no).append(a)
            if (da>=0)!=(dc>=0):
                t=da/(da-dc);v={k:[x+(y-x)*t for x,y in zip(a[k],c[k])] for k in a}
                yes.append(v);no.append(v)
        return yes,no
    for j in range(0,len(ix),3):
        inside=[{k:list(values[v]) for k,values in attrs.items()} for v in ix[j:j+3]]
        for axis,bound,sign in planes:
            if len(inside)<3:break
            inside,outside=cut(inside,axis,bound,sign)
            if len(outside)>=3:fixed.append(outside)
        if len(inside)>=3:moving.append(inside)
    assert fixed and moving, 'surface region misses mesh or consumes it'
    def pack(polys,origin):
        vertices=[];indices=[];lookup={}
        for poly in polys:
            for j in range(1,len(poly)-1):
                tri=(poly[0],poly[j],poly[j+1]);a,c,e=[v['POSITION'] for v in tri]
                u=[c[k]-a[k] for k in range(3)];v=[e[k]-a[k] for k in range(3)]
                if sum((u[(k+1)%3]*v[(k+2)%3]-u[(k+2)%3]*v[(k+1)%3])**2 for k in range(3))<1e-18:continue
                for v in tri:
                    key=tuple(x for k in attrs for x in v[k])
                    if key not in lookup:lookup[key]=len(vertices);vertices.append(v)
                    indices.append((lookup[key],))
        assert indices
        out={k:copy.deepcopy(v) for k,v in p.items() if k not in ('attributes','indices')};out['attributes']={}
        for k in attrs:
            values=[v[k] for v in vertices]
            if k=='POSITION':values=[[x-origin[a] for a,x in enumerate(v)] for v in values]
            if k=='NORMAL':values=[[x/(math.sqrt(sum(y*y for y in v)) or 1) for x in v] for v in values]
            old=d['accessors'][p['attributes'][k]]
            out['attributes'][k]=add_accessor(d,b,values,kind=old['type'],component=old['componentType'],target=34962)
        out['indices']=add_accessor(d,b,indices,kind='SCALAR',component=5125,target=34963)
        return out
    d['meshes'][mesh]['primitives'][primitive]=pack(fixed,[0,0,0])
    index=len(d['meshes']);d['meshes'].append({'primitives':[pack(moving,pivot)]})
    return index


def register(r,name,mesh,pivot,axis,mix):
    node=r.node(name,mesh=mesh,translation=pivot)
    r.controls.append(dict(name=name,axis=axis,mix=mix,limit_deg=20))
    return node


def x57_controls(r):
    nodes=[]
    for side in [-1,1]:
        pivot=[4,2,side*110]
        mesh=clipped_mesh(r,0,0,[(0,4,1),(0,15,-1),(2,side*65,side),(2,side*175,-side)],pivot)
        nodes.append(register(r,f'X57_aileron_{side}',mesh,pivot,[0,0,1],{'roll':-side}))
        pivot=[185,-17,side*25]
        mesh=clipped_mesh(r,0,0,[(0,185,1),(1,-14,-1),(2,side*6,side)],pivot)
        nodes.append(register(r,f'X57_elevator_{side}',mesh,pivot,[0,0,1],{'pitch':1}))
    pivot=[185,15,0]
    mesh=clipped_mesh(r,0,0,[(0,185,1),(1,-14,1)],pivot)
    nodes.append(register(r,'X57_rudder',mesh,pivot,[0,1,0],{'yaw':1}))
    return nodes


def evtol_controls(r):
    nodes=[]
    for side in [-1,1]:
        pivot=[side*4,-.55,-.5]
        mesh=clipped_mesh(r,0,0,[(0,side*2,side),(1,-.55,1),(1,.1,-1)],pivot)
        nodes.append(register(r,f'EVTOL_aileron_{side}',mesh,pivot,[1,0,0],{'roll':-side}))
        pivot=[side*.5,4.8,-1]
        mesh=clipped_mesh(r,0,0,[(0,side*.04,side),(1,4.8,1)],pivot)
        nodes.append(register(r,f'EVTOL_ruddervator_{side}',mesh,pivot,[1,0,-side*.6],{'pitch':-1,'yaw':side*.7}))
    return nodes
