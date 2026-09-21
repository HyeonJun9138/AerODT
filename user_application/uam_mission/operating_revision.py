"""Identify the deployed rules and native binary used to execute a flight."""
import hashlib
import json
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()[:16]


def operating_revision(root=None):
    root=Path(root or Path(__file__).resolve().parents[2]);paths=[]
    for name in ('user_application/uam_mission','digital_twin/simulation'):
        paths.extend((root/name).glob('*.py'))
    paths.append(root/'communication/python/native_pilot.py')
    paths.extend((root/'project_support/build/aerodt/windows-release/bin').glob('aerodt_uam_pilot*.dll'))
    hashes={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths) if p.is_file()}
    return {'revision':digest(hashes),'files':hashes}
