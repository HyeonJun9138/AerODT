"""Small smooth display meshes in the authored cabin frame; no physical bodies."""
import math
from split_rotor_nodes import add_accessor

def mesh(d,b,name,vertices,normals,indices,material):
 p={'attributes':{'POSITION':add_accessor(d,b,vertices,kind='VEC3',component=5126,target=34962),'NORMAL':add_accessor(d,b,normals,kind='VEC3',component=5126,target=34962)},'indices':add_accessor(d,b,[(i,) for i in indices],kind='SCALAR',component=5123,target=34963),'material':material}
 i=len(d['meshes']);d['meshes'].append({'name':name,'primitives':[p]});return i

def rounded_box(d,b,size,radius,material):
 half=[x/2 for x in size];r=min(radius,min(half)*.85);core=[h-r for h in half]
 vertices=[];normals=[];indices=[]
 for axis in range(3):
  u=(axis+1)%3;v=(axis+2)%3
  coordinates=lambda k:[-half[k],-core[k]-r*.707,-core[k],0,core[k],core[k]+r*.707,half[k]]
  for sign in [-1,1]:
   start=len(vertices)
   for a in coordinates(u):
    for c in coordinates(v):
     p=[0,0,0];p[axis]=sign*half[axis];p[u]=a;p[v]=c
     q=[max(-core[k],min(core[k],p[k])) for k in range(3)]
     n=[p[k]-q[k] for k in range(3)];length=math.sqrt(sum(x*x for x in n));n=[x/length for x in n]
     vertices.append([q[k]+r*n[k] for k in range(3)]);normals.append(n)
   for a in range(6):
    for c in range(6):
     i=start+a*7+c;face=[i,i+7,i+8,i,i+8,i+1]
     if sign<0:face=[face[j] for j in [0,2,1,3,5,4]]
     indices.extend(face)
 return mesh(d,b,'Cabin_rounded_shell',vertices,normals,indices,material)

def ellipsoid(d,b,material):
 vertices=[];normals=[];indices=[]
 for row in range(9):
  phi=math.pi*row/8
  for col in range(13):
   theta=2*math.pi*col/12;n=[math.sin(phi)*math.cos(theta),math.cos(phi),math.sin(phi)*math.sin(theta)]
   vertices.append([x*.5 for x in n]);normals.append(n)
 for row in range(8):
  for col in range(12):
   i=row*13+col
   if row:indices.extend([i,i+1,i+13])
   if row<7:indices.extend([i+1,i+14,i+13])
 return mesh(d,b,'Cabin_occupant_soft_form',vertices,normals,indices,material)

def _face(vertices,normals,indices,corners,outward):
 a,b,c=corners[0],corners[1],corners[2]
 u=[b[k]-a[k] for k in range(3)];v=[c[k]-b[k] for k in range(3)]
 n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
 length=math.sqrt(sum(x*x for x in n))
 if length<1e-12:return
 n=[x/length for x in n]
 if sum(n[k]*outward[k] for k in range(3))<0:corners=corners[::-1];n=[-x for x in n]
 start=len(vertices);vertices.extend(corners);normals.extend([n]*4)
 indices.extend([start,start+1,start+2,start,start+2,start+3])

def tapered_deck(d,b,stations,thickness,material):
 """A flat floor whose plan outline follows the body it sits in.

 `stations` is [(z,half_width),...] ordered by z, in the deck's own frame. A
 constant-width slab is the wrong shape for a fuselage: the cabin run is
 chosen for staying near full width, so the body is still tapering at both of
 its ends and a slab cut to the widest station reaches out through the skin
 there."""
 t=thickness/2;vertices=[];normals=[];indices=[]
 for (z0,h0),(z1,h1) in zip(stations,stations[1:]):
  _face(vertices,normals,indices,[[-h0,t,z0],[h0,t,z0],[h1,t,z1],[-h1,t,z1]],[0,1,0])
  _face(vertices,normals,indices,[[-h0,-t,z0],[h0,-t,z0],[h1,-t,z1],[-h1,-t,z1]],[0,-1,0])
  _face(vertices,normals,indices,[[h0,-t,z0],[h0,t,z0],[h1,t,z1],[h1,-t,z1]],[1,0,0])
  _face(vertices,normals,indices,[[-h0,-t,z0],[-h0,t,z0],[-h1,t,z1],[-h1,-t,z1]],[-1,0,0])
 for (z,h),outward in ((stations[0],[0,0,-1]),(stations[-1],[0,0,1])):
  _face(vertices,normals,indices,[[-h,-t,z],[h,-t,z],[h,t,z],[-h,t,z]],outward)
 return mesh(d,b,'Cabin_floor_fitted',vertices,normals,indices,material)
