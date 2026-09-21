"""Real PRISM weights behind the web Python's isolated local worker."""
import pytest
from dataclasses import replace
from fastapi.testclient import TestClient
from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard.risk_model_setup import prediction_python
from test_prism_risk import snapshot


def test_risk_api_runs_actual_weights_without_torch_in_web_process(tmp_path):
    if not prediction_python():pytest.skip('No local PyTorch interpreter')
    app=create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path),'tick_seconds':60},sources=[])
    predictor=app.state.risk_predictor
    try:
        for n in range(20):predictor.observe(snapshot(n*.5))
        state=snapshot(9.5)
        app.state.world.replace(state.entities,state.state_time,())
        # Explicit test-only snapshots above; no lifespan or flight/collector starts.
        client=TestClient(app)
        result=client.get('/api/prediction/risk?entity_id=own').json()
        assert result['status']=='ready',result
        assert len(result['tracks'][0]['prediction']['branches'])==3
        assert len(result['tracks'][0]['prediction']['branches'][0]['points'])==30
        assert result['provenance']['experimental'] is True
        descriptor=client.get('/api/prediction/risk/config').json()
        assert descriptor['model']['execution']=='isolated_local_python'
        assert descriptor['model']['ready'] is True
        disabled=client.put('/api/prediction/risk/config',json={'enabled':False})
        assert disabled.status_code==200
        assert client.get('/api/prediction/risk?entity_id=own').json()['status']=='disabled'
    finally:
        if predictor._model is not None:predictor._model.close()
