"""Whole-schedule inputs and independent plan/sensor clock mapping."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import math
from digital_twin.model_library import flight_schedule
from digital_twin.simulation import decision_policy

KST=timezone(timedelta(hours=9))


def fleet_clock(config,schedule,now):
    midnight=datetime.fromisoformat(schedule['date']).replace(tzinfo=KST).timestamp()
    start=midnight+schedule['window']['start_s'];mode=config.get('time_mode','now')
    if mode=='now':chosen=now;seek=wait=0.
    elif mode=='plan':chosen=start;seek=wait=0.
    elif mode=='at':
        try:date=datetime.fromisoformat(config.get('start_at') or '')
        except ValueError:raise ValueError('지정할 계획 날짜·시각을 입력해 주세요.')
        if date.tzinfo is None:date=date.replace(tzinfo=KST)
        chosen=date.timestamp();offset=chosen-start
        if not -86400<=offset<=172800:raise ValueError('지정 시각은 계획 시작 전 24시간부터 이후 48시간 이내여야 합니다.')
        seek=max(0.,offset);wait=max(0.,-offset)
    else:raise ValueError('지원하지 않는 시작 방식입니다.')
    return dict(scenario_start=chosen,seek_s=seek,wait_s=wait,planned_start=start)


def prepare_fleet(console,config,item,raw,environment,now):
    if item['kind']!='csv':raise ValueError('전체 운항은 전체 스케줄 CSV를 선택해 주세요. 단일 비행 JSON은 한 기체 시험용입니다.')
    ports,network=console.env(environment)
    schedule=flight_schedule.read_schedule(raw,vertiports=ports,name=item['name'])
    if not schedule['flights']:raise ValueError('실행할 비행계획이 없습니다.')
    if len(schedule['aircraft'])>128:raise ValueError('현재 Physical 전체 운항은 최대 128기체입니다.')
    if config['terrain']=='dem' and not console.dem:raise ValueError('가져온 DEM이 없습니다.')
    clock=fleet_clock(config,schedule,now)
    return {'settings':dict(config,scope='fleet'),'environment':deepcopy(environment),'schedule':schedule,
        'policy':decision_policy.validate(console.policy),'profile':deepcopy(console.profile),'clock':clock,
        'note':f"전체 {len(schedule['aircraft'])}기체 · {len(schedule['flights'])}편을 같은 PSU·버티포트·조종사 로직으로 실행합니다. 선택한 편은 미리보기 대상입니다."}
