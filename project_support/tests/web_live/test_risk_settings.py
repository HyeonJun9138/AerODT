import pytest
from user_application.apps.web_dashboard.library_settings import validate_settings,describe_library,SOURCE_GROUPS

def test_risk_settings_are_separate_from_trajectory_and_validate_limits():
    values=validate_settings({})['sources']
    assert values['risk_prediction']['radius_m']==3000
    assert values['risk_prediction']['model']=='prism_2d_v1'
    assert SOURCE_GROUPS['risk_prediction']=='ai_models'
    for field,value in [('radius_m',float('nan')),('radius_m',10001),('horizon_s',16),('altitude_band_m',-1),('enabled','yes'),('model','constant_velocity_v1')]:
        with pytest.raises(ValueError):validate_settings({'sources':{'risk_prediction':{field:value}}})
    described=describe_library()
    assert any(s['id']=='risk_prediction' for s in described['sources'])
    assert any(j['id']=='risk_prediction' for j in described['ai_models']['jobs'])
