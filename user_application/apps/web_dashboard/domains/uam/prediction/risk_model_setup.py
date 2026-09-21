"""Application selection of a local inference interpreter, never a network API."""
from functools import lru_cache
from pathlib import Path
import shutil
import subprocess
import sys
from communication.prediction_process import PredictionProcess


@lru_cache(maxsize=8)
def prediction_python(configured=''):
    # Deployment may name its own runtime; never copy another environment's libs.
    candidates=[configured] if configured else [sys.executable,shutil.which('python')]
    for candidate in dict.fromkeys(x for x in candidates if x):
        try:
            checked=subprocess.run([candidate,'-c',"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('torch') and importlib.util.find_spec('numpy') else 1)"],
                timeout=3,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if checked.returncode==0:return candidate
        except (OSError,subprocess.TimeoutExpired):pass
    return None


class PrismProcessModel:
    def __init__(self,package_dir,*,python,root):
        self.worker=PredictionProcess([python,'-u','-m','ai_pnp.domains.uam.prism_worker','--package',str(Path(package_dir).resolve())],cwd=root,timeout=30)
    def predict_batch(self,samples):
        return self.worker.request({'schema_version':1,'samples':[
            {'x':sample['x'].tolist(),'agent_mask':sample['agent_mask'].tolist()} for sample in samples]})
    def close(self):self.worker.close()
