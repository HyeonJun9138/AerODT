"""Static PRISM availability and provenance, without importing PyTorch."""
from functools import lru_cache
import hashlib
import importlib.util
import json
from pathlib import Path

MODEL_ID='prism_2d_v1'
DEFAULT_PACKAGE=Path(__file__).resolve().parent
NOTE=('연구용 2D 다중 궤적 예측입니다. 고도 예측과 충돌확률이 아니며 '
      '실제 AeroDT 교통에 대한 정확도와 불확실성 보정은 검증되지 않았습니다.')


@lru_cache(maxsize=8)
def _hash(path,size,modified):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def describe_model(package_dir=None):
    root=Path(package_dir or DEFAULT_PACKAGE)
    result={'model_id':MODEL_ID,'label':'PRISM 주변 교통 예측 (2D)',
            'family':'learned','function':'주변 교통 예측','application':'항공기 · UAM',
            'applies_to':['aircraft','uam'],'jobs':['risk_prediction'],'scope':'5 / 10 / 15초',
            'note':NOTE,'requires':'0.5초 간격 20개 관측 슬롯, 표적 감지 3개 이상',
            'history_steps':20,'step_s':.5,'horizon_seconds':15.,'experimental':True,
            'installed':False,'ready':False,'reason':'PRISM 모델 패키지가 없습니다.'}
    try:
        manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
        path=root/'model.pt';stat=path.stat()
        valid=(manifest['model_id']==MODEL_ID and
               _hash(str(path),stat.st_size,stat.st_mtime_ns)==manifest['weights_sha256'])
        result.update(source_run=manifest['source_run'],weights_sha256=manifest['weights_sha256'],
                      installed=valid,artifact_ready=valid)
        if not valid:
            result['reason']='PRISM 가중치 무결성 검사에 실패했습니다.'
        else:
            result['runtime_ready']=importlib.util.find_spec('torch') is not None
            result['ready']=result['runtime_ready']
            result['reason']='' if result['ready'] else '선택 의존성 PyTorch가 현재 Python 환경에 없습니다.'
    except (OSError,ValueError,KeyError,TypeError,ImportError):
        pass
    return result


describe=describe_model
