"""One connection-owned manual session; native runtime alone owns physical state."""
import math
from pathlib import Path
from digital_twin.contracts.pilot_vehicle import PilotGuidanceGoal, PilotVehicleCommand
from .manual_ground import ManualGround
from .manual_autopilot import ManualAutopilot
from .manual_hold import ManualHold
from data.python.aerodt.data.run_logger import RunLogger

class ManualFlight:
    def __init__(self,plan,origin,runtime,workspace,decks=None,elevation=None,records=()):
        self.plan=plan;self.origin=origin;self.runtime=runtime;self.battery=float(plan['totals']['battery_start_pct']);self.last_time=0;self.low=False
        self.autopilot=ManualAutopilot(plan,origin);self.hold=ManualHold();self.last_elapsed=.05
        self.elevation=elevation;self.position=origin;self.records=tuple(records);self.decks=decks or []
        self.ground=ManualGround(plan,self.records,self.decks,origin,Path(__file__).resolve().parents[2]);self.observation=None;self.command={}
        self.command_sequence=0;self.last_pilot_command=None
        if decks:runtime.surface(origin[2])
        for points,down in decks or []:runtime.deck(points,down)
        self.logger=RunLogger(workspace,'manual_flight',{'plan':plan,'contact_model':'session rendered deck polygons + local terrain; building walls unsupported','deck_count':len(decks or [])})
    def autopilot_request(self,enabled):
        try:
            if not isinstance(enabled,bool):raise ValueError('AP enabled must be boolean')
            if enabled:
                if not getattr(self.runtime,'guidance_writer',None):raise ValueError('서버 재시작 및 AP 엔진 빌드가 필요합니다')
                if self.ground.locked:raise ValueError('지상 작업 중에는 AP를 켤 수 없습니다')
                if max(abs(self.command.get(k,0)) for k in ('pitch','roll','yaw'))>.18:raise ValueError('스틱을 중립으로 놓은 뒤 AP를 켜세요')
                self.autopilot.engage(self.observation)
                # One at a time. The route autopilot flies the plan and a hold
                # stops the aircraft where it is; both write the same stick.
                self.hold.disable('AP 사용 · 유지 해제')
            else:self.autopilot.disable()
            accepted=True;message=self.autopilot.reason
        except ValueError as error:accepted=False;message=str(error)
        if self.observation:self.observation={**self.observation,'autopilot':self.autopilot.snapshot()}
        self.logger.log('manual_autopilot_request','Autopilot',data={'enabled':enabled,'accepted':accepted,'message':message})
        return {'accepted':accepted,'message':message,'sample':self.observation}
    def hold_request(self,mode):
        """Keep this height, keep this spot, or let go of both.

        Separate from the autopilot request because it is a different thing: the
        autopilot flies the plan, a hold stops the aircraft doing something. A
        pilot puts these on a stick button and expects them to answer at once.
        """
        try:
            if not isinstance(mode,str):raise ValueError('유지 모드가 필요합니다')
            if mode=='off':self.hold.disable()
            else:
                self.hold.engage(mode,self.observation,self.command,ground_locked=self.ground.locked)
                if self.autopilot.enabled:self.autopilot.disable('유지 사용 · AP 해제')
            accepted=True;message=self.hold.reason
        except ValueError as error:accepted=False;message=str(error)
        if self.observation:self.observation={**self.observation,'hold':self.hold.snapshot(),'autopilot':self.autopilot.snapshot()}
        self.logger.log('manual_hold_request','유지 요청',data={'mode':mode,'accepted':accepted,'message':message})
        return {'accepted':accepted,'message':message,'sample':self.observation}
    def ground_request(self,action,request_id):
        result=self.ground.request(action,request_id,self.observation,self.command)
        self.logger.log('manual_ground_request','수동 지상 절차 요청',data={'action':action,'request_id':request_id,**result})
        if self.observation:self.observation={**self.observation,'ground_handling':self.ground.snapshot(self.observation,self.command)}
        return {**result,'sample':self.observation}
    def continue_plan(self,plan,advice=None):
        """Keep native pose/energy, but arm guidance and ground work for a new leg."""
        if not self.observation or self.ground.snapshot(self.observation,self.command).get('phase')!='released':
            raise ValueError('지상 절차를 완료하고 문을 닫은 뒤 다음 비행을 준비하세요')
        self.plan=plan
        self.autopilot=ManualAutopilot(plan,self.origin)
        self.hold.disable('다음 비행 준비 · 유지 해제')
        self.ground.next_plan(plan,advice)
        self.observation={**self.observation,
            'passengers':int(plan.get('vehicle',{}).get('passengers') or 0),
            'capacity':int(plan.get('vehicle',{}).get('capacity') or 0),
            'ground_handling':self.ground.snapshot(self.observation,self.command),
            'autopilot':self.autopilot.snapshot(),'hold':self.hold.snapshot(),
            'stage':'gate_out','stage_label':'다음 비행 출발 준비'}
        self.logger.log('manual_next_flight','다음 예정 비행 준비',data={
            'flight_id':(advice or {}).get('flight_id'),'plan':plan})
        return self.observation
    def initialize_grounded(self):
        """Resolve native deck contact before publishing the first operational pose.

        The native contact flag can be unset on its first tick even at rest on
        the deck. Never reinterpret that flag or change the physical position:
        advance bounded neutral ticks and require actual contact confirmation.
        """
        zero={'throttle':0,'roll':0,'pitch':0,'yaw':0,'flight_mode':'multirotor'}
        for steps in (1,25,25,25,25,25):
            sample=self.step(zero,steps,initializing=True)
            if not sample['airborne']:
                return sample
        raise RuntimeError('초기 지상 접촉을 확인하지 못했습니다. 출발 GATE와 데크 높이를 확인하세요')

    def step(self,command,steps,*,initializing=False):
        if self.ground.locked:command={'throttle':0,'roll':0,'pitch':0,'yaw':0,'flight_mode':'multirotor'}
        # What the pilot asked for is kept as it arrived: a hold reads it to
        # know when they have taken the aircraft back, and the ground and
        # autopilot requests read it to know whether the stick is neutral.
        self.command=command
        flown=None if initializing else self.hold.update(self.observation,command,self.last_elapsed)
        if flown is not None:command=flown
        goal=self.autopilot.update(self.observation,command) if self.observation else None
        source='automatic' if goal is not None else 'assisted' if flown is not None else 'manual'
        guidance=PilotGuidanceGoal(*goal) if goal is not None else None
        self.command_sequence+=1
        issued=float((self.observation or {}).get('time_s',self.last_time))
        vehicle=self.plan.get('vehicle',{});flight=self.plan.get('flight',{})
        pilot_command=PilotVehicleCommand(
            command_id=f"{self.logger.run_id}:pilot-command:{self.command_sequence}",
            pilot_id=str(self.plan.get('pilot_id') or vehicle.get('pilot_id') or 'manual-pilot'),
            vehicle_id=str(vehicle.get('id') or vehicle.get('aircraft_id') or 'manual-aircraft'),
            flight_id=flight.get('flight_id') or self.plan.get('flight_id'),
            source=source,sequence=self.command_sequence,issued_at_s=issued,
            expires_at_s=issued+max(.25,float(steps)*.02),
            throttle=command['throttle'],roll=command['roll'],pitch=command['pitch'],
            yaw=command.get('yaw',0),flight_mode=command['flight_mode'],guidance=guidance)
        self.last_pilot_command=pilot_command
        if self.elevation:
            height=self.elevation(self.position[0],self.position[1])
            if isinstance(height,(int,float)) and math.isfinite(height):self.runtime.surface(self.origin[2]-height)
        apply=getattr(self.runtime,'apply_pilot_command',None)
        if apply:s=apply(pilot_command,steps)
        else:
            writer=getattr(self.runtime,'guidance',None)
            if writer:writer(guidance is not None,*(goal or (0,0,0)))
            s=self.runtime.step(command['throttle'],command['roll'],command['pitch'],command['flight_mode']=='fixed_wing',steps,yaw=command.get('yaw',0))
        elapsed=s[0]-self.last_time;self.last_time=s[0];self.last_elapsed=elapsed or self.last_elapsed
        # Disclosure: representative energy estimate, not an aircraft-specific pack model.
        collective=getattr(self.runtime,'collective',lambda:None)()
        energy_throttle=command['throttle'] if collective is None else collective
        self.battery=max(0,self.battery-elapsed*(.01+.035*energy_throttle))
        grounded=bool(s[12])
        lon,lat,alt=self.origin
        sample={'time_s':s[0],'position':{'longitude':lon+s[2]/(6371000*math.cos(math.radians(lat)))*180/math.pi,'latitude':lat+s[1]/6371000*180/math.pi,'altitude_m':alt-s[3]},
            'heading_deg':s[7]%360,'pitch_deg':s[8],'roll_deg':s[9],'tilt_deg':s[10],'rotor_radps':s[11],'speed_mps':math.hypot(*s[4:7]),'velocity_ned_mps':list(s[4:7]),'battery_pct':self.battery,
            'stage':'gate_out' if grounded else 'cruise','mode':'fixed_wing' if s[10]>80 else 'transition' if s[10]>1 else 'multirotor','airborne':not grounded,'passengers':self.plan['vehicle']['passengers'],'capacity':self.plan['vehicle']['capacity'],'remaining_s':0,'done':False,'manual':True,'energy_estimated':True,'stage_label':'지상' if grounded else '수동 비행'}
        sample['autopilot']=self.autopilot.snapshot();sample['hold']=self.hold.snapshot()
        reader=getattr(self.runtime,'collective',None)
        if reader:sample['throttle']=reader()
        reader=getattr(self.runtime,'control_surfaces',None)
        if reader:
            angles=reader()
            if angles is not None:sample['control_surface_deg']=angles
        ground=self.ground.snapshot(sample,command)
        sample['ground_handling']=ground
        if 'passengers_remaining' in ground:sample['passengers']=ground['passengers_remaining']
        if ground['locked']:
            sample['stage']='charge';sample['stage_label']=ground['label'];sample['passengers']=ground['passengers_remaining']
            if ground['phase']=='charging':
                aircraft=self.plan.get('aircraft',{});capacity=float(aircraft.get('battery_capacity_kwh') or 100)
                power=float(aircraft.get('charge_power_kw') or 60)
                self.battery=min(100,self.battery+elapsed*(power/capacity/36+.01));sample['battery_pct']=self.battery
        self.observation=sample
        self.position=[sample['position'][k] for k in ('longitude','latitude','altitude_m')]
        self.logger.log('manual_initialization_sample' if initializing else 'manual_sample',
                        '초기 지상 접촉 확인' if initializing else '수동 비행 상태',
                        data={'pilot_command':pilot_command.as_dict(),'sample':sample})
        if self.battery<=20 and not self.low:self.low=True;self.logger.log('battery_low','배터리 부족 기록 — 강제 추락 없음',level='warning')
        return sample
    def close(self,status='stopped'):
        try:self.runtime.close()
        finally:self.logger.finish(status)
