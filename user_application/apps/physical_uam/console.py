"""Local planning over copied project infrastructure; applying never edits Digital."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import hashlib
import json
import math
import re
import threading
import time

from data.simulation.physical_console import PhysicalConsoleFiles
from data.terrain.local_dem import LocalDem
from digital_twin.model_library import flight_schedule,route_network
from digital_twin.model_library.vertiport_layout import validate_definition,generate_layout
from digital_twin.simulation.scenario_engine import ScenarioEngine,Phase,Route
from digital_twin.simulation.decision_policy import validate as validate_policy

KST=timezone(timedelta(hours=9))


def number(value, low, high, label):
    if isinstance(value,bool):raise ValueError(label+' 값이 올바르지 않습니다.')
    try:value=float(value)
    except (ValueError,TypeError):raise ValueError(label+' 숫자가 필요합니다.')
    if not math.isfinite(value) or not low<=value<=high:raise ValueError(f'{label}: {low} ~ {high} 범위입니다.')
    return value


def validate_saved(saved):
    if not isinstance(saved,dict) or saved.get('schema_version')!=1:raise ValueError('해석된 비행계획 JSON schema_version은 1이어야 합니다.')
    saved=deepcopy(saved);flight=saved.get('flight',{})
    if not isinstance(flight,dict):raise ValueError('flight 객체가 필요합니다.')
    for key in ('flight_id','aircraft_id','origin','destination'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',str(flight.get(key,''))):raise ValueError('비행계획 식별자가 올바르지 않습니다: '+key)
    phases=saved.get('phases')
    if not isinstance(phases,list) or not 1<=len(phases)<=32:raise ValueError('비행 구간은 1~32개여야 합니다.')
    stages=set()
    for p in phases:
        if not isinstance(p,dict):raise ValueError('각 비행 구간은 객체여야 합니다.')
        if p.get('stage') not in ('gate_out','takeoff','climb','cruise','descent','landing','gate_in','charge','parked'):raise ValueError('지원하지 않는 비행 단계입니다.')
        stages.add(p['stage'])
        p['duration_s']=number(p.get('duration_s'),0,86400,'구간 시간')
        p['speed_mps']=number(p.get('speed_mps',0),0,100,'계획 속도')
        points=p.get('points')
        if not isinstance(points,list) or not 2<=len(points)<=4096:raise ValueError('구간별 경로점은 2~4096개여야 합니다.')
        normalized=[]
        for point in points:
            if not isinstance(point,(list,tuple)) or len(point)!=3:raise ValueError('경로점은 위도·경도·고도 세 값입니다.')
            normalized.append([number(point[0],-85,85,'위도'),number(point[1],-180,180,'경도'),number(point[2],-500,10000,'고도')])
        p['points']=normalized
        Phase(**p)
    if not {'takeoff','landing'}<=stages:raise ValueError('이륙과 착륙 구간이 필요합니다.')
    if sum(len(p['points'])-1 for p in phases if p['stage'] not in ('gate_out','gate_in','charge','parked'))>1000:
        raise ValueError('공중 경로는 센서 API 계약에 맞게 1,000개 구간 이하여야 합니다.')
    saved['pilot_policy']=validate_policy({'pilot':saved.get('pilot_policy',{})})['pilot']
    for k in ('arrival','departure'):
        if not isinstance(saved.get(k),dict):raise ValueError(k+' 정보가 필요합니다.')
    return saved


def playback_clock(config, flight, now):
    """Scenario clock can be historical; sensor UTC always remains current."""
    day=flight.get('date') or datetime.fromtimestamp(now,KST).date().isoformat()
    try:midnight=datetime.fromisoformat(day).replace(tzinfo=KST).timestamp()
    except ValueError:raise ValueError('비행계획 날짜 형식이 올바르지 않습니다.')
    lift=midnight+float(flight.get('lift_off_s') or flight.get('off_block_s') or 0)
    mode=config.get('time_mode','now')
    if mode=='now':return {'scenario_start':now,'seek_s':0.,'wait_s':0.,'planned_liftoff':lift}
    if mode=='plan':return {'scenario_start':lift,'seek_s':0.,'wait_s':0.,'planned_liftoff':lift}
    if mode!='at':raise ValueError('시작 방식을 선택해 주세요.')
    try:
        chosen=datetime.fromisoformat(config.get('start_at',''))
        if chosen.tzinfo is None:chosen=chosen.replace(tzinfo=KST)
        start=chosen.timestamp()
    except (ValueError,TypeError):raise ValueError('시작 날짜와 시각을 입력해 주세요 (KST).')
    offset=start-lift
    if abs(offset)>86400:raise ValueError('지정 시각은 선택 비행 이륙 시각 전후 24시간 이내여야 합니다.')
    return {'scenario_start':start,'seek_s':max(0.,offset),'wait_s':max(0.,-offset),'planned_liftoff':lift}


class PhysicalConsole:
    def __init__(self, workspace, initial):
        self.files=PhysicalConsoleFiles(workspace);self.lock=threading.RLock();self.initial=validate_saved(initial)
        def read(path,default):
            p=self.files.workspace/path
            return json.loads(p.read_text(encoding='utf-8-sig')) if p.exists() else default
        self.base={'schema_version':1,'name':'원격 프로젝트 환경 사본',
            'vertiports':read('simulation/vertiports.json',{}).get('vertiports',[]),
            'routes':read('simulation/routes.json',{'nodes':[],'links':[]})}
        self.environment=self.files.read('environment',self.base)
        self.policy=read('settings/decisions.json',{'pilot':initial['pilot_policy']})
        self.profile=read('simulation/operating_profile.json',{})
        dem=self.files.workspace/'terrain/user_dem'
        self.dem=LocalDem(dem) if (dem/'manifest.json').exists() else None
        if not self.files.read('plans',[]):
            self.files.import_plan(json.dumps(initial,ensure_ascii=False).encode('utf-8'),'기존 실행 비행.json','json')
            example=self.files.workspace/'simulation/examples/fpl_all.csv'
            if example.exists():self.files.import_plan(example.read_bytes(),'프로젝트 비행계획.csv','csv')
        self.cache={}

    def env(self, environment):
        if not isinstance(environment,dict):raise ValueError('환경 JSON 객체가 필요합니다.')
        ports=environment.get('vertiports');net=environment.get('routes',{})
        if not isinstance(net,dict):raise ValueError('routes 객체가 필요합니다.')
        if not isinstance(ports,list) or not 1<=len(ports)<=100:raise ValueError('버티포트는 1~100곳이어야 합니다.')
        records=[];ids=set()
        for p in ports:
            if not isinstance(p,dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,60}',str(p.get('id',''))) or p['id'] in ids:raise ValueError('버티포트 ID가 없거나 중복됩니다.')
            ids.add(p['id']);d=validate_definition(p);d['id']=p['id'];records.append(dict(d,layout=generate_layout(d)))
        nodes=net.get('nodes',[]);links=net.get('links',[])
        if not isinstance(nodes,list) or not isinstance(links,list):raise ValueError('항로 nodes와 links 배열이 필요합니다.')
        for group in (nodes,links):
            identifiers=set()
            for item in group:
                if not isinstance(item,dict) or not isinstance(item.get('id'),str) or item['id'] in identifiers:raise ValueError('항로 ID가 없거나 중복됩니다.')
                identifiers.add(item['id'])
        if len(nodes)>10000 or len(links)>20000:raise ValueError('항로 규모 한도를 초과했습니다.')
        # Canonical validators also reject NaN and dangling endpoint references.
        valid_nodes=[]
        for p in nodes:
            d=route_network.validate_node(p,[v['name'] for v in valid_nodes]);d['id']=p['id'];valid_nodes.append(d)
        all_nodes={p['id']:p for p in valid_nodes};fatos={p['id']:p for p in route_network.fato_endpoints(records)}
        valid_links=[]
        for p in links:
            d=route_network.validate_link(p,all_nodes,fatos,valid_links);d['id']=p['id'];valid_links.append(d)
        return records,route_network.network(valid_nodes,valid_links,records)

    def catalog(self, identifier):
        item,raw=self.files.plan(identifier)
        key=(identifier,hashlib.sha256(json.dumps(self.environment,sort_keys=True).encode()).hexdigest())
        if key not in self.cache:
            if item['kind']=='json':schedule={'flights':[validate_saved(json.loads(raw))['flight']],'problems':[]}
            else:schedule=flight_schedule.read_schedule(raw,vertiports=self.env(self.environment)[0],name=item['name'])
            self.cache={key:schedule}
        schedule=self.cache[key]
        keys=('flight_id','aircraft_id','origin','destination','origin_name','destination_name','date','off_block_s','lift_off_s','touchdown_s','route_error')
        return {'flights':[{k:f.get(k) for k in keys} for f in schedule['flights']],
                'problems':schedule.get('problems',[])[:8],'kind':item['kind']}

    def describe(self):
        with self.lock:
            return {'plans':self.files.read('plans',[]),'environment':deepcopy(self.environment),
                'settings':self.files.read('settings',{}),'dem_available':self.dem is not None,
                'dem_name':self.dem.manifest.get('name','프로젝트 DEM') if self.dem else None}

    def import_file(self, raw, name, kind):
        with self.lock:
            if kind=='environment':
                value=json.loads(raw);self.env(value)
                self.files.save('environment',value);self.environment=value;self.cache.clear()
                return {'imported':'environment'}
            if kind!='plan':raise ValueError('지원하지 않는 가져오기 종류입니다.')
            file_kind='json' if raw.lstrip(b'\xef\xbb\xbf \r\n\t').startswith(b'{') else 'csv'
            if file_kind=='json':validate_saved(json.loads(raw))
            else:flight_schedule.read_schedule(raw,vertiports=self.env(self.environment)[0])
            return {'plan_id':self.files.import_plan(raw,name,file_kind)}

    def prepare(self, body):
        if not isinstance(body,dict):raise ValueError('운용 설정 객체가 필요합니다.')
        with self.lock:
            config={k:body.get(k) for k in ('plan_id','flight_id','time_mode','start_at')}
            config['time_mode']=config['time_mode'] or 'now'
            config['repeat']=body.get('repeat',True) is True
            config['seed']=int(number(body.get('seed',42),0,2147483647,'잡음 시드'))
            config['terrain']=body.get('terrain','dem' if self.dem else 'flat')
            if config['terrain'] not in ('dem','flat'):raise ValueError('고도 환경을 선택해 주세요.')
            config['flat_height_m']=number(body.get('flat_height_m',0),-100,3000,'평탄 지면 고도')
            config['scope']=body.get('scope','single')
            if config['scope'] not in ('single','fleet'):raise ValueError('전체 운항 또는 단일 시험을 선택해 주세요.')
            environment=deepcopy(body.get('environment') or self.environment)
            item,raw=self.files.plan(config['plan_id'])
            if config['scope']=='fleet':
                from .fleet_plan import prepare_fleet
                return prepare_fleet(self,config,item,raw,environment,time.time())
            if item['kind']=='json':
                saved=validate_saved(json.loads(raw))
                if config['flight_id']!=saved['flight']['flight_id']:raise ValueError('비행 식별자가 맞지 않습니다.')
                note='해석된 JSON은 포함된 항로·고도를 그대로 사용합니다. 환경 변경은 CSV 계획에 적용됩니다.'
            else:
                ports,network=self.env(environment)
                schedule=flight_schedule.read_schedule(raw,vertiports=ports)
                flight=next((f for f in schedule['flights'] if f['flight_id']==config['flight_id']),None)
                if not flight:raise ValueError('실행할 비행을 선택해 주세요.')
                if flight.get('route_error'):raise ValueError(str(flight['route_error']))
                if config['terrain']=='dem' and not self.dem:raise ValueError('가져온 DEM이 없습니다. 평탄 시험환경을 선택해 주세요.')
                elevation=self.dem.sample if config['terrain']=='dem' else lambda lat,lon:config['flat_height_m']
                from user_application.uam_mission.vertiport_operator import VertiportOperators
                engine=ScenarioEngine(dict(schedule,flights=[flight]),vertiports=ports,network=network,
                    elevation=elevation,profile=self.profile,policy=self.policy,provisional_names=('지점 20',),
                    vertiport_operators=VertiportOperators(ports))
                try:
                    route=engine.route(flight)
                    if not route:raise ValueError('선택 비행의 경로를 해석할 수 없습니다.')
                    saved={'schema_version':1,'source':'Physical local plan/environment',
                        'flight':flight,'pilot_policy':engine.policy['pilot'],'departure':route.departure,'arrival':route.arrival,
                        'heading_deg':engine._stand_place(flight['origin'],flight['departure_stand'])[3],
                        'phases':[{'stage':p.stage,'label':p.label,'points':p.points,'duration_s':p.duration_s,'speed_mps':p.speed_mps,'detail':p.detail} for p in route.phases]}
                finally:engine.close()
                saved=validate_saved(saved)
                note='현재 선택한 환경에서 항로·DEM·FATO 고도를 다시 계산했습니다.'
            clock=playback_clock(config,saved['flight'],time.time())
            return {'settings':config,'environment':environment,'saved':saved,'clock':clock,'note':note}

    def commit(self, prepared):
        with self.lock:
            self.files.save('settings',prepared['settings']);self.files.save('environment',prepared['environment'])
            self.files.save('active_flight',prepared.get('saved') or {'scope':'fleet','schedule_id':prepared['schedule']['schedule_id']})
            self.environment=deepcopy(prepared['environment']);self.cache.clear()

    def preview(self,body):
        prepared=self.prepare(body)
        if prepared['settings'].get('scope')!='fleet':return prepared
        selected=self.prepare(dict(body,scope='single'))
        return {'settings':prepared['settings'],'clock':prepared['clock'],'saved':selected['saved'],'note':prepared['note'],
            'fleet':{'aircraft':len(prepared['schedule']['aircraft']),'flights':len(prepared['schedule']['flights']),
                     'window':prepared['schedule']['window'],'problems':prepared['schedule']['problem_count']}}
