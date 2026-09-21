import asyncio
from copy import deepcopy
import json
import time
from pathlib import Path
import httpx
import pytest
from fastapi import FastAPI
from communication.external.physical_link import validate_link,ssh_arguments
from communication.web.physical_uam_routes import create_physical_uam_router
from data.settings.physical_source import PhysicalSourceSettings
from data.simulation.physical_console import PhysicalConsoleFiles
from user_application.apps.physical_uam.connection import PhysicalConnection
from user_application.apps.web_dashboard.physical_input import PhysicalInput


@pytest.fixture
def config(tmp_path):
    key=tmp_path/'a key';key.write_text('test fixture')
    return dict(host='twin.example',ssh_port=22,web_port=8766,forward_port=18770,
                username='operator',identity_file=str(key),auto_connect=True,schema_version=1)


@pytest.mark.parametrize('field,value',[('host','-oProxyCommand=x'),('host','host;cmd'),('username','a@b'),
    ('ssh_port',True),('web_port',0),('forward_port',8766),('forward_port',70000),('auto_connect','true')])
def test_bad_connection_never_becomes_a_process_argument(config,field,value):
    config[field]=value
    with pytest.raises(ValueError):validate_link(config)


def test_forward_arguments_use_loopback_and_keep_key_as_one_argument(config):
    args=ssh_arguments(validate_link(config,check_key=True),8770,20001)
    assert args[args.index('-i')+1]==config['identity_file']
    assert args[args.index('-R')+1]=='127.0.0.1:18770:127.0.0.1:8770'
    assert args[args.index('-L')+1]=='127.0.0.1:20001:127.0.0.1:8766'
    assert 'StrictHostKeyChecking=yes' in args and 'BatchMode=yes' in args


class FakeLink:
    def __init__(self,*,process='current',age=.1):
        self.running=True;self.local_port=8770;self.process=process;self.age=age;self.calls=[];self.fail=False
    async def connect(self,config):self.running=True;self.calls.append(config['host'])
    async def close(self):self.running=False
    async def request(self,path,*,payload=None):
        if self.fail and payload:self.fail=False;raise ValueError('failed to configure')
        if path=='/api/live/uam/source':self.calls.append(payload);return {}
        if path=='/api/live/uam':return {'source_url':'http://127.0.0.1:18770','status':'ready','enabled':True,'receiving':True,
            'aircraft':[{'entity_id':'physical:UAM1','name':'UAM1','sequence':8,'measurement_age_s':self.age}]}
        return {'process_id':self.process}


@pytest.mark.parametrize('process,age,receiving',[('current',.1,True),('other',.1,False),('current',10,False)])
def test_diagnostics_require_this_publishers_fresh_measurement(tmp_path,config,process,age,receiving):
    async def run():
        c=PhysicalConnection(PhysicalConsoleFiles(tmp_path),config,'current');c.link=FakeLink(process=process,age=age)
        result=await c.diagnose()
        assert result['diagnostics']['receiving']==receiving
        assert result['tunnel_running']
    asyncio.run(run())


def test_failed_apply_keeps_settings_and_restores_owned_tunnel(tmp_path,config):
    async def run():
        files=PhysicalConsoleFiles(tmp_path);files.save('connection',config)
        c=PhysicalConnection(files,config,'current');c.link=FakeLink();c.link.fail=True
        with pytest.raises(ValueError):await c.connect(dict(config,host='different.example'))
        assert files.read('connection')==config and c.config==config
        assert c.link.calls[-1]=='twin.example' and c.link.running
    asyncio.run(run())


def test_disconnect_persists_but_launcher_suspend_does_not(tmp_path,config):
    async def run():
        files=PhysicalConsoleFiles(tmp_path);files.save('connection',config)
        c=PhysicalConnection(files,config,'current');c.link=FakeLink()
        await c.suspend();assert files.read('connection')['auto_connect'] is True
        await c.disconnect();assert files.read('connection')['auto_connect'] is False
        assert not c.link.running
    asyncio.run(run())


def test_a_dead_tunnel_cannot_keep_a_cached_green_badge(tmp_path,config):
    async def run():
        c=PhysicalConnection(PhysicalConsoleFiles(tmp_path),config,'current');c.link=FakeLink()
        await c.diagnose();c.link.running=False
        result=c.describe()
        assert result['status']=='disconnected' and not result['diagnostics']['receiving']
    asyncio.run(run())


