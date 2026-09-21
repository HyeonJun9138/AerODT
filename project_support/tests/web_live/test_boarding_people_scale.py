"""Measure the shipped render geometry, not just the numbers in its metadata."""
import hashlib
import itertools
import json
from pathlib import Path
import struct
import numpy as np

ROOT=Path(__file__).resolve().parents[3]

def bounds(path, wanted=None):
    body=path.read_bytes()
    doc=json.loads(body[20:20+struct.unpack_from('<I',body,12)[0]])
    low=np.full(3,np.inf); high=-low
    def walk(index,parent):
        nonlocal low,high
        n=doc['nodes'][index]
        # The rigid Kenney rest pose contains only identity rotations.
        assert n.get('rotation',[0,0,0,1]) == [0,0,0,1]
        m=np.eye(4);m[:3,:3]=np.diag(n.get('scale',[1,1,1]));m[:3,3]=n.get('translation',[0,0,0])
        m=parent@m
        if 'mesh' in n and (wanted is None or n.get('name')==wanted):
            for p in doc['meshes'][n['mesh']]['primitives']:
                a=doc['accessors'][p['attributes']['POSITION']]
                for corner in itertools.product(*zip(a['min'],a['max'])):
                    point=(m@np.array([*corner,1]))[:3];low=np.minimum(low,point);high=np.maximum(high,point)
        for c in n.get('children',[]):walk(c,m)
    for n in doc['scenes'][doc.get('scene',0)]['nodes']:walk(n,np.eye(4))
    return low,high,doc

def test_boarding_adults_keep_height_and_feet_but_not_oversized_block_heads():
    paths=list((ROOT/'digital_twin/model_library/visual_assets/people/civilian').glob('kenney_*/asset.json'))
    assert len(paths)==11
    for p in paths:
        m=json.loads(p.read_text(encoding='utf-8'));model=p.parent/m['model']['path']
        low,high,doc=bounds(model);drawn=(high-low)*1.75/2.7
        assert abs(drawn[1]-1.75)<1e-6,(p,drawn)
        assert abs(low[1])<1e-6
        assert .5<drawn[0]<.7,(p,drawn)
        hlow,hhigh,_=bounds(model,'head');head=(hhigh-hlow)*1.75/2.7
        assert .22<head[0]<.27 and .23<head[1]<.28,(p,head)
        assert 'walk' in [a['name'] for a in doc['animations']]
        assert hashlib.sha256(model.read_bytes()).hexdigest()==m['model']['sha256']

def test_acquired_people_are_preserved_and_catalog_selects_the_reviewed_derivative():
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    assets=read_visual_catalog(ROOT/'digital_twin/model_library/visual_assets')['assets']
    people=[a for a in assets if a['asset_id'].startswith('kenney_')]
    assert len(people)==11
    for a in people:
        assert a['uri'].endswith('/boarding_model.glb')
        p=ROOT/'digital_twin/model_library/visual_assets'/a['metadata_uri'].removeprefix('/visual-assets/')
        m=json.loads(p.read_text(encoding='utf-8'));source=p.parent/m['original_model']['path']
        assert hashlib.sha256(source.read_bytes()).hexdigest()==m['original_model']['sha256']
        _,high,_=bounds(source)
        assert high[1]==2.7
