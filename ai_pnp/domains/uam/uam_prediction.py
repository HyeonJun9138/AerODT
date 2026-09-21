"""Future-only comparison results. Inference runs outside the simulation lock."""
from collections import OrderedDict
from copy import deepcopy
import math
from pathlib import Path
import threading

from ai_pnp.domains.uam.uam_features import INPUT_QUALITY, local_to_ecef, route_points
from digital_twin.model_library import uam_prediction_catalog as catalog

COMPARISON_ID = 'uam_route_mlp_comparison'
COLORS = ('#2dd4bf','#fb923c','#c084fc')


class UamPredictionRunner:
    def __init__(self, package_dir=None, *, model_factory=None, availability=None):
        self.package_dir = Path(package_dir or catalog.DEFAULT_PACKAGE)
        self._factory = model_factory
        self._availability = availability or (lambda mid: catalog.find_model(mid,self.package_dir)['ready'])
        self._models = {}
        self._cache = OrderedDict()
        self._lock = threading.Lock()

    def _model(self, model_id):
        if model_id not in self._models:
            factory = self._factory
            if factory is None:
                from ai_pnp.domains.uam.uam_route_model import UamRouteModel
                factory = UamRouteModel
            self._models[model_id] = factory(self.package_dir/model_id)
        return self._models[model_id]

    def predict(self, entity, intent, windows, *, epoch, context, model_id):
        # Serialize the small selected-object workload, not the ASGI or physics loop.
        # Show toggles never change inference inputs; the browser hides individual paths.
        with self._lock:
            key = (entity, intent, epoch, context, model_id)
            if key in self._cache:
                self._cache.move_to_end(key)
                return deepcopy(self._cache[key])
            result = {'schema_version':2,'kind':'uam_prediction_comparison',
                      'entity_id':entity.entity_id,'name':entity.name,'epoch':epoch,
                      'continuity_id':entity.continuity_id,'flight_phase':entity.flight_phase,
                      'generated_at':entity.state_time,'input_quality':INPUT_QUALITY,'predictions':[]}
            for spec,color in zip(catalog.MODELS,COLORS):
                mid=spec['model_id']
                if model_id not in (COMPARISON_ID,mid):
                    continue
                history=windows.get(mid) or {}
                item={'model_id':mid,'label':spec['label'],'horizon_seconds':spec['horizon_s'],
                      'color':color,'status':history.get('status','warming_up'),
                      'reason':history.get('reason','연속 비행 입력 이력을 모으는 중입니다.'),
                      'history_seconds':spec['history_s'],
                      'available_history_seconds':history.get('available_history_seconds',0),'path':None}
                result['predictions'].append(item)
                if intent is None or not intent.waypoints:
                    item.update(status='unavailable',reason='현재 기체에 연결된 활성 임무 경로가 없습니다.')
                    continue
                if not self._availability(mid):
                    item.update(status='unavailable',reason='검증된 모델 패키지가 준비되지 않았습니다.')
                    continue
                if history.get('status')!='ready':
                    continue
                try:
                    rows=[dict(zip(catalog.STATE_COLUMNS,row)) for row in history['rows']]
                    predicted=self._model(mid).predict(rows,route_points(intent),target_point_index=0)
                    times=predicted['times_s'];positions=predicted['prediction_absolute_enu_m']
                    if len(times)!=25 or len(positions)!=25:
                        raise ValueError('model must return 25 future points')
                    points=[[entity.state_time,*entity.position_ecef_m]]
                    for n,(moment,position) in enumerate(zip(times,positions)):
                        dt=moment-rows[-1]['t']
                        if not math.isclose(dt,(n+1)*spec['step_s'],abs_tol=1e-4):
                            raise ValueError('model output time contract mismatch')
                        xyz=local_to_ecef(position)
                        if not all(math.isfinite(value) for value in xyz):
                            raise ValueError('non-finite model output')
                        points.append([entity.state_time+dt,*xyz])
                    item.update(status='ready',reason='',path={
                        'schema_version':1,'kind':'aircraft','reference_frame':'ecef_m','entity_id':entity.entity_id,
                        'epoch':epoch,'continuity_id':entity.continuity_id,'flight_phase':entity.flight_phase,
                        'points':points,'summary':{'seconds':spec['horizon_s'],'model':mid,
                                                 'basis':'learned_route','note':INPUT_QUALITY}})
                except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                    item.update(status='unavailable',reason=f'모델 입력 또는 실행 오류: {type(error).__name__}')
            self._cache[key]=deepcopy(result)
            while len(self._cache)>8:
                self._cache.popitem(last=False)
            return result
