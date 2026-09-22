"""Manual turnaround intent, driven exclusively by native sample time/contact.

Owns the passenger/ground procedure, never the aircraft pose. Commands hold
zero propulsion while people/cable are outside. No shared PSU clearance is
invented for a connection-owned manual sandbox.
"""
import copy
import json
import math
from pathlib import Path
from digital_twin.model_library.passenger_boarding import prepare

# How far the aircraft may drift from the stand a procedure began on before that
# procedure is describing somewhere the aircraft is not. `location` admits at
# most four metres to start one, and nothing should move at all while it runs,
# so this is a departure rather than pose jitter.
STRAY_METRES = 8.0
# How long the reason a procedure ended stays on the cockpit's readout.
NOTICE_SECONDS = 12.0


def distance(a, b):
    return math.hypot((a[0]-b[0])*111320*math.cos(math.radians(b[1])), (a[1]-b[1])*111320)


def offset(position, heading, forward, right, height=0):
    h=math.radians(heading);lon,lat,alt=position
    return [lon+(math.sin(h)*forward+math.cos(h)*right)/(111320*math.cos(math.radians(lat))),
            lat+(math.cos(h)*forward-math.sin(h)*right)/111320,alt+height]


class ManualGround:
    def __init__(self,plan,records=(),decks=(),origin=None,workspace=None):
        self.plan=plan;self.records={r['id']:r for r in records if isinstance(r,dict) and 'id' in r}
        self.decks=decks;self.origin=origin;self.operation=None;self.released=False;self.requests={}
        # Why the last procedure ended, so a pilot whose passengers stopped
        # walking is told what happened instead of being left to guess.
        self.notice=None
        self.psu = None;self.next_flight=None;self.remaining_flights=None;self.flight_completed=False
        # Whether the person flying this aircraft is currently standing on the
        # deck rather than in the seat. It lives on the operation rather than
        # here so an aircraft that strays and loses its procedure cannot leave
        # a pilot marked as outside an aircraft that has gone.
        self.door={'forward_m':.3,'right_m':1.1,'height_m':.8}
        asset=plan.get('aircraft',{}).get('asset_id','')
        if workspace and asset and all(c.isalnum() or c=='_' for c in asset):
            path=Path(workspace)/'digital_twin/model_library/visual_assets/aircraft/civilian'/asset/'asset.json'
            if path.is_file():
                meta=json.loads(path.read_text(encoding='utf-8'));door=meta.get('cockpit',{}).get('ground_door')
                if door:self.door=door

    @property
    def locked(self):return self.operation is not None and not self.released
    @property
    def crew_outside(self):
        return bool(self.operation and self.operation.get('crew_out_s') is not None)

    @staticmethod
    def door_fraction(operation, time_s):
        """Current door travel, independent of charging and procedure release."""
        if not operation:return 0.0
        # Old operations created before the independent door contract opened
        # from start_s. Keeping this fallback also makes recorded fixtures read.
        start=operation.get('door_motion_s',operation.get('start_s',time_s))
        source=float(operation.get('door_from',0.0))
        target=float(operation.get('door_target',1.0))
        share=max(0.0,min(1.0,(time_s-start)/2.0))
        return source+(target-source)*share

    def move_door(self, open_, sample):
        op=self.operation;now=sample['time_s']
        op['door_from']=self.door_fraction(op,now)
        op['door_target']=1.0 if open_ else 0.0
        op['door_motion_s']=now

    def sync_psu(self, advice):
        """Use the received stand for ground handling, never change aircraft pose."""
        procedure=(advice or {}).get('procedure') or {}
        self.psu={'reported': 'report_gate' in procedure.get('reports', {})}
        self.next_flight=copy.deepcopy((advice or {}).get('next_flight'))
        self.remaining_flights=(advice or {}).get('remaining_flights')
        self.flight_completed=bool((advice or {}).get('completed'))
        if self.operation or not procedure.get('destination'):
            return
        end={**self.plan.get('arrival',{}),'vertiport':procedure['destination'],
             'gate':procedure.get('arrival_gate'),'fato':procedure.get('arrival_fato')}
        # The stand a pilot is expected on can be re-sequenced under them at any
        # moment, and this used to rewrite the plan without a word. The refusal
        # they then met named the new stand, but nothing said it had changed, so
        # flying to the stand they were briefed on read as the aircraft being
        # wrong rather than the assignment having moved. Stamped on the next
        # snapshot, which is where the clock is.
        before=self.plan.get('arrival',{})
        if before.get('gate') and end.get('gate') and before['gate']!=end['gate']:
            self.notice=(None,'\ubc30\uc815 STAND \ubcc0\uacbd \u00b7 '+str(before['gate'])+' \u2192 '+str(end['gate']))
        self.plan={**self.plan,'arrival':end}

    def next_plan(self, plan, advice=None):
        """Reset only the procedure for a newly assigned roster row."""
        self.plan=plan;self.operation=None;self.released=False;self.requests={};self.notice=None
        self.psu=None;self.next_flight=None;self.remaining_flights=None;self.flight_completed=False
        if advice:self.sync_psu(advice)

    def scheduled(self, state):
        return {**state,'next_flight':copy.deepcopy(self.next_flight),
                'remaining_flights':self.remaining_flights,'flight_completed':self.flight_completed}

    def location(self,sample):
        pos=sample['position'];p=[pos['longitude'],pos['latitude'],pos['altitude_m']]
        end=self.plan.get('arrival',{});record=self.records.get(end.get('vertiport'),{})
        layout=record.get('layout',{});gate=next((g for g in layout.get('gates',[]) if g['id']==end.get('gate')),None)
        if not gate:return None,'도착 GATE 도면 미수신'
        f=layout['frame'];e,n=gate['center_m'];centre=[f['longitude']+e/(111320*math.cos(math.radians(f['latitude']))),f['latitude']+n/111320]
        if distance(p,centre)>min(4,max(2,gate.get('radius_m',6)*.45)):return None,f"{end.get('name') or end.get('vertiport')} {gate['id']} 중심에 정차하세요"
        # Matching horizontal coordinates under a roof are not a deck contact.
        heights=[]
        if self.origin:
            lon,lat,alt=self.origin
            pt=((centre[1]-lat)*math.pi/180*6371000,(centre[0]-lon)*math.pi/180*6371000*math.cos(math.radians(lat)))
            for polygon,down in self.decks:
                inside=False
                for a,b in zip(polygon,polygon[1:]+polygon[:1]):
                    if (a[1]>pt[1])!=(b[1]>pt[1]) and pt[0]<(b[0]-a[0])*(pt[1]-a[1])/(b[1]-a[1])+a[0]:inside=not inside
                if inside:heights.append(alt-down)
        if not heights or min(abs(p[2]-h) for h in heights)>1.5:return None,'도착 버티포트 상면 접촉을 확인하세요'
        return (layout,gate,p),None

    def eligibility(self,sample,command):
        # A finished turnaround must not be the last one of the flight. This
        # tested only whether an operation had ever been made, so once one ran
        # through to `released` every later request was refused - and with
        # `locked` false by then, `ManualFlight` never charged again either. A
        # pilot who completed one turnaround could not start another, or charge,
        # for the rest of the session.
        if self.operation is not None and not self.released:return False,'이미 지상 절차를 진행했습니다'
        if self.psu is not None and not self.psu['reported']:return False,'PSU GATE 도착 보고 접수 후 하차할 수 있습니다'
        if not sample or sample.get('airborne') is not False:return False,'착륙 후 도착 GATE에 정차하세요'
        if sample.get('speed_mps',math.inf)>.15:return False,'기체가 정지한 뒤 하차할 수 있습니다'
        if command.get('throttle',1)>.001 or any(abs(command.get(k,0))>.001 for k in ('roll','pitch','yaw')):return False,'스로틀 0 · 스틱 중립으로 놓으세요'
        if sample.get('rotor_radps',math.inf)>2:return False,'로터가 완전히 멈추기를 기다리세요'
        found,reason=self.location(sample)
        return bool(found),reason or 'GATE 정차 확인 · 하차 가능'

    def request(self,action,request_id,sample,command):
        if not isinstance(request_id,str) or not 1<=len(request_id)<=80:raise ValueError('request_id')
        if request_id in self.requests:return self.requests[request_id]
        if action in ('open_door','reopen'):
            # Door motion is not procedure release. An existing passenger or
            # charging operation stays exactly where it is while the door is
            # opened and closed; in particular opening never recreates people.
            self.snapshot(sample,command)
            if self.operation is None:
                okay,reason=self.eligibility(sample,command)
                if not okay:return self.remember(request_id,False,reason)
                try:operation=self.begin(sample)
                except (ValueError,KeyError,IndexError) as error:return self.remember(request_id,False,'출입문 준비 실패: '+str(error))
                self.operation=operation;self.released=False;self.notice=None
            else:
                if sample.get('airborne') is not False or sample.get('speed_mps',math.inf)>.15 or sample.get('rotor_radps',math.inf)>2:
                    return self.remember(request_id,False,'기체가 GATE에 정지하고 로터가 멈춘 뒤 문을 여세요')
                # Recover old close/release state as well, so a pilot is never
                # left with a dead panel after pressing the door button.
                self.operation.pop('release_s',None)
                self.operation.pop('disconnect_s',None)
                self.released=False;self.notice=None
                self.move_door(True,sample)
            message='문을 엽니다 · 진행 중인 하차와 충전 상태는 유지됩니다'
        elif action=='disembark':
            # Compatibility: an older cockpit can still send one combined
            # request. New cockpits open the door first and send this separately.
            if self.operation is None or self.released:
                okay,reason=self.eligibility(sample,command)
                if not okay:return self.remember(request_id,False,reason)
                try:self.operation=self.begin(sample)
                except (ValueError,KeyError,IndexError) as error:return self.remember(request_id,False,'하차 동선 준비 실패: '+str(error))
                self.released=False;self.notice=None
                start=sample['time_s']+2
            else:
                if self.operation.get('alighting_start_s') is not None:
                    return self.remember(request_id,False,'승객 하차를 이미 요청했습니다')
                state=self.snapshot(sample,command)
                if state['phase']!='door_open':return self.remember(request_id,False,'문이 열린 뒤 승객 하차를 요청하세요')
                start=sample['time_s']
            self.operation['alighting_start_s']=start
            self.operation['alighting_end_s']=start+self.operation['alighting_duration_s']
            message='문을 열고 하차를 시작합니다'
        elif action=='charge':
            state=self.snapshot(sample,command)
            if state['phase']!='awaiting_charge':return self.remember(request_id,False,'문 열기·하차 완료 후 충전을 요청하세요')
            if not self.operation['socket']:return self.remember(request_id,False,'배정 GATE에 충전 시설이 없습니다')
            if sample.get('airborne') is not False or sample.get('speed_mps',math.inf)>.15 or sample.get('rotor_radps',math.inf)>2:
                return self.remember(request_id,False,'정차·로터 정지 후 충전을 요청하세요')
            if command.get('throttle',1)>.001 or any(abs(command.get(k,0))>.001 for k in ('roll','pitch','yaw')):
                return self.remember(request_id,False,'스로틀 0 · 스틱 중립으로 놓으세요')
            if not self.location(sample)[0]:return self.remember(request_id,False,'배정 GATE 상면 정차를 확인하세요')
            op=self.operation;t=sample['time_s']-op['start_s']
            op['charge_requested_s']=sample['time_s'];op['crew_start_s']=t
            op['charge_at_s']=t+op['crew_walk_s']+4
            message='충전 연결 요청 접수 · 직원 이동 후 케이블을 연결합니다'
        elif action=='crew_out':
            # Once the cable is on and the battery is taking it, the aircraft is
            # doing nothing that needs a person in the seat: the stick is
            # already dead (`locked`) for the whole procedure. So this is the
            # one moment it is safe to step out onto the deck.
            state=self.snapshot(sample,command)
            if state['phase'] not in ('charging','complete'):
                return self.remember(request_id,False,'충전이 시작된 뒤 내릴 수 있습니다')
            if self.crew_outside:return self.remember(request_id,False,'이미 기체 밖에 있습니다')
            self.operation['crew_out_s']=sample['time_s']
            message='문으로 내려 데크에 섭니다'
        elif action=='crew_in':
            if not self.crew_outside:return self.remember(request_id,False,'기체 안에 있습니다')
            self.operation.pop('crew_out_s',None)
            message='조종석으로 돌아왔습니다'
        elif action=='close_door':
            self.snapshot(sample,command)
            if not self.operation:return self.remember(request_id,False,'먼저 문을 여세요')
            if self.crew_outside:return self.remember(request_id,False,'조종석으로 돌아온 뒤 문을 닫으세요')
            self.move_door(False,sample)
            message='문을 닫습니다 · 충전 연결과 지상 절차는 유지됩니다'
        elif action=='release':
            state=self.snapshot(sample,command)
            # Closing the door and giving the stick back to an empty seat is how
            # an aircraft leaves without its pilot.
            if self.crew_outside:return self.remember(request_id,False,'조종석으로 돌아온 뒤 해제하세요')
            if state['phase'] not in ('door_open','awaiting_charge','charging','complete'):
                return self.remember(request_id,False,'문이 완전히 열린 상태에서 닫을 수 있습니다')
            self.operation['release_s']=sample['time_s']
            self.operation['disconnect_s']=3 if self.operation['charge_requested_s'] is not None else 0
            message='충전 케이블 분리 · 문 닫기' if self.operation['disconnect_s'] else '문을 닫습니다'
        else:return self.remember(request_id,False,'지원하지 않는 지상 명령')
        return self.remember(request_id,True,message)

    def remember(self,key,accepted,message):
        result={'accepted':accepted,'message':message};self.requests[key]=result
        if len(self.requests)>64:self.requests.pop(next(iter(self.requests)))
        return result

    def begin(self,sample):
        (layout,gate,p),_=self.location(sample);heading=sample['heading_deg'];end=self.plan['arrival']
        count=int(self.plan['vehicle']['passengers']);datum='deck:'+end['vertiport']
        taxi={'path':[[*offset(p,heading,-1,0)[:2],p[2],datum],[*p,datum]]}
        walk=prepare(layout,gate['id'],count,taxi,alighting=True,door=self.door)
        if count and not walk:raise ValueError('탑승 시설 동선 없음')
        f=layout['frame'];point=lambda local:[f['longitude']+local[0]/(111320*math.cos(math.radians(f['latitude']))),f['latitude']+local[1]/111320,p[2]]
        target=walk['path'][-1] if walk else point(gate['center_m'])
        h=math.radians(heading);side=1 if (target[0]-p[0])*math.cos(math.radians(p[1]))*math.cos(h)-(target[1]-p[1])*math.sin(h)>=0 else -1
        door=offset(p,heading,self.door['forward_m'],side*self.door['right_m'])
        if walk:
            walk=copy.deepcopy(walk);walk['path'][0]=door[:2];
            step=offset(door,heading,0,side*1.3)
            walk['path'][1]=step[:2];walk.pop('path_height_offsets_m',None);walk['path_altitudes_m']=[p[2]+self.door['height_m'],p[2]]+[p[2]]*(len(walk['path'])-2);marks=[0.]
            for a,b in zip(walk['path'],walk['path'][1:]):marks.append(marks[-1]+distance(a,b))
            walk['distances_m']=marks;walk['walk_s']=marks[-1]/walk['walk_mps'];walk['duration_s']=max(walk['release_s'])+walk['walk_s']+walk['enter_s']+1
        charger=next((c for c in layout.get('chargers',[]) if c.get('gate')==gate['id']),None)
        socket=point(charger['center_m']) if charger else None
        right=self.door['right_m'];port=offset(p,heading,self.door['forward_m'],side*right,.85)
        walking=distance(socket,port)/.9 if socket else 0
        people_s=walk['duration_s'] if walk else 0
        return {'start_s':sample['time_s'],'position':p,'heading_deg':heading,'vertiport':end['vertiport'],'gate':gate['id'],
                'door_from':0.0,'door_target':1.0,'door_motion_s':sample['time_s'],
                'walk':walk,'door_side':side,'door':door,'crew_path':[socket,port] if socket else None,'crew_walk_s':walking,
                'alighting_start_s':None,'alighting_end_s':None,'alighting_duration_s':people_s,'charge_requested_s':None,
                'crew_start_s':2+people_s,'charge_at_s':2+people_s+(walking+4 if socket else 0),'socket':socket,'charger_id':charger['id'] if charger else None}

    def strayed(self,sample):
        """Has the aircraft left the stand the running procedure was anchored to?"""
        if not self.operation:return False
        pos=(sample or {}).get('position') or {}
        if pos.get('latitude') is None or pos.get('longitude') is None:return False
        here=[pos['longitude'],pos['latitude'],pos.get('altitude_m') or 0]
        return distance(here,self.operation['position'])>STRAY_METRES

    def snapshot(self,sample,command):
        # The walk, the cable run and the open door are all drawn from the pose
        # the procedure began at, and nothing read the aircraft again afterwards.
        # Flown away mid-turnaround, the passengers went on walking to an empty
        # stand, the crew went on carrying a cable to a socket no longer beside
        # anything, and the battery went on charging three hundred metres from
        # it - none of which the pilot was told. A procedure whose aircraft has
        # gone ends, and says why.
        if self.operation is not None and self.operation.get('release_s') is None and self.strayed(sample):
            self.operation=None;self.released=False
            self.notice=((sample or {}).get('time_s',0),
                         'GATE를 벗어나 지상 절차를 중단했습니다 · 다시 정차한 뒤 요청하세요')
        # A notice raised where there was no clock (sync_psu) is stamped here.
        if self.notice and self.notice[0] is None:
            self.notice=((sample or {}).get('time_s',0),self.notice[1])
        available,reason=self.eligibility(sample,command)
        if not self.operation:
            recent=bool(self.notice) and abs((sample or {}).get('time_s',0)-self.notice[0])<NOTICE_SECONDS
            return self.scheduled({'phase':'idle','available':available,'reason':self.notice[1] if recent else reason,'locked':False})
        op=self.operation;t=max(0,sample['time_s']-op['start_s']);release=op.get('release_s')
        alighting_start=op.get('alighting_start_s')
        alighting_end=op.get('alighting_end_s')
        door_open=self.door_fraction(op,sample['time_s'])
        door_target=op.get('door_target',1.0)
        moving=abs(door_open-door_target)>1e-6
        door_state=('opening' if door_target>door_open else 'closing') if moving else ('open' if door_open>=.999 else 'closed')
        door_phase='opening' if door_state=='opening' else 'closing' if door_state=='closing' else 'door_open' if door_state=='open' else 'door_closed'
        if alighting_start is None:phase=door_phase
        elif sample['time_s']<alighting_start:phase=door_phase
        elif sample['time_s']<alighting_end:phase='alighting'
        elif op['charge_requested_s'] is None:phase='awaiting_charge' if op['socket'] else 'complete'
        elif t<op['charge_at_s']:phase='connecting'
        else:phase='charging'
        if release is not None:
            dt=sample['time_s']-release;delay=op['disconnect_s']
            phase='disconnecting' if dt<delay else 'closing' if dt<delay+2 else 'released'
            self.released=phase=='released'
        if release is not None:
            # Legacy explicit release owns its own disconnect-then-close
            # animation. New close_door never comes through this path.
            door_open=max(0,1-max(0,sample['time_s']-release-op['disconnect_s'])/2)
            door_state='open' if sample['time_s']-release<op['disconnect_s'] else 'closing' if door_open>0 else 'closed'
        labels={'opening':'문 여는 중','door_open':'문 열림 · 승객 하차 요청 대기','door_closed':'문 닫힘 · 다시 열어 하차할 수 있습니다','alighting':'승객 하차 · 시설로 이동','awaiting_charge':'하차 완료 · 충전 연결 요청을 기다립니다','connecting':'지상 직원 · 케이블 운반 / 연결','charging':'충전 중','complete':'하차 완료 · 충전 시설 없음','disconnecting':'충전 케이블 분리 중','closing':'문 닫는 중','released':'지상 절차 완료'}
        outside=self.crew_outside
        alighting_done=alighting_start is not None and sample['time_s']>=alighting_end
        return self.scheduled({**op,'crew_path':op['crew_path'] if op['charge_requested_s'] is not None else None,
                'elapsed_s':t,'phase':phase,'label':('데크에 내려 있음 · '+labels[phase]) if outside else labels[phase],
                'crew_outside':outside,'crew_can_leave':phase in ('charging','complete') and not outside,
                'reopen_allowed':phase=='released','door_control_available':True,'door_state':door_state,
                'alight_allowed':phase=='door_open','alighting_done':alighting_done,
                'turnaround_complete':door_state=='closed' and alighting_done,
                # Where a person steps down to, in the aircraft's own frame. The
                # door offsets are the ones read from the airframe's metadata.
                'crew_door_m':dict(self.door),
                'available':False,'locked':self.locked,'door_open':door_open,
                'passengers_remaining':sum(sample['time_s']-alighting_start<r for r in op['walk']['release_s']) if op['walk'] and alighting_start is not None else int(self.plan['vehicle']['passengers'])})
