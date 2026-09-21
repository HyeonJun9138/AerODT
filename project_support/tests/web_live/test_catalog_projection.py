import json
from digital_twin.model_library.visual_catalog import read_visual_catalog


def test_native_catalog_is_projected_without_mutation_or_rights_bypass(tmp_path):
    entries=[]
    for name,public in [('a320',True),('withheld',False)]:
        directory=tmp_path/name;directory.mkdir()
        (directory/'model.glb').write_bytes(b'fixture')
        (directory/'asset.json').write_text(json.dumps({'asset_id':name,'category':'aircraft/civilian',
            'model':{'path':'model.glb'},'rights':{'public_export':public,'label':'CC-BY-4.0','credit':'Author'},
            'display':{'browser_measured_extent':37}}))
        entries.append({'asset_id':name,'metadata':f'{name}/asset.json'})
    path=tmp_path/'catalog.json';path.write_text(json.dumps({'schema_version':1,'assets':entries}))
    before=path.read_bytes();view=read_visual_catalog(tmp_path)
    assert path.read_bytes()==before
    assert [a['asset_id'] for a in view['assets']]==['a320']
    assert view['assets'][0]['uri']=='/visual-assets/a320/model.glb'
    assert view['assets'][0]['size_m']==37


def test_escaping_metadata_is_rejected(tmp_path):
    import pytest
    (tmp_path/'catalog.json').write_text(json.dumps({'schema_version':1,'assets':[{'asset_id':'x','metadata':'../secret.json'}]}))
    with pytest.raises(ValueError):read_visual_catalog(tmp_path)


def test_projection_publishes_the_review_thumbnail_when_there_is_one(tmp_path):
    import json
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    for name, picture in (('withpic', True), ('nopic', False)):
        directory = tmp_path / name
        directory.mkdir()
        (directory / 'model.glb').write_bytes(b'fixture')
        meta = {'asset_id': name, 'category': 'aircraft/civilian', 'model': {'path': 'model.glb'},
                'rights': {'public_export': True, 'label': 'MIT', 'credit': 'Author'},
                'display': {'browser_measured_extent': 9}}
        if picture:
            (directory / 'thumbnail.jpg').write_bytes(b'\xff\xd8fixture')
            meta['thumbnail'] = {'path': 'thumbnail.jpg'}
        (directory / 'asset.json').write_text(json.dumps(meta))
    (tmp_path / 'catalog.json').write_text(json.dumps({'schema_version': 1, 'assets': [
        {'asset_id': 'withpic', 'metadata': 'withpic/asset.json'},
        {'asset_id': 'nopic', 'metadata': 'nopic/asset.json'}]}))
    view = {a['asset_id']: a for a in read_visual_catalog(tmp_path)['assets']}
    # Browsing the shelf must not have to download a model to show something.
    assert view['withpic']['thumbnail'] == '/visual-assets/withpic/thumbnail.jpg'
    # A declared thumbnail that is not on disk is simply absent, never a broken link.
    assert 'thumbnail' not in view['nopic']


def test_projection_refuses_a_thumbnail_path_that_escapes_the_library(tmp_path):
    import json
    import pytest
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    directory = tmp_path / 'sneaky'
    directory.mkdir()
    (directory / 'model.glb').write_bytes(b'fixture')
    (directory / 'asset.json').write_text(json.dumps({
        'asset_id': 'sneaky', 'category': 'aircraft/civilian', 'model': {'path': 'model.glb'},
        'rights': {'public_export': True, 'label': 'MIT', 'credit': 'Author'},
        'display': {}, 'thumbnail': {'path': '../../secret.jpg'}}))
    (tmp_path / 'catalog.json').write_text(json.dumps({'schema_version': 1, 'assets': [
        {'asset_id': 'sneaky', 'metadata': 'sneaky/asset.json'}]}))
    with pytest.raises(ValueError):
        read_visual_catalog(tmp_path)

def test_cockpit_projection_validates_geometry(tmp_path):
    d=tmp_path/'plane';d.mkdir();(d/'model.glb').write_bytes(b'fixture')
    metadata={'asset_id':'test','category':'aircraft/civilian','model':{'path':'model.glb'},'rights':{'public_export':True},'cockpit':{'schema_version':1,'eye':[1,2,3],'forward':[1,0,0],'up':[0,1,0],'passenger_seats':4,'screens':[{'id':'pfd','center':[2,1,0],'width':1,'height':.4}]}}
    (tmp_path/'catalog.json').write_text(json.dumps({'assets':[{'metadata':'plane/asset.json'}]}))
    path=d/'asset.json';path.write_text(json.dumps(metadata))
    assert read_visual_catalog(tmp_path)['assets'][0]['cockpit']['eye']==[1,2,3]
    metadata['cockpit']['eye']=[float('nan'),0,0];path.write_text(json.dumps(metadata))
    assert 'cockpit' not in read_visual_catalog(tmp_path)['assets'][0]