def test_new_flight_is_not_hidden_by_old_aircraft_observations(tmp_path,config):
    async def run():
        class MultipleFlights(FakeLink):
            async def request(self,path,**kwargs):
                value=await super().request(path,**kwargs)
                if path=='/api/live/uam':
                    value['aircraft']=[dict(value['aircraft'][0],measurement_age_s=30),
                        dict(value['aircraft'][0],entity_id='physical:UAM2',name='UAM2',measurement_age_s=.1)]
                return value
        c=PhysicalConnection(PhysicalConsoleFiles(tmp_path),config,'current');c.link=MultipleFlights()
        result=await c.diagnose()
        assert result['diagnostics']['receiving'] and result['diagnostics']['aircraft']=='UAM2'
    asyncio.run(run())


def test_failed_local_save_restores_the_previous_remote_source(tmp_path,config,monkeypatch):
    async def run():
        files=PhysicalConsoleFiles(tmp_path);files.save('connection',config)
        c=PhysicalConnection(files,config,'current');c.link=FakeLink()
        def fail(*args):raise OSError('disk full')
        monkeypatch.setattr(files,'save',fail)
        with pytest.raises(ValueError):await c.connect(dict(config,forward_port=18771))
        applied=[x for x in c.link.calls if isinstance(x,dict)]
        assert applied==[{'source_url':'http://127.0.0.1:18771'},{'source_url':'http://127.0.0.1:18770'}]
        assert files.read('connection')==config
    asyncio.run(run())


def test_publisher_connection_settings_are_not_public(tmp_path):
    from communication.web.physical_console_routes import create_console_router
    async def run():
        app=FastAPI();app.include_router(create_console_router(None,None,tmp_path))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('192.0.2.10',1234)),base_url='http://test') as client:
            assert (await client.get('/api/v1/console/connection')).status_code==403
            assert (await client.post('/api/v1/console/connection/connect',json={})).status_code==403
    asyncio.run(run())


def test_remote_source_changes_are_local_only_and_persisted(tmp_path):
    async def run():
        path=tmp_path/'source.json';feed=PhysicalInput('',lambda:True,lambda:False,{},PhysicalSourceSettings(path))
        app=FastAPI();app.include_router(create_physical_uam_router(feed))
        for address,status in [('192.0.2.10',403),('127.0.0.1',200)]:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=(address,1234)),base_url='http://test') as client:
                result=await client.put('/api/live/uam/source',json={'source_url':'http://127.0.0.1:18770'})
                assert result.status_code==status
                if status==200:
                    before=path.read_bytes()
                    for url in ['http://remote.example:18770','file:///test','http://127.0.0.1:80','http://127.0.0.1:18770/path']:
                        assert (await client.put('/api/live/uam/source',json={'source_url':url})).status_code==422
                    assert (await client.put('/api/live/uam/source',json={'source_url':'http://127.0.0.1:18771'},headers={'Origin':'https://foreign.example'})).status_code==403
                    assert path.read_bytes()==before
        assert PhysicalSourceSettings(path).read()=='http://127.0.0.1:18770'
    asyncio.run(run())


def test_old_inflight_source_response_cannot_enter_new_feed(monkeypatch):
    import user_application.apps.web_dashboard.physical_input as module
    async def run():
        entered=asyncio.Event();release=asyncio.Event();new=asyncio.Event()
        async def fetch(client,url,**kwargs):
            if url=='old':
                entered.set();await release.wait()
                return {'process_id':'old','packets':[{'invalid_old_packet':True}]}
            new.set();await asyncio.Future()
        monkeypatch.setattr(module,'fetch_packets',fetch)
        feed=PhysicalInput('old',lambda:True,lambda:False,{})
        task=asyncio.create_task(feed.run())
        try:
            await asyncio.wait_for(entered.wait(),1);feed.set_source('new');release.set()
            await asyncio.wait_for(new.wait(),1)
            assert feed.records.counters()['rejected']==0 and feed.records.read()==[]
        finally:task.cancel();await asyncio.gather(task,return_exceptions=True)
    asyncio.run(run())
