"""In-flight route intent only. The existing manual native runtime owns motion."""
import math

def clamp(x,a,b):return max(a,min(b,x))

class ManualAutopilot:
    def __init__(self,plan,origin):
        self.origin=origin;self.segments=[];self.speeds=[];self.enabled=False;self.index=0;self.reason='AP OFF'
        for leg in plan.get('legs',[]):
            if leg.get('stage') not in ('climb','cruise'):continue
            path=leg.get('path') or []
            for a,b in zip(path,path[1:]):
                if not all(len(p)>=3 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in p[:3]) for p in (a,b)):continue
                a,b=self.local(a),self.local(b)
                if math.hypot(b[0]-a[0],b[1]-a[1])>1:
                    self.segments.append((a,b));self.speeds.append(clamp(float(leg.get('speed_mps') or 66.878),28,80))
    def local(self,p):
        lon,lat,alt=self.origin
        return ((p[1]-lat)*math.pi/180*6371000,(p[0]-lon)*math.pi/180*6371000*math.cos(math.radians(lat)),alt-p[2])
    def position(self,s):
        p=s['position'];return self.local((p['longitude'],p['latitude'],p['altitude_m']))
    def projection(self,p,index):
        a,b=self.segments[index];dn,de=b[0]-a[0],b[1]-a[1];length=math.hypot(dn,de)
        u=((p[0]-a[0])*dn+(p[1]-a[1])*de)/(length*length)
        t=clamp(u,0,1);q=tuple(a[k]+(b[k]-a[k])*t for k in range(3))
        return u,q,length
    def disable(self,reason='AP OFF'):
        self.enabled=False;self.reason=reason
    def engage(self,s):
        if not self.segments:raise ValueError('추종할 순항 항로가 없습니다')
        if not s or not s.get('airborne') or s.get('tilt_deg',0)<85 or s.get('speed_mps',0)<28:
            raise ValueError('고정익 순항 중 28 m/s 이상에서 AP를 켜세요')
        p=self.position(s);heading=math.radians(s['heading_deg']);forward=(math.cos(heading),math.sin(heading))
        candidates=[]
        for index,(a,b) in enumerate(self.segments):
            u,q,length=self.projection(p,index)
            alignment=((b[0]-a[0])*forward[0]+(b[1]-a[1])*forward[1])/length
            if u>1 and alignment>0:continue
            distance=math.hypot(p[0]-q[0],p[1]-q[1])
            score=distance**2+(p[2]-q[2])**2+40000*(1-alignment)
            candidates.append((score,index,distance))
        if not candidates:raise ValueError('순항 항로를 이미 통과했습니다 · 수동 접근하세요')
        _,index,distance=min(candidates)
        if distance>2000:raise ValueError('항로 2 km 이내에서 AP를 켜세요')
        self.index=index;self.enabled=True;self.reason='NAV / ALT / SPEED · 계획 추종'
    def update(self,s,command):
        if not self.enabled:return None
        if command.get('flight_mode')!='fixed_wing' or max(abs(command.get(k,0)) for k in ('pitch','roll','yaw'))>.18:
            self.disable('직접 조종 입력 · AP 해제');return None
        if not s.get('airborne') or s.get('speed_mps',0)<25:
            self.disable('저속 또는 지상 · AP 해제');return None
        p=self.position(s)
        while self.index<len(self.segments)-1:
            u,_,_=self.projection(p,self.index)
            if u<1:break
            self.index+=1
        last=self.segments[-1][1]
        if self.index==len(self.segments)-1 and math.hypot(last[0]-p[0],last[1]-p[1])<max(150,s['speed_mps']*8):
            self.disable('접근 구간 · 수동 조종 및 PSU 지시 확인');return None
        u,q,length=self.projection(p,self.index)
        distance=max(100,min(400,s['speed_mps']*4))
        index=self.index;t=clamp(u,0,1)
        while index<len(self.segments):
            a,b=self.segments[index];length=math.hypot(b[0]-a[0],b[1]-a[1]);remaining=length*(1-t)
            if distance<=remaining or index==len(self.segments)-1:
                t=min(1,t+distance/length);target=tuple(a[k]+(b[k]-a[k])*t for k in range(3));break
            distance-=remaining;index+=1;t=0
        heading=math.degrees(math.atan2(target[1]-p[1],target[0]-p[0]))%360
        return heading,target[2],self.speeds[self.index]
    def snapshot(self):
        return {'enabled':self.enabled,'mode':'NAV_ALT_SPEED','autothrottle':True,'target_speed_mps':self.speeds[self.index] if self.enabled else None,'waypoint':self.index+2 if self.enabled else None,'message':self.reason}
