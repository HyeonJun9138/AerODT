"""Acquisition lifecycle and read-only prediction composition for external UAMs."""
import asyncio
import threading
import time
import httpx
from ai_pnp.domains.uam.uam_features import feature_sample
from communication.external.physical_uam import fetch_packets,validate_packet
from communication.external.physical_polls import PhysicalPolls
from communication.external.physical_clock import PhysicalClock
from data.ingestion.uam_sensor_records import UamSensorRecords
from data.simulation.prediction_history import PredictionHistory
from digital_twin.contracts.live import SourceStatus
from digital_twin.model_library.uam_alignment import validate,MODEL
from digital_twin.live_twin.domains.uam.sensor_fusion import estimate,prediction_intent
from digital_twin.live_twin.domains.uam.sensor_calibration import calibration_detail


class PhysicalInput:
    def __init__(self,url,enabled,simulation_showing,statuses,source_store=None,alignment_store=None,world_snapshot=None):
        self.source_store=source_store;self.generation=0
        if source_store:url=source_store.read(url)
        self.url=url;self.enabled=enabled;self.simulation_showing=simulation_showing;self.statuses=statuses
        self.records=UamSensorRecords();self.history=PredictionHistory(max_entities=128);self.lock=threading.RLock()
        self.alignment_store=alignment_store;self.world_snapshot=world_snapshot
        try:self.alignment=validate(alignment_store.read() if alignment_store else {})
        except ValueError:self.alignment=validate({})
        self.active=False;self.error=None
        self.clock_process=None;self.clock_offset=0.;self.clock_uncertainty=0.;self.telemetry_shards=1
        self.clock_sampled_at=None;self.clock_corrections=0

    def set_source(self,url):
        if self.url!=url:
            if self.source_store:self.source_store.write(url)
            with self.lock:
                self.url=url;self.generation+=1;self.records.clear();self.history.clear()
                self.clock_process=None;self.active=False
                self.status('connecting','Physical 센서 API 변경 · 새 관측 대기')
        return self.describe()

    def status(self,state,message,updated=None):
        self.statuses['physical_uam']=SourceStatus('physical_uam',state,updated,message)

    async def run(self):
        failures=0
        async with httpx.AsyncClient(trust_env=False,follow_redirects=False) as client, PhysicalPolls(client,fetch_packets) as polls, PhysicalClock(client) as clocks:
            while True:
                try:
                    allowed=self.enabled() and not self.simulation_showing()
                    if not self.url or not allowed:
                        await polls.clear()
                        await clocks.clear()
                        if self.active:
                            with self.lock:self.records.clear();self.history.clear()
                        self.active=False
                        self.status('paused' if self.url else 'unavailable',
                            'Simulation 사용 중 · Physical 수신 일시 중지' if self.simulation_showing() else
                            'Physical 수신 꺼짐' if self.url else 'Physical UAM 서버 주소를 설정해 주세요')
                        await asyncio.sleep(.2);continue
                    self.active=True
                    requested=time.time();generation=self.generation;requested_url=self.url
                    body=await polls.read(requested_url,after=self.records.sequence,process=self.records.process,shards=self.telemetry_shards,generation=generation)
                    if generation!=self.generation:continue
                    # Later clock probes run independently of bulk telemetry.
                    # Posterior times share the updated mapping, so a held
                    # GNSS/AHRS sample is never counted as a new observation.
                    if 'server_time' in body:
                        clock=await clocks.read(requested_url,body.get('process_id'),generation)
                        if generation!=self.generation:continue
                        self.clock_offset=clock['offset_s'];self.clock_uncertainty=clock['uncertainty_s']
                        self.clock_sampled_at=clock['sampled_at'];self.clock_corrections=clock['corrections']
                        self.clock_process=body.get('process_id');self.telemetry_shards=clock['telemetry_shards']
                    now=time.time()
                    # An off toggle arriving while HTTP was in flight must not admit that answer.
                    if not self.enabled() or self.simulation_showing():continue
                    with self.lock:
                        missing_before=self.records.missing
                        for packet in body['packets']:
                            try:validate_packet(packet,now-self.clock_offset)
                            except (ValueError,KeyError,TypeError,OverflowError):self.records.rejected+=1;continue
                            if not self.records.register(packet,now,clock_offset_s=self.clock_offset,clock_uncertainty_s=self.clock_uncertainty,unordered=body.get('shards',1)>1):continue
                        self.records.account_coalesced(body.get('coalesced_packets',0),missing_before)
                    latest=self.records.latest_observation_time()
                    fresh=now-latest<=2
                    self.status('ready' if fresh else 'stale','Physical 센서 수신 · GNSS/AHRS/기압 고도 정렬' if fresh else '측정 갱신 지연 · 마지막 관측 유지',latest or None)
                    failures=0;self.error=None
                    await asyncio.sleep(0)
                except asyncio.CancelledError:raise
                except Exception as error:
                    failures+=1;self.error=type(error).__name__
                    self.status('error',f'Physical 연결 실패 · {self.error} · 자동 재연결 중')
                    await asyncio.sleep(min(5,.5*2**min(failures,3)))

    def entities(self,target,previous):
        if not self.active or not self.enabled() or self.simulation_showing():return ()
        old={e.entity_id:e for e in previous};result=[];policy=self.alignment
        with self.lock,self.records.borrow_for_estimation() as records:
            for key,record in records:
                entity=estimate(record,target,old.get(key),policy)
                if entity is None:continue
                result.append(entity)
                # Feature history is past accepted, stabilized World output.
                # A rejected fix or outage is never labeled as a new observation.
                if entity.estimation.mode not in ('filtered','aligned','reacquired'):continue
                # Include the bounded World interpolation between sensor reports,
                # while preserving the actual observation_time on the entity.
                p=record['packet'];intent=prediction_intent(entity,record)
                context=(p['process_id'],p['mission_id'],record['continuity'])
                prior=self.history.latest(key,context)
                elapsed=p.get('flight_elapsed_s',entity.state_time-p['mission_started_at']-record.get('clock_offset_s',0))
                sample=feature_sample(entity,intent,elapsed,prior)
                if sample and intent.waypoints:
                    point=intent.waypoints[0]
                    self.history.append(key,context,entity.state_time,sample,target_key=(intent.target_index,point.start,point.end,point.speed_mps))
        return tuple(result)

    def alignment_status(self):
        entities=[e for e in self.world_snapshot().entities if e.source=='physical_uam' and e.estimation] if self.world_snapshot else []
        counts={}
        for e in entities:counts[e.estimation.mode]=counts.get(e.estimation.mode,0)+1
        return {'model_id':MODEL['model_id'],'label':MODEL['label'],'kind':'analytical','settings':dict(self.alignment),
                'aircraft':len(entities),'modes':counts,'gnss_outliers':sum(e.estimation.gnss_outliers for e in entities),
                'attitude_outliers':sum(e.estimation.attitude_outliers for e in entities),
                'max_horizontal_sigma_m':max((e.estimation.horizontal_sigma_m for e in entities),default=0),
                'note':'원본 센서는 보존합니다. 불확실성이 커지거나 보정 한도를 넘으면 예측을 멈춥니다.'}

    def calibration_example(self):
        from .calibration_example import example
        return example()

    def configure_alignment(self,value):
        settings=validate(value)
        with self.lock:
            if self.alignment_store:self.alignment_store.write(settings)
            self.alignment=settings;self.history.clear()
        return self.alignment_status()

    def current_entities(self):
        return {e.entity_id:e for e in self.world_snapshot().entities if e.source=='physical_uam'} if self.world_snapshot else {}


    def capture(self,entity):
        if not entity or entity.source!='physical_uam' or entity.quality=='stale' or not self.active or not self.enabled() or self.simulation_showing():return None
        if entity.estimation and entity.estimation.mode in ('outlier_rejected','frozen'):return None
        with self.lock:
            record=self.records.read(entity.entity_id)
            if not record or record['continuity']!=entity.continuity_id:return None
            p=record['packet'];intent=prediction_intent(entity,record);context=(p['process_id'],p['mission_id'],record['continuity'])
            end=entity.state_time
            windows={f'uam_route_mlp_{name}':self.history.window(entity.entity_id,context,end,step)
                     for name,step in (('short',.4),('mid',1.2),('long',1.2))}
            return {'entity':entity,'intent':intent,'context':context,'windows':windows}

    def matches(self,captured):
        if not self.active or not self.enabled() or self.simulation_showing():return False
        record=self.records.read(captured['entity'].entity_id)
        if not record:return False
        p=record['packet'];old=captured['intent']
        return ((p['process_id'],p['mission_id'],record['continuity'])==captured['context']
                and p['intent']['target_index']==old.target_index and p['intent']['phase']==old.phase
                and time.time()-(record.get('aligned_sensors',p['sensors']).get('gnss',{}).get('sample_time',0)+record.get('clock_offset_s',0))<=2)

    def describe(self):
        items=[];now=time.time();current=self.current_entities()
        for key,record in self.records.read():
            p=record['packet'];gnss=record.get('aligned_sensors',p['sensors']).get('gnss',{})
            items.append({'entity_id':key,'name':p['aircraft_id'],'route':p.get('route'),
                          'process_id':p['process_id'],'flight_id':p.get('flight_id'),
                          'calibration_profile':gnss.get('calibration_profile','stochastic'),
                          'phase':p['intent']['phase'],'measurement_age_s':max(0,now-gnss.get('sample_time',0)-record.get('clock_offset_s',0)),
                          'packet_age_s':max(0,now-p['sent_time']-record.get('clock_offset_s',0)),'sequence':p['sequence'],
                          'estimation':vars(current[key].estimation) if key in current and current[key].estimation else None})
        source=self.statuses.get('physical_uam')
        return {'enabled':self.enabled(),'receiving':self.active and self.enabled() and not self.simulation_showing(),
                'simulation_suspended':self.simulation_showing(),'status':source.status if source else 'connecting',
                'message':source.message if source else 'Physical 연결 준비','aircraft':items,'telemetry_shards':self.telemetry_shards,
                'counters':self.records.counters(),'provenance':'physical_emulation','server_time':now,'source_url':self.url,'alignment':self.alignment_status(),
                'clock':{'offset_s':self.clock_offset,'uncertainty_s':self.clock_uncertainty,
                         'sampled_at':self.clock_sampled_at,'corrections':self.clock_corrections},
                'operations':self.operation_status() if hasattr(self,'operation_status') else None}

    def detail(self,entity_id):
        record=self.records.read(entity_id)
        if record is None:return None
        p=record['packet'];now=time.time();entity=self.current_entities().get(entity_id)
        corrected=({'latitude_deg':entity.latitude_deg,'longitude_deg':entity.longitude_deg,'altitude_m':entity.altitude_m,
            'heading_deg':entity.heading_deg,'state_time':entity.state_time,'observation_time':entity.observation_time,
            **vars(entity.estimation)} if entity and entity.estimation else None)
        gnss=record.get('aligned_sensors',p['sensors']).get('gnss',{})
        published=p.get('published_time',p['sent_time'])
        pipeline={'sender_age_s':max(0,published-gnss.get('sample_time',p['sent_time'])),
            'transport_s':max(0,record['received_time']-published-record.get('clock_offset_s',0)),
            'receiver_age_s':max(0,now-record['received_time'])}
        return {'entity_id':entity_id,'mission_id':p['mission_id'],'route':p.get('route'),
                'process_id':p['process_id'],'sequence':p['sequence'],'provenance':p['provenance'],
                'sent_time':p['sent_time'],'received_time':record['received_time'],'server_time':now,
                'transport_latency_s':record['received_time']-published-record.get('clock_offset_s',0),
                'clock_offset_s':record.get('clock_offset_s',0),'clock_uncertainty_s':record.get('clock_uncertainty_s',0),
                'sensors':record.get('aligned_sensors',p['sensors']),'raw_sensors':p['sensors'],'sensor_alignment':record.get('sensor_alignment',{}),'intent':p['intent'],'counters':self.records.counters(),
                'operations':p.get('operations'),'flight_id':p.get('flight_id'),'report_hz':p.get('report_hz',10),
                'estimator':MODEL['label']+' · GNSS/기압 정렬 · 이상치 검사 · 위치/속도 공분산 · 자세 안정화',
                'estimation':corrected,'alignment_settings':dict(self.alignment),
                'calibration':calibration_detail(record),
                'display_mode':'buffered_observations' if entity and entity.display_observation else 'estimated',
                'latency_breakdown':pipeline,
                'prediction_note':'센서 기반 연구용 예측 · 잡음이 있는 입력이며 학습 시뮬레이터와 차이가 있습니다.'}

    def track(self,entity_id):
        if not self.active or not self.enabled() or self.simulation_showing():return None
        points=[];previous=None;seen=None;mission=None
        for record in self.records.past(entity_id):
            p=record['packet'];gnss=record.get('aligned_sensors',p['sensors']).get('gnss')
            if not gnss or gnss['sample_time']==seen:continue
            observed=gnss['sample_time']+record.get('clock_offset_s',0)
            current=estimate(record,observed,previous,self.alignment)
            if current is None:continue
            if current.estimation and current.estimation.mode in ('outlier_rejected','frozen'):
                previous=current;seen=gnss['sample_time'];continue
            if current.discontinuity:points=[]
            points.append([current.longitude_deg,current.latitude_deg,current.altitude_m,observed])
            previous=current;seen=gnss['sample_time'];mission=p['mission_id']
        return {'entity_id':entity_id,'flight_id':mission,'flying':bool(previous and previous.flight_phase!='parked'),
                'points':points,'source':'stabilized_sensor_history','note':'최근 40초의 보정된 관측 · 이상치와 긴 누락 구간은 연결하지 않습니다.'}
