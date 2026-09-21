"""Read-only forecasts of a stored flight at a caller's replay cursor.

No replay clock or current state is registered in World. Future recorded states
are never inference inputs; only the prepared route is known ahead of time.
"""
from dataclasses import asdict
import math
import hashlib
import json
from copy import deepcopy
from digital_twin.simulation.flight_simulation import along_leg
from ai_pnp.domains.uam.uam_features import feature_sample, local_position, local_to_ecef
from ai_pnp.domains.uam.uam_prediction import COMPARISON_ID
from data.simulation.prediction_history import PredictionHistory
from digital_twin.contracts.live import TwinEntity
from digital_twin.contracts.prediction import PredictionWaypoint, UamPredictionIntent
from digital_twin.model_library import uam_prediction_catalog as catalog


def replay_entity(run_id, plan, row, previous=None):
    lat, lon, alt = row['latitude'], row['longitude'], row['altitude_m']
    xyz = local_to_ecef(local_position(lat, lon, alt))
    velocity = None
    if previous and row['t'] > previous['t']:
        before = local_to_ecef(local_position(previous['latitude'], previous['longitude'], previous['altitude_m']))
        velocity = tuple((b-a)/(row['t']-previous['t']) for a,b in zip(before,xyz))
    return TwinEntity(entity_id='replay:'+run_id, name=(plan.get('vehicle') or {}).get('id','UAM'), kind='uam',
        position_ecef_m=xyz, velocity_ecef_mps=velocity, latitude_deg=lat, longitude_deg=lon, altitude_m=alt,
        heading_deg=row.get('heading_deg'), state_time=row['t'], observation_time=row['t'], received_time=row['t'],
        orbit_epoch=None, derivation='simulated', quality='nominal', source='replay', model_id='recorded_flight',
        visual_asset_id=(plan.get('aircraft') or {}).get('asset_id',''), provenance='simulation',
        orientation_source='attitude', pitch_deg=row.get('pitch_deg'), roll_deg=row.get('roll_deg'),
        tilt_deg=row.get('tilt_deg'), rotor_radps=row.get('rotor_radps'), flight_phase=row['stage'])


def replay_intent(entity, plan, row):
    points=[]
    index=int(row.get('leg',0))
    for n,leg in enumerate((plan.get('legs') or [])[index:],index):
        if leg.get('stage') in ('charge','parked'): break
        path=leg.get('path') or []
        pairs=list(zip(path,path[1:]))
        if n==index and pairs:
            pairs=pairs[along_leg(leg,row.get('f',0))['index']:]
        points.extend(PredictionWaypoint((a[1],a[0],a[2]),(b[1],b[0],b[2]),float(leg.get('speed_mps',0)),leg['stage']) for a,b in pairs)
        if leg.get('stage')=='landing': break
    return UamPredictionIntent(entity.entity_id,entity.state_time,entity.entity_id,entity.flight_phase,tuple(points),index)


MANUAL_NOTE = ('수동 비행 관측 이력과 계획 경로를 조건으로 한 예측입니다. '
               '경로 복귀를 가정한 조건부 예측이며 현재 속도의 직선 연장이 아닙니다. 경로 기준 구간은 관측 위치·이동 방향·최근 진행에서 추정하며 조종사의 실제 목표나 향후 입력을 알 수 없습니다.')


def manual_reference(entity, plan, previous=None):
    """A geometric reference for a conditional forecast, NOT pilot active intent."""
    position = local_position(entity.latitude_deg, entity.longitude_deg, entity.altitude_m)
    candidates = []
    # Use actual horizontal motion, not a waypoint-hit radius. A missed WP
    # must not become a target behind an aircraft that has already passed it.
    heading=math.radians(entity.heading_deg or 0)
    east,north=math.sin(heading),math.cos(heading)
    if entity.velocity_ecef_mps is not None:
        lat,lon=math.radians(entity.latitude_deg),math.radians(entity.longitude_deg)
        vx,vy,vz=entity.velocity_ecef_mps
        east=-math.sin(lon)*vx+math.cos(lon)*vy
        north=-math.sin(lat)*math.cos(lon)*vx-math.sin(lat)*math.sin(lon)*vy+math.cos(lat)*vz
    speed=math.hypot(east,north)
    prior=previous.waypoints[0] if previous and previous.waypoints else None
    floor=None
    if prior:
        for i,leg in enumerate(plan.get('legs') or []):
            for j,(a,b) in enumerate(zip(leg.get('path',[]),leg.get('path',[])[1:])):
                if tuple(a[1::-1])+tuple(a[2:3])==prior.start and tuple(b[1::-1])+tuple(b[2:3])==prior.end:
                    floor=(i,j);break
            if floor is not None:break
    for index, leg in enumerate(plan.get('legs') or []):
        if leg.get('stage') in ('charge', 'parked'):
            continue
        path = leg.get('path') or []
        for segment, (a, b) in enumerate(zip(path, path[1:])):
            start, end = local_position(a[1], a[0], a[2]), local_position(b[1], b[0], b[2])
            vector = tuple(y-x for x, y in zip(start, end))
            length = sum(v*v for v in vector)
            if length < 1e-8:
                continue
            if floor is not None and (index,segment)<floor:continue
            horizontal=vector[0]**2+vector[1]**2
            along=(sum((position[k]-start[k])*vector[k] for k in (0,1))/horizontal) if horizontal>1 else 0
            alignment=(east*vector[0]+north*vector[1])/(speed*math.sqrt(horizontal)) if speed>.5 and horizontal>1 else 0
            if along>1.00001 and alignment>0:continue
            fraction = max(0, min(1, sum((p-x)*v for p, x, v in zip(position, start, vector))/length))
            distance = sum((p-(x+fraction*v))**2 for p, x, v in zip(position, start, vector))
            candidates.append((distance+400*(1-alignment), index, segment))
    if not candidates:
        return UamPredictionIntent(entity.entity_id, entity.state_time, entity.entity_id, entity.flight_phase)
    _, index, segment = min(candidates)
    points = []
    for n, leg in enumerate(plan['legs'][index:], index):
        if leg.get('stage') in ('charge', 'parked'):
            break
        path = leg.get('path') or []
        pairs = list(zip(path, path[1:]))[segment if n == index else 0:]
        points.extend(PredictionWaypoint((a[1], a[0], a[2]), (b[1], b[0], b[2]),
                      float(leg.get('speed_mps', 0)), leg.get('stage', 'cruise')) for a, b in pairs)
        if leg.get('stage') == 'landing':
            break
    return UamPredictionIntent(entity.entity_id, entity.state_time, entity.entity_id,
                               entity.flight_phase, tuple(points), index)


