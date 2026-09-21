"""Read-only PRISM future paths. History belongs to Data, never the World copy."""
from collections import OrderedDict
from copy import deepcopy
import math
from pathlib import Path
import threading

import numpy as np

from data.simulation.risk_history import RiskHistory, finite
from digital_twin.model_library.prism_2d import catalog
from digital_twin.model_library.prism_2d.constants import TYPE_NAMES
from digital_twin.model_library.prism_2d.features import build_features

MAX_TRACKS=128
MAX_BATCH=16


def enu_axes(latitude,longitude):
    lat,lon=math.radians(latitude),math.radians(longitude)
    return np.array([[-math.sin(lon),math.cos(lon),0.],
        [-math.sin(lat)*math.cos(lon),-math.sin(lat)*math.sin(lon),math.cos(lat)]])


def valid_position(entity):
    return (finite(entity.latitude_deg) and finite(entity.longitude_deg) and
        len(entity.position_ecef_m)==3 and all(finite(x) for x in entity.position_ecef_m))


def public_position(entity):
    return {'entity_id':entity.entity_id,'latitude_deg':entity.latitude_deg,'longitude_deg':entity.longitude_deg,
            'continuity_id':entity.continuity_id,
            'altitude_m':entity.altitude_m if finite(entity.altitude_m) else None,
            'heading_deg':entity.heading_deg if finite(entity.heading_deg) else None}


def current_valid(entity,moment):
    return (entity.quality not in ('stale','frozen','unavailable','invalid') and
            (entity.valid_until is None or (finite(entity.valid_until) and entity.valid_until>=moment)))


