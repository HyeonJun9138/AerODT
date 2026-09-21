"""Authored display-only terminal and charging equipment, normalized to a unit envelope.

Mesh parts are merged by material, keeping repeated facilities inexpensive. Layout
dimensions/operational footprints remain server-owned. No downloaded textures.
"""
from pathlib import Path
import math,struct,json,hashlib
from collections import defaultdict
from facility_textures import surface
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'digital_twin/model_library/visual_assets/procedural/vertiport_facilities'
MATERIALS=[('limestone',[.58,.565,.52,1],.92,0),('cladding',[.57,.59,.58,1],.48,.38),('anodized',[.16,.185,.20,1],.3,.72),('glass',[.34,.45,.49,.48],.16,.25),('rubber',[.025,.028,.03,1],.93,0),('timber',[.29,.19,.105,1],.86,0),('signal',[.66,.76,.72,1],.35,.2),('screen',[.035,.08,.095,1],.28,.1)]

class Model:
 def __init__(self):self.parts=defaultdict(lambda:[[],[],[],[]])
 def face(self,mat,points,normal):
  v,n,uv,ix=self.parts[mat];i=len(v);v.extend(points);n.extend([normal]*4);uv.extend([[0,0],[1,0],[1,1],[0,1]]);ix.extend([i,i+1,i+2,i,i+2,i+3])
 def box(self,mat,center,size):
  for axis in range(3):
   u=(axis+1)%3;v=(axis+2)%3
   for sign in [-1,1]:
    points=[];normal=[0,0,0];normal[axis]=sign
    for a,b in [(-1,-1),(1,-1),(1,1),(-1,1)]:
     p=list(center);p[axis]+=sign*size[axis]/2;p[u]+=a*size[u]/2;p[v]+=b*size[v]/2;points.append(p)
    if sign<0:points.reverse()
    self.face(mat,points,normal)
 def bevel(self,mat,center,size,r=.018):
  x,y,z=center;w,h,d=[v/2 for v in size];r=min(r,w*.3,d*.3,h*.3)
  ring=[[-w+r,-d],[w-r,-d],[w,-d+r],[w,d-r],[w-r,d],[-w+r,d],[-w,d-r],[-w,-d+r]]
  for a,b in zip(ring,ring[1:]+ring[:1]):
   dx,dz=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dz)
   self.face(mat,[[x+a[0],y-h,z+a[1]],[x+a[0],y+h,z+a[1]],[x+b[0],y+h,z+b[1]],[x+b[0],y-h,z+b[1]]],[dz/length,0,-dx/length])
  for sign in [-1,1]:
   for a,b in zip(ring,ring[1:]+ring[:1]):
    pts=[[x,y+sign*h,z],[x+a[0],y+sign*h,z+a[1]],[x+b[0],y+sign*h,z+b[1]],[x,y+sign*h,z]]
    if sign>0:pts.reverse()
    self.face(mat,pts,[0,sign,0])
 def tube(self,mat,points,radius,sides=8):
  for a,b in zip(points,points[1:]):
   d=[b[i]-a[i] for i in range(3)];length=math.sqrt(sum(x*x for x in d));d=[x/length for x in d]
   helper=[0,1,0] if abs(d[1])<.9 else [1,0,0]
   cross=lambda a,b:[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
   u=cross(d,helper);norm=math.sqrt(sum(x*x for x in u));u=[x/norm for x in u];v=cross(d,u)
   ring=lambda p,t:[p[i]+radius*(u[i]*math.cos(t)+v[i]*math.sin(t)) for i in range(3)]
   for j in range(sides):
    t=j*2*math.pi/sides;s=(j+1)*2*math.pi/sides
    self.face(mat,[ring(a,t),ring(a,s),ring(b,s),ring(b,t)],[u[i]*math.cos((t+s)/2)+v[i]*math.sin((t+s)/2) for i in range(3)])
 def save(self,path):
  doc={'asset':{'version':'2.0','generator':'AeroDT build_vertiport_facilities.py'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':'Facility','mesh':0}],'meshes':[{'primitives':[]}],'materials':[],'buffers':[{}],'bufferViews':[],'accessors':[]};buf=bytearray()
  def append(raw):
   while len(buf)%4:buf.append(0)
   offset=len(buf);buf.extend(raw);i=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(raw)});return i
  def accessor(values,kind,integer=False):
   width={'SCALAR':1,'VEC2':2,'VEC3':3}[kind];flat=values if width==1 else [x for p in values for x in p]
   view=append(struct.pack('<'+('I' if integer else 'f')*len(flat),*flat));doc['bufferViews'][view]['target']=34963 if integer else 34962
   a={'bufferView':view,'componentType':5125 if integer else 5126,'count':len(values),'type':kind}
   if width==3:a.update(min=[min(p[i] for p in values) for i in range(3)],max=[max(p[i] for p in values) for i in range(3)])
   index=len(doc['accessors']);doc['accessors'].append(a);return index
  doc.update(images=[],textures=[],samplers=[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}])
  for name,color,rough,metal in MATERIALS:
   if name not in self.parts:continue
   maps=[]
   for raw in surface(name,color,rough,metal,size=256 if name in ('limestone','timber','screen') else 128):
    index=len(doc['images']);doc['images'].append({'bufferView':append(raw),'mimeType':'image/png'})
    maps.append(len(doc['textures']));doc['textures'].append({'source':index,'sampler':0})
   m={'name':name,'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'baseColorTexture':{'index':maps[0]},'roughnessFactor':1,'metallicFactor':1,'metallicRoughnessTexture':{'index':maps[1]}},'doubleSided':name=='glass'}
   m['normalTexture']={'index':maps[2],'scale':.7};m['occlusionTexture']={'index':maps[1],'strength':.55}
   if name=='glass':m['alphaMode']='BLEND'
   if name=='signal':m['emissiveFactor']=[.04,.055,.05]
   doc['materials'].append(m)
  for name,(v,n,uv,ix) in self.parts.items():doc['meshes'][0]['primitives'].append({'attributes':{'POSITION':accessor(v,'VEC3'),'NORMAL':accessor(n,'VEC3'),'TEXCOORD_0':accessor(uv,'VEC2')},'indices':accessor(ix,'SCALAR',True),'material':[m['name'] for m in doc['materials']].index(name)})
  doc['buffers'][0]['byteLength']=len(buf);raw=json.dumps(doc,separators=(',',':')).encode();raw+=b' '*((-len(raw))%4);buf+=b'\0'*((-len(buf))%4)
  path.write_bytes(struct.pack('<III',0x46546c67,2,28+len(raw)+len(buf))+struct.pack('<II',len(raw),0x4e4f534a)+raw+struct.pack('<II',len(buf),0x004e4942)+buf)
  return {'file':path.name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'triangles':sum(len(p[3])//3 for p in self.parts.values()),'primitives':len(self.parts)}

def terminal():
 m=Model();b=m.box
 b('limestone',[0,-.465,0],[.96,.07,.96]);b('anodized',[0,.39,0],[.94,.035,.94]);m.bevel('cladding',[0,.445,0],[1,.08,1],.03)
 b('rubber',[0,.489,0],[.88,.012,.88])
 # Four load-bearing columns and a deep entrance canopy, inside the reserved envelope.
 for x in [-.435,.435]:
  for z in [-.425,.425]:b('cladding',[x,-.015,z],[.055,.81,.055])
 # Rear glazing and a low stone sill let the interior read from every stand.
 b('limestone',[0,-.345,.40],[.84,.16,.07])
 for x in [-.28,0,.28]:b('glass',[x,.065,.415],[.255,.59,.012])
 for x in [-.42,-.14,.14,.42]:b('anodized',[x,.06,.43],[.018,.64,.03])
 for y in [-.255,.375]:b('anodized',[0,y,.43],[.87,.025,.03])
 # Roof drip edges, ceiling battens and a recessed floor: actual thickness.
 for z in [-.466,.466]:b('anodized',[0,.407,z],[.94,.014,.018])
 for x in [-.34,-.17,0,.17,.34]:b('timber',[x,.359,0],[.04,.015,.78])
 b('limestone',[0,-.419,0],[.82,.012,.82])
 # Side walls contain genuine separated glass panes, recessed behind frame members.
 for x in [-.415,.415]:
  for z in [-.23,.075]:b('glass',[x,.025,z],[.012,.57,.28])
  for z in [-.38,-.08,.23]:b('anodized',[x,.015,z],[.033,.75,.025])
  for y in [-.36,.32]:b('anodized',[x,y,-.075],[.035,.028,.64])
 # Sliding doorway, front transom and sill, set behind the canopy posts.
 for x in [-.27,0,.27]:b('glass',[x,-.02,-.335],[.25,.66,.012])
 for x in [-.405,-.135,.135,.405]:b('anodized',[x,-.02,-.35],[.02,.70,.025])
 for y in [-.37,.33]:b('anodized',[0,y,-.35],[.83,.022,.025])
 for x in [-.11,.11]:b('anodized',[x,-.04,-.368],[.012,.11,.012])
 b('timber',[0,-.225,.25],[.67,.04,.20]);b('timber',[0,-.08,.335],[.67,.27,.035])
 for x in [-.26,.26]:b('anodized',[x,-.34,.25],[.03,.2,.14])
 b('anodized',[.23,.16,.351],[.25,.22,.012]);b('screen',[.23,.16,.343],[.22,.18,.006])
 # Roof ventilation / service details, not glass or a repeated door picture.
 b('cladding',[.19,.455,.21],[.20,.09,.23])
 for i in range(7):b('anodized',[.19,.496,.12+i*.029],[.17,.006,.009])
 for x in [-.29,0,.29]:b('signal',[x,.365,-.405],[.09,.008,.018])
 return m

def charger():
 m=Model();b=m.box
 b('limestone',[0,-.46,0],[.93,.08,.93]);b('anodized',[-.10,-.37,.05],[.59,.1,.59]);m.bevel('cladding',[-.10,.055,.05],[.57,.75,.56],.025);b('anodized',[-.10,.446,.05],[.60,.032,.59])
 # Back service panel, inset fasteners and low casing seam.
 b('rubber',[-.10,.055,.333],[.45,.62,.008]);m.bevel('cladding',[-.10,.055,.34],[.435,.60,.012],.006)
 for x in [-.288,.088]:
  for y in [-.21,.32]:b('anodized',[x,y,.349],[.012,.012,.006])
 # Recessed front instrument area and separate service door, not a logo cube.
 b('anodized',[-.10,.195,-.239],[.44,.33,.018]);b('screen',[-.10,.235,-.253],[.33,.17,.012]);b('signal',[-.10,.345,-.258],[.22,.009,.007])
 b('anodized',[-.10,-.18,-.24],[.44,.30,.018]);b('cladding',[-.10,-.18,-.254],[.39,.26,.012]);b('anodized',[.045,-.16,-.266],[.012,.085,.012])
 for side in [-1,1]:
  x=-.10+side*.289
  for i in range(13):b('anodized',[x,-.17+i*.027,.055],[.012,.01,.36])
 # A cable track at mid-height right round the body (rubber gasket between
 # two anodized lips): the stand cable leaves it on whichever face looks at
 # the stand, and the display draws that cable (charging_cables.js). No loop
 # hangs on the side: a coil scaled to the footprint read as a hose in the air.
 # Proud of the side rails (outer faces at +/-.295 from the body centre), so
 # nothing shares a plane with the band.
 b('rubber',[-.10,0,.05],[.61,.05,.60]);b('anodized',[-.10,.031,.05],[.62,.012,.61]);b('anodized',[-.10,-.031,.05],[.62,.012,.61])
 for x in [-.40,.40]:
  m.tube('anodized',[[x,-.42,-.39],[x,-.13,-.39]],.021,10)
  b('signal',[x,-.16,-.39],[.043,.035,.043])
 return m

if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True);reports=[terminal().save(OUT/'boarding_pavilion.glb'),charger().save(OUT/'charging_station.glb')]
 (OUT/'manifest.json').write_text(json.dumps({'visual_only':True,'bounds':[-.5,.5],'node':'Facility','assets':reports},indent=2)+'\n')
 print(json.dumps(reports))
