"""Operator-driven lifecycle around the existing native pilot and sensor sampler."""
import asyncio
from collections import deque
from copy import deepcopy
from dataclasses import asdict
import time
import uuid
from communication.python.native_pilot import tuning_array
from digital_twin.simulation.physical_sensors import PhysicalSensors
from digital_twin.simulation.scenario_engine import Phase,Route
from user_application.uam_mission.scenario_pilots import FlightPilot
from .console import playback_clock


class PhysicalFlight:
    def __init__(self,library,packets,model,initial,*,repeat=True,seed=42,pilot_factory=FlightPilot):
        self.library=library;self.packets=packets;self.model=model;self.factory=pilot_factory
        self.process_id=uuid.uuid4().hex;self.started=time.time();self.sequence=0;self.logger=None
        self.commands=asyncio.Queue(maxsize=5);self.pilot=None;self.truth={};self.paused=False;self.pending=deque()
        self.active={'saved':initial,'settings':{'repeat':repeat,'seed':seed,'time_mode':'now'}}
        self.status={'status':'ready','process_id':self.process_id,'started_at':self.started,
            'clock':'UTC sensor clock / separate plan clock / native 1x','flight':initial['flight'],
            'sensor_model':model,'repeat':repeat,'cycle':0,'error':None,'console_version':2}

    def command(self, action, prepared=None):
        if self.commands.full():return False
        self.commands.put_nowait((action,prepared));return True

    def event(self,kind,data=None):
        if self.logger:self.logger.log(kind,self.status.get('mission_id',''),data=data or {})

    def close_pilot(self):
        if self.pilot:self.pilot.close();self.pilot=None

    async def native(self,seconds):
        task=asyncio.create_task(asyncio.to_thread(self.pilot.advance,seconds))
        try:return await asyncio.shield(task)
        except asyncio.CancelledError:await task;raise

    def continuity(self):
        self.sensor_epoch=time.time();self.sensor_elapsed=0.;self.samples=[];self.next_packet=0.
        self.pending.clear();self.sensors=PhysicalSensors(self.model,self.active['settings']['seed']+self.status['cycle'])
        self.status['mission_id']=self.active['saved']['flight']['flight_id']+'-'+uuid.uuid4().hex[:10]
        self.status['mission_started_at']=self.sensor_epoch

    async def begin(self, prepared):
        self.close_pilot();self.active=deepcopy(prepared);saved=self.active['saved'];config=self.active['settings']
        self.status.update(status='preparing',flight=saved['flight'],error=None,repeat=config['repeat'],active_settings=config)
        self.status['cycle']+=1
        self.route=Route('physical',[Phase(**p) for p in saved['phases']],saved['arrival'],saved['departure'])
        self.pilot=self.factory(self.library,self.route,saved.get('heading_deg'),saved['pilot_policy'],tuning_array(saved['pilot_policy']))
        clock=playback_clock(config,saved['flight'],time.time());self.plan_time=clock['scenario_start'];self.wait_s=clock['wait_s']
        self.state=await self.native(0);advanced=0.
        while advanced+1e-6<clock['seek_s'] and not self.state['done']:
            step=min(2.,clock['seek_s']-advanced);self.state=await self.native(step);advanced+=step
            self.status.update(seek_progress=min(1.,advanced/max(1,clock['seek_s'])),elapsed_s=advanced)
        self.continuity();self.anchor=time.monotonic();self.flight_elapsed=float(self.state['physics_time_s'])
        self.paused=False;self.done_at=0. if self.state['done'] else None
        self.status.update(seek_progress=1.,wait_s=self.wait_s,plan_time=self.plan_time,phase='parked' if self.wait_s else None)
        self.event('flight_started',{'settings':config,'seek_s':clock['seek_s'],'wait_s':self.wait_s})

    async def apply_commands(self):
        while not self.commands.empty():
            action,prepared=self.commands.get_nowait()
            if action in ('start','restart'):await self.begin(prepared or self.active)
            elif action=='stop':
                self.close_pilot();self.pending.clear();self.truth.clear();self.paused=False
                self.status.update(status='stopped',phase=None,lag_s=0.,error=None);self.event('stopped')
            elif action=='pause' and self.pilot and not self.paused:
                self.paused=True;self.pending.clear();self.status['status']='paused';self.event('paused')
            elif action=='resume' and self.pilot and self.paused:
                self.paused=False;self.continuity();self.anchor=time.monotonic();self.status['status']='running';self.event('resumed')
                self.done_at=0. if self.state['done'] else None
            elif action=='gnss_outage' and self.pilot:
                self.sensors.gnss_outage_until=self.sensor_elapsed+10;self.event('gnss_outage',{'seconds':10})

    def emit(self,utc,phase,now):
        saved=self.active['saved'];self.sequence+=1
        arrived=self.state['phase_index']>=self.route.descent_index
        packet={'schema_version':1,'message_type':'aerodt.uam.sensor_packet','provenance':'physical_emulation',
            'process_id':self.process_id,'source_started_at':self.started,'sequence':self.sequence,'sent_time':utc,
            'aircraft_id':saved['flight']['aircraft_id'],'name':saved['flight']['aircraft_id'],
            'visual_asset_id':'projectairsim_airtaxi','mission_id':self.status['mission_id'],'mission_started_at':self.sensor_epoch,
            'flight_elapsed_s':self.flight_elapsed,'plan_time':self.plan_time,
            'sensors':dict(self.sensors.latest),'samples':self.samples,
            'intent':{'phase':phase,'target_index':self.state['route_target_index'],
                'waypoints':[asdict(p) for p in self.pilot.prediction_points[self.state['route_target_index']:]] if not self.state['done'] and self.wait_s<=0 else [],
                'policy':saved['pilot_policy']},'route':{'origin':saved['flight']['origin'],'destination':saved['flight']['destination']},
            'surface_reference':{'vertiport_id':saved['flight']['destination'] if arrived else saved['flight']['origin'],
                'altitude_m':self.route.phases[self.route.landing_index].points[-1][2] if arrived else self.pilot.origin[2]}}
        if self.sensors.random.random()>=.005:self.pending.append((now+max(.01,self.sensors.random.gauss(.08,.025)),packet))
        self.samples=[]

    async def tick(self):
        now=time.monotonic();wanted=now-self.anchor
        if wanted-self.sensor_elapsed>2:
            self.continuity();self.anchor=now;wanted=0.;self.event('clock_rebased')
        while self.sensor_elapsed+.01<=wanted:
            self.sensor_elapsed+=.01;self.plan_time+=.01
            if self.wait_s>0:self.wait_s=max(0,self.wait_s-.01)
            else:self.state=await self.native(.01);self.flight_elapsed=float(self.state['physics_time_s'])
            phase='parked' if self.state['done'] or self.wait_s>0 else self.route.phases[self.state['phase_index']].stage
            utc=self.sensor_epoch+self.sensor_elapsed
            self.truth.clear();self.truth.update(self.state,flight_phase=phase,sample_time=utc)
            self.samples.extend(self.sensors.sample(self.state,self.sensor_elapsed,utc,phase))
            if self.sensor_elapsed+1e-6>=self.next_packet:
                self.next_packet=self.sensor_elapsed+.1;self.emit(utc,phase,now)
            if self.state['done'] and self.done_at is None:
                self.done_at=self.sensor_elapsed;self.event('landed',{'elapsed_s':self.flight_elapsed})
        while self.pending and self.pending[0][0]<=now:
            _,packet=self.pending.popleft();self.packets.append(packet)
        self.status.update(elapsed_s=self.flight_elapsed,stream_elapsed_s=self.sensor_elapsed,
            lag_s=max(0,wanted-self.sensor_elapsed),latest_sequence=self.sequence,phase=self.truth.get('flight_phase'),
            status='waiting' if self.wait_s>0 else 'landed' if self.state['done'] else 'running',
            plan_time=self.plan_time,wait_s=self.wait_s)
        if self.active['settings']['repeat'] and self.done_at is not None and self.sensor_elapsed-self.done_at>=30:
            repeat=deepcopy(self.active);repeat['settings']['time_mode']='plan' if repeat['settings']['time_mode']!='now' else 'now'
            await self.begin(repeat)

    async def run(self):
        try:
            while True:
                try:
                    await self.apply_commands()
                    if self.pilot and not self.paused:await self.tick()
                except asyncio.CancelledError:raise
                except Exception as error:
                    self.close_pilot();self.pending.clear();self.status.update(status='error',error=str(error));self.event('error',{'message':str(error)})
                await asyncio.sleep(.01)
        finally:self.close_pilot()
