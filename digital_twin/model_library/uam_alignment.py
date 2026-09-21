"""Versioned analytical model definition and bounded operator preferences."""
import json,math
from pathlib import Path
MODEL=json.loads((Path(__file__).parent/'packages/uam_sensor_alignment/v1/model.json').read_text(encoding='utf-8'))
DEFAULTS=MODEL['defaults']
BOUNDS={'coast_seconds':(0,5),'gate_sigma':(3,8),'attitude_seconds':(.02,.5),'max_sigma_m':(3,100),'max_alignment_skew_s':(.05,1)}
def validate(value):
    if not isinstance(value,dict) or set(value)-set(DEFAULTS):raise ValueError('지원하지 않는 정렬 설정입니다.')
    result=dict(DEFAULTS,**value)
    if not isinstance(result['enabled'],bool):raise ValueError('안정화 켜짐 값이 올바르지 않습니다.')
    for key,(low,high) in BOUNDS.items():
        item=result[key]
        if isinstance(item,bool) or not isinstance(item,(int,float)) or not math.isfinite(item) or not low<=item<=high:
            raise ValueError(f'{key}: {low} ~ {high} 범위입니다.')
    return result

