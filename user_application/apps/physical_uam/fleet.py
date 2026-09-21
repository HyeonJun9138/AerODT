"""Existing scheduled operations -> per-aircraft synthetic sensor observations."""
import asyncio
from collections import deque
from copy import deepcopy
import hashlib
import math
import time
import uuid
from digital_twin.simulation.physical_sensors import PhysicalSensors
from digital_twin.simulation.scenario_engine import ScenarioEngine,GROUND_PHASES
from user_application.uam_mission.ground_control import VertiportGroundControl
from user_application.uam_mission.vertiport_operator import VertiportOperators
from .fleet_pilots import SensorScenarioPilots
from .fleet_plan import fleet_clock
from data.simulation.physical_operations import PhysicalOperationsRecords
from .operations import configuration,capture_frame


async def worker(call,*args):
    task=asyncio.create_task(asyncio.to_thread(call,*args))
    try:return await asyncio.shield(task)
    except asyncio.CancelledError:await task;raise


class PhysicalFleet:
    def __init__(self,library,packets,model,console,*,physics_workers=None):
        if physics_workers is not None and (isinstance(physics_workers,bool) or not isinstance(physics_workers,int) or not 1<=physics_workers<=8):
            raise ValueError('physics_workers must be between 1 and 8')
        self.physics_workers=physics_workers;self.step_timings=deque(maxlen=120)
        self.library=library;self.packets=packets;self.model=model;self.console=console
        self.process_id=uuid.uuid4().hex;self.started=time.time();self.sequence=0;self.logger=None
        self.commands=asyncio.Queue(maxsize=5);self.engine=None;self.paused=False;self.truth={};self.overview={}
        self.pending=deque();self.active={};self.samplers={};self.missions={};self.last_ground={};self.next_packet={};self.samples={}
        workspace=getattr(getattr(console,'files',None),'workspace',None)
        self.operation_run='';self.operation_records=PhysicalOperationsRecords(workspace/'physical_uam/operations' if workspace else None)
        self.last_operation_frame=-1.;self.last_operation_save=0.
        self.checkpoint_task=None
        self.status={'status':'ready','scope':'fleet','process_id':self.process_id,'started_at':self.started,'console_version':3,
            'flight':{'aircraft_id':'전체 운항','origin_name':'PSU · 버티포트','destination_name':'기체별 조종사'},'error':None,'cycle':0}

    def command(self,action,prepared=None):
        if self.commands.full():return False
        self.commands.put_nowait((action,prepared));return True

    def event(self,kind,data):
        if self.logger:self.logger.log(kind,self.status.get('mission_id',''),data=data)

    def build(self,prepared):
        ports,network=self.console.env(prepared['environment'])
        settings=prepared['settings']
        elevation=self.console.dem.sample if settings['terrain']=='dem' else lambda lat,lon:settings['flat_height_m']
        pilots=SensorScenarioPilots(self.library,workers=self.physics_workers,policy=prepared['policy']['pilot'])
        return ScenarioEngine(deepcopy(prepared['schedule']),vertiports=ports,network=network,elevation=elevation,
            pilots=pilots,profile=prepared['profile'],policy=prepared['policy'],provisional_names=('지점 20',),
            ground_control=VertiportGroundControl(),vertiport_operators=VertiportOperators(ports))

    async def begin(self,prepared):
        if self.engine:
            await self.finish_checkpoint()
            capture_frame(self);await worker(self.operation_records.checkpoint)
            await worker(self.engine.close);self.engine=None
        self.active=deepcopy(prepared);self.status.update(status='preparing',error=None,active_settings=prepared['settings'])
        # Publish ownership inside the worker so cancellation during construction
        # still closes every native pilot in run()'s finally block.
        def initialize():self.engine=self.build(prepared)
        await worker(initialize);self.status['cycle']+=1;self.event_cursor=0
        self.operation_run='physical-'+uuid.uuid4().hex
        self.operation_records.begin(self.operation_run,self.process_id,self.started,configuration(self))
        self.last_operation_frame=-1.;self.last_operation_save=0.
        clock=fleet_clock(prepared['settings'],prepared['schedule'],time.time())
        self.wait_s=clock['wait_s'];self.plan_time=clock['scenario_start']
        self.reconstructed_through_s=self.engine.time_s+clock['seek_s'] if clock['seek_s']>0 else None
        self.engine.pilots.capture=False;advanced=0.
        while advanced+1e-8<clock['seek_s']:
            step=min(1.,clock['seek_s']-advanced)
            await worker(self.engine.advance,self.engine.time_s+step);advanced+=step
            self.operation_records.observe_events(self.engine.events)
            self.status.update(seek_progress=advanced/max(1,clock['seek_s']),elapsed_s=advanced)
            if any(a.failed for a in self.engine.aircraft.values()):raise ValueError('시작 지점 계산 중 조종사 오류가 발생했습니다.')
            if all(a.finished for a in self.engine.aircraft.values()):break
        self.engine.pilots.capture=True;self.engine.pilots.drain()
        self.status['mission_id']=prepared['schedule']['schedule_id']+'-'+uuid.uuid4().hex[:8]
        self.paused=False;self.finished_at=None;self.continuity()
        self.status.update(seek_progress=1.,status='waiting' if self.wait_s else 'running')
        self.update_overview();self.event('fleet_started',{'aircraft':len(self.engine.aircraft),'flights':len(self.engine.flights),'seek_s':advanced})

    def continuity(self):
        self.sensor_epoch=time.time();self.sensor_elapsed=0.;self.anchor=time.monotonic();self.pending.clear()
        self.last_operation_frame=-1.
        if self.finished_at is not None:self.finished_at=0.
        self.samplers={};self.missions={};self.next_packet={};self.samples={};self.last_ground={};self.generated={}
        self.status['mission_started_at']=self.sensor_epoch;self.last_overview=-1.;self.rate_anchor=(self.anchor,self.engine.time_s)

    def sampler(self,a,utc):
        flight_id=a.flight['flight_id'] if a.flight else 'parked'
        if a.aircraft_id not in self.samplers or self.missions[a.aircraft_id]['flight_id']!=flight_id:
            seed=self.active['settings']['seed']+int(hashlib.sha256(a.aircraft_id.encode()).hexdigest()[:8],16)
            self.samplers[a.aircraft_id]=PhysicalSensors(self.model,seed+self.status['cycle'])
            self.missions[a.aircraft_id]={'flight_id':flight_id,'id':a.aircraft_id+'-'+flight_id+'-'+uuid.uuid4().hex[:8],'start':utc,'sequence':0}
            self.samples[a.aircraft_id]=[];self.next_packet[a.aircraft_id]=0.
        return self.samplers[a.aircraft_id]

    def observe(self,a,states,points,hold,start_elapsed,dt):
        for offset,state,phase in states:
            elapsed=start_elapsed+offset;utc=self.sensor_epoch+elapsed
            sensor=self.sampler(a,utc)
            self.samples[a.aircraft_id].extend(sensor.sample(state,elapsed,utc,phase))
            self.generated[a.aircraft_id]=state
        # Parked aircraft report latest observations at 1 Hz; motion reports 10 Hz.
        # Sensors still sample at their model cadence. This is a reporting rate.
        if self.sensor_elapsed+1e-8<self.next_packet.get(a.aircraft_id,0):
            self.samples[a.aircraft_id]=self.samples[a.aircraft_id][-100:];return
        idle=a.phase=='parked';self.next_packet[a.aircraft_id]=self.sensor_elapsed+(1. if idle else .1)
        utc=self.sensor_epoch+self.sensor_elapsed;mission=self.missions[a.aircraft_id];sensor=self.samplers[a.aircraft_id]
        state=self.generated[a.aircraft_id];flight=a.flight or {};self.sequence+=1;mission['sequence']+=1
        remaining=[{'start':p.start,'end':p.end,'speed_mps':p.speed_mps,'phase':p.phase}
                   for p in points[state['route_target_index']:][:1000]] if a.pilot_active else []
        if hold is not None and a.pilot_active:
            remaining=[{'start':[a.latitude,a.longitude,a.altitude],'end':list(hold),'speed_mps':self.engine.policy['pilot']['hold_speed_mps'],'phase':'hold'}]
        ref=flight.get('destination') if a.airborne and a.route and a.index>=a.route.descent_index else flight.get('origin') or a.vertiport
        reference=a.altitude
        if a.airborne and a.route:
            reference=a.route.phases[a.route.landing_index].points[-1][2] if ref==flight.get('destination') else next(p for p in a.route.phases if p.stage=='takeoff').points[0][2]
        packet={'schema_version':1,'message_type':'aerodt.uam.sensor_packet','provenance':'physical_emulation',
            'process_id':self.process_id,'source_started_at':self.started,'sequence':self.sequence,'sent_time':utc,
            'aircraft_id':a.aircraft_id,'aircraft_sequence':mission['sequence'],'name':a.aircraft_id,'visual_asset_id':a.asset_id,
            'operation_run_id':self.operation_run,
            'mission_id':mission['id'],'mission_started_at':mission['start'],
            'flight_elapsed_s':float(a.telemetry.get('physics_time_s',0)) if a.pilot_active else 0.,'plan_time':self.plan_time,
            # Samples are newly constructed immutable observations; the packet
            # log makes the ownership copy once when this packet is published.
            'sensors':dict(sensor.latest),'samples':[] if idle else self.samples[a.aircraft_id][-100:],
            'report_hz':1 if idle else 10,'flight_id':flight.get('flight_id'),
            'intent':{'phase':a.phase,'target_index':int(state['route_target_index']),'waypoints':remaining,'policy':self.engine.policy['pilot']},
            'route':{'origin':flight.get('origin') or a.vertiport,'destination':flight.get('destination') or a.vertiport},
            'surface_reference':{'vertiport_id':ref,'altitude_m':reference},
            'operations':{'instruction':dict(a.instruction),'clearance':a.clearance.as_dict() if a.clearance else None,
                'ground_waiting':bool(a.phase in ('gate_out','gate_in') and a.instruction.get('action')=='ground_wait' and a.speed_mps<.1),
                'gate_assignment':self.engine._gate_assignment(a),'guidance':dict(a.telemetry.get('guidance') or {'available':False}),
                'state_source':'native-airborne' if a.airborne else 'shared-kinematic-ground'}}
        if sensor.random.random()>=.005:self.pending.append((time.monotonic()+max(.01,sensor.random.gauss(.08,.025)),packet))
        self.samples[a.aircraft_id]=[]

    def ground_state(self,a):
        heading=a.heading or 0.;speed=a.speed_mps;yaw=math.radians(heading)
        return dict(latitude_deg=a.latitude,longitude_deg=a.longitude,altitude_m=a.altitude,heading_deg=heading,pitch_deg=0.,roll_deg=0.,
            velocity_ned_mps=[math.cos(yaw)*speed,math.sin(yaw)*speed,-a.climb_mps],tilt_deg=0.,rotor_radps=0.,grounded=True,route_target_index=0)

    async def step(self,dt):
        # One worker owns the whole step. HTTP readers see captured reports,
        # never a partly advanced engine. Sensor work no longer blocks asyncio.
        await worker(self.advance_step,dt)

    def advance_step(self,dt):
        started=time.perf_counter()
        start_elapsed=self.sensor_elapsed;self.sensor_elapsed+=dt;self.plan_time+=dt
        if self.wait_s>0:self.wait_s=max(0.,self.wait_s-dt)
        else:self.engine.advance(self.engine.time_s+dt)
        calculated=time.perf_counter()
        self.operation_records.observe_events(self.engine.events)
        observations=self.engine.pilots.drain()
        for a in self.engine.aircraft.values():
            observed=observations.get(a.aircraft_id)
            if observed:
                native,points,hold=observed
                states=[(offset,s,'hold' if hold is not None else a.route.phases[s['phase_index']].stage if a.route else 'parked') for offset,s in native]
                self.last_ground.pop(a.aircraft_id,None)
            else:
                current=self.ground_state(a);previous=self.last_ground.get(a.aircraft_id,current);self.last_ground[a.aircraft_id]=current
                states=[];offset=min(.02,dt)
                while offset<=dt+1e-8:
                    share=min(1.,offset/dt);s=dict(current)
                    for key in ('latitude_deg','longitude_deg','altitude_m'):s[key]=previous[key]+(current[key]-previous[key])*share
                    s['heading_deg']=(previous['heading_deg']+((current['heading_deg']-previous['heading_deg']+180)%360-180)*share)%360
                    states.append((offset,s,a.phase));offset+=.02
                points=();hold=None
            if states:self.observe(a,states,points,hold,start_elapsed,dt)
        if any(a.failed for a in self.engine.aircraft.values()):
            self.paused=True;self.pending.clear();self.status.update(status='error',error='조종사 오류 · 전체 운항을 일시정지했습니다. 운항 현황의 오류 기체를 확인해 주세요.')
        if all(a.finished for a in self.engine.aircraft.values()) and self.finished_at is None:self.finished_at=self.sensor_elapsed
        self.step_timings.append((calculated-started,time.perf_counter()-calculated))

    async def tick(self):
        self.publish_due()
        now=time.monotonic();wanted=now-self.anchor
        # Do not publish a backlog as fresh measurements after host overload.
        if wanted-self.sensor_elapsed>.5:
            lag=wanted-self.sensor_elapsed
            # Scheduling recovery is not a new flight or a new sensor. Keep
            # identifiers, calibration biases, sequence counters and outages.
            # Old observations retain their timestamps; only future samples
            # move to the current wall clock. Never relabel buffered data.
            wanted=self.sensor_elapsed+.1
            self.anchor=now-wanted;self.sensor_epoch=time.time()-wanted
            # Keep already-created observations and their original timestamps.
            # Only future sample times are rebased; overload is not packet loss.
            self.status['overload_count']=self.status.get('overload_count',0)+1;self.status['last_overload_s']=lag
            self.event('fleet_clock_rebased',{'lag_s':lag,'note':'native state preserved; plan clock progresses only with completed steps'})
        steps=0
        while self.sensor_elapsed+.1<=wanted+1e-8 and not self.paused and steps<2:
            await self.step(.1)
            steps+=1
            if time.monotonic()-now>=.1:break
        now=time.monotonic()
        self.publish_due()
        self.status.update(elapsed_s=self.engine.time_s-self.engine.opens_s,plan_time=self.plan_time,wait_s=self.wait_s,lag_s=max(0,now-self.anchor-self.sensor_elapsed),latest_sequence=self.sequence)
        if not self.paused:self.status['status']='waiting' if self.wait_s else 'landed' if self.finished_at is not None else 'running'
        if self.sensor_elapsed-self.last_overview>=.5:
            await worker(self.update_overview);self.last_overview=self.sensor_elapsed
        if now-self.last_operation_save>=5:
            if self.checkpoint_task is None or self.checkpoint_task.done():
                await self.finish_checkpoint()
                self.checkpoint_task=asyncio.create_task(worker(self.operation_records.checkpoint))
                self.last_operation_save=now
        if self.finished_at is not None and self.active['settings']['repeat'] and self.sensor_elapsed-self.finished_at>=30:
            await self.begin(self.active)

    def publish_due(self):
        now=time.monotonic()
        while self.pending and self.pending[0][0]<=now:
            _,packet=self.pending.popleft()
            self.packets.append(dict(packet,published_time=time.time()))

    async def publish(self):
        # Independent, bounded delivery of completed sensor observations while
        # the native worker advances. Deque append/popleft have single owners.
        try:
            while True:
                self.publish_due()
                await asyncio.sleep(.01)
        except Exception as error:
            self.paused=True;self.status.update(status='error',error=f'Sensor publication failed: {error}')
            self.event('sensor_publication_error',{'message':str(error)})

    async def finish_checkpoint(self):
        if self.checkpoint_task is not None:
            task=self.checkpoint_task;self.checkpoint_task=None
            await task

    def update_overview(self):
        states=self.engine.states();summary=self.engine.summary();ports=[]
        for id,port in self.engine._vertiports.items():
            located=[a for a in states if a['vertiport']==id and not a['airborne']]
            inbound=[a for a in states if a['destination']==id and a['airborne']]
            ports.append({'id':id,'name':port['name'],'ground':len(located),'inbound':len(inbound),'holding':sum(a['holding'] for a in inbound),
                'stands':{stand:owner for (place,stand),owner in self.engine.psu._stands.by_stand.items() if place==id},
                'stand_reservations':{stand:owner for (place,stand),owner in self.engine.psu._stands.reserved.items() if place==id},
                'pads':[{'id':fato,'flight_id':owner} for (place,fato),owner in self.engine._active_pads.items() if place==id]})
        events=[e for e in self.engine.events if e['event_sequence']>self.event_cursor]
        for event in events:self.event('operation',event)
        if events:self.event_cursor=events[-1]['event_sequence']
        elapsed=time.monotonic()-self.rate_anchor[0]
        factor=(self.engine.time_s-self.rate_anchor[1])/elapsed if elapsed>0 and not self.wait_s else 0.
        self.overview={'scope':'fleet','summary':summary,'aircraft':states,'vertiports':ports,'events':self.engine.events[-60:],
            'policy':self.engine.policy,'scenario_id':self.status['mission_id'],'real_time_factor':factor}
        self.truth={'aircraft':[dict(s,provenance='validation_only_ground_truth') for s in states]}
        self.status.update(fleet=summary,real_time_factor=factor,phase=f"공중 {summary['airborne']}대 · 그중 대기 {summary['holding']}대")
        if self.step_timings:
            measured=list(self.step_timings);steps=sorted(sum(x) for x in measured)
            self.status['performance']={'window_steps':len(steps),'target_step_ms':100,
                'step_mean_ms':sum(steps)*1000/len(steps),'step_p95_ms':steps[int(len(steps)*.95)]*1000,
                'calculation_mean_ms':sum(x[0] for x in measured)*1000/len(steps),
                'sensor_mean_ms':sum(x[1] for x in measured)*1000/len(steps),
                'physics_workers':self.engine.pilots.workers,'native_instances':len(self.engine.pilots.flights),
                'pending_packets':len(self.pending),'checkpoint_running':bool(self.checkpoint_task and not self.checkpoint_task.done())}
        if self.sensor_elapsed-self.last_operation_frame>=1 or self.paused:
            capture_frame(self);self.last_operation_frame=self.sensor_elapsed

    async def apply_commands(self):
        while not self.commands.empty():
            action,prepared=self.commands.get_nowait()
            if action in ('start','restart'):await self.begin(prepared or self.active)
            elif action=='pause' and self.engine:self.paused=True;self.pending.clear();self.status['status']='paused'
            elif action=='resume' and self.engine:
                if any(a.failed for a in self.engine.aircraft.values()):raise ValueError('오류가 발생한 운항은 다시 시작해 주세요.')
                self.paused=False;self.continuity();self.status['status']='running'
                if self.finished_at is not None:self.finished_at=0.
            elif action=='gnss_outage':
                for sensor in self.samplers.values():sensor.gnss_outage_until=self.sensor_elapsed+10
            if self.engine and self.operation_records.frame is not None:capture_frame(self)

    async def run(self):
        publisher=asyncio.create_task(self.publish())
        try:
            while True:
                try:
                    await self.apply_commands()
                    if self.engine and not self.paused:await self.tick()
                except asyncio.CancelledError:raise
                except Exception as error:
                    self.paused=True;self.pending.clear();self.status.update(status='error',error=str(error));self.event('fleet_error',{'message':str(error)})
                await asyncio.sleep(.01)
        finally:
            publisher.cancel();await asyncio.gather(publisher,return_exceptions=True)
            try:
                await self.finish_checkpoint()
                if self.engine:
                    if self.status['status']!='error':self.status['status']='stopped'
                    if self.operation_records.configuration is not None:
                        capture_frame(self);await worker(self.operation_records.checkpoint)
            finally:
                if self.engine:await worker(self.engine.close)