class ReplayPrediction:
    def __init__(self,runs,runner,settings,baseline=None,manual_history=None):
        self.runs,self.runner,self.settings,self.baseline=runs,runner,settings,baseline
        self.manual_history=manual_history

    def predict(self,run_id,seconds,epoch=0,heights=None):
        if not math.isfinite(seconds) or seconds<0 or not isinstance(epoch,int) or epoch<0:
            raise ValueError('cursor: invalid replay time or epoch')
        manual=self.manual_history.read(run_id,seconds) if self.manual_history is not None else None
        if manual is not None:
            plan,rows=manual
        else:
            if self.runs.get(run_id) is None:return None
            plan=self.runs.plan(run_id)
            if plan is None:return None
            rows=self.runs.states(run_id,since=max(0,seconds-40),until=seconds)
        # Also defend against an adapter returning rows outside the requested bound.
        rows=sorted((r for r in rows if math.isfinite(r['t']) and r['t']<=seconds),key=lambda r:r['t'])
        if not rows:return {'snapshot':{'epoch':epoch,'state_time':seconds,'entities':[]},'prediction':None}
        height_key=None
        if heights is not None:
            points=[p for leg in plan.get('legs',[]) for p in leg.get('path',[])]
            if (not isinstance(heights,list) or len(heights)!=len(points) or len(heights)>100000
                    or any(not isinstance(h,(int,float)) or not math.isfinite(h) or not -1000<=h<=30000 for h in heights)):
                raise ValueError('heights: expected one finite display altitude per planned point')
            plan=deepcopy(plan);cursor=iter(heights)
            for leg in plan['legs']:
                leg['path']=[[p[0],p[1],next(cursor),*p[3:]] for p in leg.get('path',[])]
            if manual is None:
                rows=[dict(r,altitude_m=along_leg(plan['legs'][int(r['leg'])],r.get('f',0))['altitude_m']+r.get('height_error_m',0)) for r in rows]
            height_key=hashlib.sha256(json.dumps(heights).encode()).hexdigest()
        history=PredictionHistory();previous=None;reference=None;context=(run_id,epoch,height_key)
        for row in rows:
            entity=replay_entity(run_id,plan,row,previous)
            intent=manual_reference(entity,plan,reference) if manual is not None else replay_intent(entity,plan,row)
            reference=intent
            sample=feature_sample(entity,intent,row['t'],history.latest(entity.entity_id,context))
            if sample is not None:
                history.append(entity.entity_id,context,row['t'],sample,target_key=(intent.target_index,intent.waypoints[:1]))
            previous=row
        settings=self.settings();prediction=None
        if settings.get('uam_prediction'):
            model=settings.get('uam_prediction_model')
            if model in (COMPARISON_ID,*catalog.MODEL_IDS):
                windows={spec['model_id']:history.window(entity.entity_id,context,entity.state_time,spec['history_s']/24) for spec in catalog.MODELS}
                prediction=self.runner.predict(entity,intent,windows,epoch=epoch,context=context,model_id=model)
            elif self.baseline:
                path=self.baseline(entity,entity.state_time,intent=intent)
                if path is not None:prediction=dict(path,epoch=epoch)
        if manual is not None and prediction is not None:
            prediction=deepcopy(prediction)
            prediction['input_quality']=MANUAL_NOTE+' '+prediction.get('input_quality','')
            paths=[item.get('path') for item in prediction.get('predictions',[])] if 'predictions' in prediction else [prediction]
            for path in paths:
                if path is not None:
                    summary=path.setdefault('summary',{})
                    summary['note']=MANUAL_NOTE+' '+summary.get('note','')
        return {'snapshot':{'schema_version':1,'epoch':epoch,'state_time':entity.state_time,'entities':[asdict(entity)]},
                'prediction':prediction,'run_id':run_id,'cursor_seconds':seconds}