class RiskPredictionRunner:
    def __init__(self,package_dir=None, *, model_factory=None,availability=None):
        self.package_dir=Path(package_dir or catalog.DEFAULT_PACKAGE)
        self.history=RiskHistory()
        self._factory=model_factory
        self._availability=availability or (lambda:catalog.describe_model(self.package_dir)['ready'])
        self._model=None
        self._lock=threading.Lock()
        self._cache=OrderedDict()
        self._cache_epoch=None

    def observe(self,snapshot):
        # No torch import, model lock or inference in the simulation commit path.
        self.history.observe(snapshot)

    def predict_injected(self,snapshot,entity_id,body,**options):
        from dataclasses import replace
        from data.simulation.injected_risk_input import read_injected_tracks
        tracks=read_injected_tracks(body,snapshot,entity_id)
        for entity,rows in tracks:
            for moment,*position in rows:
                self.history.observe_perceived(entity.entity_id,moment,position,10.,epoch=snapshot.epoch,
                    context=('injected',entity_id),basis='injected_test_state')
        picture=replace(snapshot,entities=(*snapshot.entities,*(e for e,_ in tracks)))
        return self.predict(picture,entity_id,**options)

    def predict(self,snapshot,entity_id,radius_m=3000,horizon_s=15,altitude_band_m=150,*,enabled=True):
        if not finite(radius_m) or not 100<=radius_m<=10000:raise ValueError('invalid radius_m')
        if horizon_s not in (5,10,15):raise ValueError('invalid horizon_s')
        if altitude_band_m is not None and (not finite(altitude_band_m) or altitude_band_m<=0):
            raise ValueError('invalid altitude_band_m')
        validity=tuple((e.entity_id,e.continuity_id,e.quality,e.valid_until) for e in snapshot.entities)
        key=(self.history.generation,snapshot.epoch,snapshot.sequence,snapshot.state_time,validity,entity_id,radius_m,horizon_s,altitude_band_m,enabled)
        with self._lock:
            if self._cache_epoch!=snapshot.epoch:
                self._cache.clear();self._cache_epoch=snapshot.epoch
            if key in self._cache:
                self._cache.move_to_end(key);result=deepcopy(self._cache[key])
            else:
                result=self._predict(snapshot,entity_id,radius_m,horizon_s,altitude_band_m,enabled)
                self._cache[key]=deepcopy(result)
            if enabled and result['ownship'] is not None:
                priority=sorted(result['tracks'],key=lambda track:(track['altitude_status']!='inside',track['distance_m']))
                self.history.lease([entity_id]+[track['entity_id'] for track in priority[:MAX_BATCH]],epoch=snapshot.epoch)
            while len(self._cache)>8:self._cache.popitem(last=False)
            return result

    def _predict(self,snapshot,entity_id,radius,horizon,band,enabled):
        own=next((e for e in snapshot.entities if e.entity_id==entity_id),None)
        result={'schema_version':1,'model_id':catalog.MODEL_ID,'status':'unavailable','reason':'선택 기체가 없습니다.',
            'basis':'prism_2d_experimental','epoch':snapshot.epoch,'state_time':snapshot.state_time,
            'ownship_id':entity_id,'radius_m':radius,'horizon_s':horizon,'altitude_band_m':band,
            'ownship':None,'tracks':[],'provenance':{'experimental':True,'note':catalog.NOTE,
                'input_basis':[],'covariance_basis':[],'ownship_covariance':'original_assumed_0.5m_sigma',
                'time_grid':'0.5s slots, first/latest endpoints retained; latest available at or before response time, no interpolation',
                'max_batch':MAX_BATCH,'max_visible_tracks':MAX_TRACKS}}
        if own is None or not valid_position(own):return result
        result['ownship']=public_position(own)
        axes=enu_axes(own.latitude_deg,own.longitude_deg);origin=np.asarray(own.position_ecef_m)
        nearby=[]
        for entity in snapshot.entities:
            if entity.entity_id==entity_id or entity.kind not in ('uam','aircraft','drone','bird','unknown') or not valid_position(entity):continue
            xy=axes@(np.asarray(entity.position_ecef_m)-origin);distance=float(np.linalg.norm(xy))
            if distance>radius:continue
            relative=(entity.altitude_m-own.altitude_m) if finite(entity.altitude_m) and finite(own.altitude_m) else None
            nearby.append((distance,entity,relative))
        nearby.sort(key=lambda v:(v[0],v[1].entity_id));nearby=nearby[:MAX_TRACKS]
        for distance,entity,relative in nearby:
            result['tracks'].append({**public_position(entity),'name':entity.name,
                'distance_m':distance,'relative_altitude_m':relative,
                'altitude_status':'unknown' if relative is None else ('inside' if band is None or abs(relative)<=band else 'outside'),
                'status':'warming_up','reason':'0.5초 관측 이력을 모으는 중입니다.','prediction':None})
        if not enabled:
            return self._state(result,'disabled','주변 교통 예측이 꺼져 있습니다.')
        if not current_valid(own,snapshot.state_time):
            return self._state(result,'unavailable','선택 기체의 현재 상태가 유효하지 않거나 오래되었습니다.')
        if not self._availability():
            return self._state(result,'unavailable','PRISM 모델 또는 실행 환경이 준비되지 않았습니다.')
        if not nearby:
            return self._state(result,'ready','반경 안에 주변 교통이 없습니다.')
        ids=[own.entity_id]+[e.entity_id for _,e,_ in nearby]
        windows=self.history.windows(ids,snapshot.state_time,snapshot.epoch)
        own_rows=windows[own.entity_id]
        if any(row is None for row in own_rows):
            return self._state(result,'warming_up','선택 기체의 연속 관측 20개가 필요합니다. 누락을 보간하지 않습니다.')
        ep=self._episode(own_rows,[windows[e.entity_id] for _,e,_ in nearby],axes,origin)
        selected=[];samples=[]
        order=sorted(range(len(nearby)),key=lambda i:(
            0 if nearby[i][2] is not None and (band is None or abs(nearby[i][2])<=band) else 1,nearby[i][0]))
        for i in order:
            rows=windows[nearby[i][1].entity_id];found=[row for row in rows if row is not None]
            track=result['tracks'][i]
            if not current_valid(nearby[i][1],snapshot.state_time):
                track.update(status='unavailable',reason='현재 표적 상태가 유효하지 않거나 오래되었습니다.');continue
            # A camera sighting is a short-lived track by nature - a bird crossing
            # the view is there for five seconds - so it is predicted from three
            # slots on, with its age carried as the feature it is; every other
            # track still waits for a full window, as the model was validated.
            short_track=bool(found) and found[-1].basis in ('camera_detection_estimate','injected_test_state')
            recent_injection=bool(found) and found[-1].basis=='injected_test_state' and snapshot.state_time-found[-1].time<=1.
            if len(found)<3 or (not short_track and found[-1].age_steps<20) or (rows[-1] is None and not recent_injection):
                if nearby[i][1].source=='intruder':track['reason']=f'주입 시험 관측 {len(found)}/3개 · 서로 다른 0.5초 슬롯과 1초 이내 관측 필요'
                continue
            if len(selected)>=MAX_BATCH:
                track.update(status='unavailable',reason='한 번의 추론은 가까운 교통 최대 16개로 제한합니다.');continue
            samples.append(build_features(ep,19,i,{'max_agents':10}));selected.append(i)
        used=[r for key in ids for r in windows[key] if r is not None]
        result['provenance'].update(input_basis=sorted({r.basis for r in used}),
            covariance_basis=sorted({r.covariance_basis for r in used}),
            detected_counts={key:sum(r is not None for r in windows[key]) for key in ids})
        if not samples:
            status='unavailable' if all(track['status']=='unavailable' for track in result['tracks']) else 'warming_up'
            result.update(status=status,reason='주변 표적의 관측 이력이 아직 부족하거나 오래되었습니다.');return result
        try:
            if self._model is None:
                factory=self._factory
                if factory is None:
                    from ai_pnp.domains.uam.prism_model import PrismModel
                    factory=PrismModel
                self._model=factory(self.package_dir)
            outputs=self._model.predict_batch(samples)
            if len(outputs)!=len(samples):raise ValueError('PRISM batch output mismatch')
            decoded=[self._prediction(out,sample['frame'],horizon) for sample,out in zip(samples,outputs)]
            for i,prediction in zip(selected,decoded):
                result['tracks'][i].update(status='ready',reason='',prediction=prediction)
            result.update(status='ready',reason='')
        except (OSError,ValueError,KeyError,TypeError,RuntimeError,ImportError) as error:
            for i in selected:result['tracks'][i].update(status='unavailable',reason=f'모델 실행 오류: {type(error).__name__}')
            result.update(status='unavailable',reason=f'PRISM 실행 오류: {type(error).__name__}')
        return result

    @staticmethod
    def _state(result,status,reason):
        result.update(status=status,reason=reason)
        for track in result['tracks']:track.update(status=status,reason=reason)
        return result

    @staticmethod
    def _episode(own_rows,tracks,axes,origin):
        n=len(tracks);pos=np.full((20,n,2),np.nan);cov=np.full((20,n,2,2),np.nan)
        det=np.zeros((20,n),bool);age=np.zeros((20,n))
        for i,rows in enumerate(tracks):
            for j,row in enumerate(rows):
                if row is None:continue
                pos[j,i]=axes@(np.asarray(row.position_ecef_m)-origin)
                cov[j,i]=np.eye(2)*row.sigma_m**2;det[j,i]=True;age[j,i]=row.age_steps
        own=np.array([axes@(np.asarray(row.position_ecef_m)-origin) for row in own_rows])
        return {'obs_detected':det,'obs_pos':pos,'obs_R':cov,'obs_track_age':age,'own_pos':own}

    @staticmethod
    def _prediction(out,frame,horizon):
        mu=np.asarray(out['mu'],dtype=float);cov=np.asarray(out['covariance'],dtype=float)
        weights=np.asarray(out['weights'],dtype=float);types=np.asarray(out['type_probabilities'],dtype=float)
        if (mu.shape!=(3,30,2) or cov.shape!=(3,30,2,2) or weights.shape!=(3,) or types.shape!=(7,) or
            not all(np.isfinite(x).all() for x in (mu,cov,weights,types)) or
            np.any(weights<0) or np.any(types<0) or not np.isclose(weights.sum(),1.,atol=1e-5) or
            not np.isclose(types.sum(),1.,atol=1e-5) or not np.allclose(cov,np.swapaxes(cov,-1,-2)) or
            np.linalg.eigvalsh(cov).min()<=0):raise ValueError('invalid PRISM distribution')
        x,y,theta=frame;c,s=math.cos(theta),math.sin(theta)
        rotation=np.array([[c,-s],[s,c]])
        position=mu@rotation.T+np.array([x,y]);global_cov=rotation@cov@rotation.T
        branches=[]
        for k in range(3):
            points=[{'t_s':(j+1)*.5,'east_m':float(position[k,j,0]),'north_m':float(position[k,j,1]),
                     'cov_ee':float(global_cov[k,j,0,0]),'cov_nn':float(global_cov[k,j,1,1]),
                     'cov_en':float(global_cov[k,j,0,1])} for j in range(int(horizon*2))]
            branches.append({'weight':float(weights[k]),'points':points})
        return {'branches':branches,'type_probabilities':[{'type':label,'probability':float(p)} for label,p in zip(TYPE_NAMES,types)]}
