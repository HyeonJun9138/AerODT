"""Physical-console inputs and saved run settings. Never owns aircraft state."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import threading


class PhysicalConsoleFiles:
    def __init__(self, workspace):
        self.workspace=Path(workspace);self.directory=self.workspace/'physical_uam/console'
        self.directory.mkdir(parents=True,exist_ok=True);self.lock=threading.RLock()

    def read(self, name, default=None):
        with self.lock:
            path=self.directory/(name+'.json')
            return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else deepcopy(default)

    def save(self, name, value):
        with self.lock:
            path=self.directory/(name+'.json');temporary=path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
            temporary.replace(path)

    def import_plan(self, raw, name, kind):
        identifier=hashlib.sha256(raw).hexdigest()[:20]
        with self.lock:
            (self.directory/(identifier+'.'+kind)).write_bytes(raw)
            items=self.read('plans',[])
            items=[x for x in items if x['id']!=identifier]
            items.insert(0,{'id':identifier,'name':Path(name).name[:100],'kind':kind})
            self.save('plans',items[:40])
        return identifier

    def plan(self, identifier):
        item=next((x for x in self.read('plans',[]) if x['id']==identifier),None)
        if not item:raise ValueError('비행계획 파일을 선택해 주세요.')
        return item,(self.directory/(item['id']+'.'+item['kind'])).read_bytes()
