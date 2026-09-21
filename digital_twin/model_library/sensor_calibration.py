"""Versioned calibration parameters, with no runtime state or truth source."""
import json
from pathlib import Path

MODEL=json.loads((Path(__file__).parent/'packages/uam_known_bias/v1/model.json').read_text(encoding='utf-8'))
PROFILES=('stochastic',MODEL['model_id'])


def validate_profile(value):
    if value not in PROFILES:raise ValueError('지원하지 않는 센서 오차 규칙입니다.')
    return value
