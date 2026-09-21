"""Persist the selected external UAM source without owning live state."""
import json
from pathlib import Path


class PhysicalSourceSettings:
    def __init__(self,path):self.path=Path(path)
    def read(self,default=''):
        try:
            value=json.loads(self.path.read_text(encoding='utf-8'))
            return value['source_url'] if isinstance(value,dict) and isinstance(value.get('source_url'),str) else default
        except (OSError,ValueError,TypeError):return default
    def write(self,url):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temporary=self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'schema_version':1,'source_url':url}),encoding='utf-8')
        temporary.replace(self.path)
