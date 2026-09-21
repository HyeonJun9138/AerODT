"""Small independent N/E/D position-velocity covariance updates; no hidden state."""
import math

def axes_at(lat,lon):
    lat=math.radians(lat);lon=math.radians(lon);s,c=math.sin(lat),math.cos(lat);sl,cl=math.sin(lon),math.cos(lon)
    return ((-s*cl,-s*sl,c),(-sl,cl,0),(-c*cl,-c*sl,-s))

def project(vector,axes):return tuple(sum(x*y for x,y in zip(vector,axis)) for axis in axes)
def expand(vector,axes):return tuple(sum(vector[i]*axes[i][j] for i in range(3)) for j in range(3))

def predict(position,velocity,covariance,dt,q):
    dt=max(0.,dt)
    cov=tuple((pp+2*dt*pv+dt*dt*vv+q*dt**3/3,pv+dt*vv+q*dt*dt/2,vv+q*dt) for pp,pv,vv in covariance)
    return tuple(p+v*dt for p,v in zip(position,velocity)),velocity,cov

def correct(position,velocity,covariance,measured,measured_velocity,position_variance,velocity_variance):
    ps=[];vs=[];cs=[]
    for p,v,(pp,pv,vv),z,w,r,t in zip(position,velocity,covariance,measured,measured_velocity,position_variance,velocity_variance):
        innovation=z-p;s=pp+r
        p+=pp/s*innovation;v+=pv/s*innovation
        pp,pv,vv=pp-pp*pp/s,pv-pp*pv/s,vv-pv*pv/s
        innovation=w-v;s=vv+t
        p+=pv/s*innovation;v+=vv/s*innovation
        pp,pv,vv=pp-pv*pv/s,pv-pv*vv/s,vv-vv*vv/s
        pp=max(1e-9,pp);vv=max(1e-9,vv);bound=math.sqrt(pp*vv)*(1-1e-12);pv=max(-bound,min(bound,pv))
        ps.append(p);vs.append(v);cs.append((pp,pv,vv))
    return tuple(ps),tuple(vs),tuple(cs)
