import sys
import pytest
from communication.prediction_process import PredictionProcess

def test_json_worker_is_lazy_reused_and_closed_without_shell(tmp_path):
    code='import sys,json\nfor line in sys.stdin:\n print(json.dumps({"result":json.loads(line)}),flush=True)'
    worker=PredictionProcess([sys.executable,'-u','-c',code],cwd=tmp_path,timeout=2)
    assert worker.process is None
    assert worker.request({'x':[1,2]})=={'x':[1,2]}
    pid=worker.process.pid
    assert worker.request({'x':[3]})=={'x':[3]}
    assert worker.process.pid==pid
    worker.close();assert worker.process is None

def test_worker_timeout_is_bounded_and_reaps_only_its_child(tmp_path):
    worker=PredictionProcess([sys.executable,'-u','-c','import time;time.sleep(5)'],cwd=tmp_path,timeout=.1)
    with pytest.raises(RuntimeError):worker.request({'x':1})
    assert worker.process is None

def test_large_request_cannot_block_before_response_deadline(tmp_path):
    worker=PredictionProcess([sys.executable,'-u','-c','import time;time.sleep(5)'],cwd=tmp_path,timeout=.1)
    with pytest.raises(RuntimeError):worker.request({'x':'a'*200000})
    assert worker.process is None
