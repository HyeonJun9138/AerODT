"""Persistence for operator alignment preferences; never owns navigation state."""
import json
from pathlib import Path

class UamAlignmentSettings:
    def __init__(self,path):self.path=Path(path)
    def read(self):
        try:
            value=json.loads(self.path.read_text(encoding='utf-8'))
            return value if isinstance(value,dict) else {}
        except (OSError,ValueError):return {}
    def write(self,value):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temp=self.path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8');temp.replace(self.path)

