import gzip
import json
import pytest
from user_application.apps.web_dashboard import launcher


def test_prepared_runtime_keeps_a_complete_environment(monkeypatch):
    monkeypatch.setattr(launcher.importlib.util, 'find_spec', lambda name: object())
    monkeypatch.setattr(launcher.subprocess, 'call', lambda *a, **k: pytest.fail('no delegation'))
    assert launcher.prepared_runtime(['--restart']) is None


def test_missing_sgp4_delegates_all_options_before_touching_the_server(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(launcher.importlib.util, 'find_spec', lambda name: None)
    monkeypatch.setattr(launcher.sys, 'prefix', str(tmp_path / 'base'))
    environment = tmp_path / 'project_support/environment/web_venv'
    interpreter = environment / ('Scripts/python.exe' if launcher.sys.platform == 'win32' else 'bin/python')
    interpreter.parent.mkdir(parents=True)
    interpreter.touch()
    calls = []
    monkeypatch.setattr(launcher.subprocess, 'call', lambda command, **kwargs: calls.append((command, kwargs)) or 7)
    monkeypatch.setattr(launcher, 'configured_host', lambda: pytest.fail('delegation must precede server actions'))
    options = ['--restart', '--no-browser', '--host', '127.0.0.1', '--port', '8767']
    assert launcher.main(options) == 7
    assert calls == [([str(interpreter), '-m', 'user_application.apps.web_dashboard.launcher', *options], {'cwd': tmp_path})]


@pytest.mark.parametrize('prepared_exists', [False, True])
def test_missing_dependency_without_a_usable_fallback_fails_without_recursion(tmp_path, monkeypatch, prepared_exists):
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(launcher.importlib.util, 'find_spec', lambda name: None)
    environment = tmp_path / 'project_support/environment/web_venv'
    monkeypatch.setattr(launcher.sys, 'prefix', str(environment if prepared_exists else tmp_path / 'base'))
    if prepared_exists:
        interpreter = environment / ('Scripts/python.exe' if launcher.sys.platform == 'win32' else 'bin/python')
        interpreter.parent.mkdir(parents=True)
        interpreter.touch()
    monkeypatch.setattr(launcher.subprocess, 'call', lambda *a, **k: pytest.fail('must not recurse'))
    assert launcher.prepared_runtime([]) == 1


def test_default_launch_polls_celestrak_and_tolerates_missing_credentials(tmp_path,monkeypatch):
    # The loader reads the deployment's own directory first and falls back to the
    # profile, so a test for "no credentials anywhere" has to isolate both.
    from user_application.apps.web_dashboard import credentials
    monkeypatch.setattr(credentials,'LOCAL_CREDENTIAL_DIRECTORY',tmp_path/'deployment')
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    monkeypatch.setenv('USERPROFILE',str(tmp_path))
    monkeypatch.setenv('HOMEDRIVE',tmp_path.drive)
    monkeypatch.setenv('HOMEPATH',str(tmp_path)[len(tmp_path.drive):])
    for key in ['AERODT_OPENSKY_CLIENT_ID','AERODT_OPENSKY_CLIENT_SECRET','AERODT_CESIUM_ION_TOKEN','AERODT_VWORLD_API_KEY']:
        monkeypatch.delenv(key,raising=False)
    config=launcher.prepare_config(tmp_path,8766)
    assert config['vworld_enabled'] is False, 'no key, no V-World relay'
    assert config['celestrak_enabled'] is True, 'satellites come from the live provider'
    assert config['opensky_enabled'] is False
    assert config['buildings_enabled'] is False
    assert 'saved_satellites' not in config


def test_launcher_reuses_saved_gp_and_existing_credentials(tmp_path,monkeypatch):
    monkeypatch.setenv('AERODT_OPENSKY_CLIENT_ID','test-id')
    monkeypatch.setenv('AERODT_OPENSKY_CLIENT_SECRET','test-secret')
    monkeypatch.setenv('AERODT_CESIUM_ION_TOKEN','test-token')
    monkeypatch.setenv('AERODT_VWORLD_API_KEY','test-vworld')
    directory=tmp_path/'data/workspace/live_ingestion/imports';directory.mkdir(parents=True)
    path=directory/'saved.json.gz'
    with gzip.open(path,'wt') as stream:
        json.dump({'fetched_at':'2026-09-07T00:00:00Z','items':[{'NORAD_CAT_ID':25544}]},stream)
    config=launcher.prepare_config(tmp_path,8767)
    # The saved GP is the startup bootstrap; the live record replaces it.
    assert config['saved_satellites']==str(path)
    assert config['celestrak_enabled'] is True
    assert config['opensky_enabled'] and config['buildings_enabled'] and config['vworld_enabled']
    assert 'test-secret' not in str(config) and 'test-token' not in str(config) and 'test-vworld' not in str(config)


def test_already_running_gui_is_not_started_twice(monkeypatch):
    opened=[]
    monkeypatch.setattr(launcher,'configured_host',lambda *args,**kwargs:'127.0.0.1')
    monkeypatch.setattr(launcher,'server_status',lambda port,host='127.0.0.1':'ready')
    monkeypatch.setattr(launcher.webbrowser,'open',lambda url:opened.append(url))
    monkeypatch.setattr(launcher,'prepare_config',lambda *args:(_ for _ in ()).throw(AssertionError('no second server')))
    assert launcher.main([])==0
    assert opened==['http://127.0.0.1:8766/']


def test_other_service_port_is_not_killed_or_reused(monkeypatch):
    monkeypatch.setattr(launcher,'configured_host',lambda *args,**kwargs:'127.0.0.1')
    monkeypatch.setattr(launcher,'server_status',lambda port,host='127.0.0.1':'busy')
    assert launcher.main(['--no-browser'])==1


def test_the_config_file_owns_the_address_and_the_command_line_overrides_it(tmp_path,monkeypatch):
    """Editing default.json used to change nothing: the launcher overwrote host
    with its own default on every run."""
    monkeypatch.setattr(launcher,'load_config',lambda:{'host':'10.1.2.3','port':8766})
    assert launcher.configured_host()=='10.1.2.3'
    assert launcher.prepare_config(tmp_path,8766)['host']=='10.1.2.3', 'the file is followed'
    assert launcher.prepare_config(tmp_path,8766,'0.0.0.0')['host']=='0.0.0.0', '--host wins for one run'
    monkeypatch.setattr(launcher,'load_config',lambda:{'port':8766})
    assert launcher.configured_host()=='127.0.0.1', 'no host in the file: this machine only'
    assert launcher.prepare_config(tmp_path,8766)['host']=='127.0.0.1'


def test_the_browser_opens_the_address_the_server_actually_answers_on(monkeypatch):
    assert launcher.browse_url('10.1.2.3',8766)=='http://10.1.2.3:8766/'
    assert launcher.browse_url('0.0.0.0',8766)=='http://127.0.0.1:8766/', 'every interface includes this one'
    assert launcher.browse_url('127.0.0.1',8767)=='http://127.0.0.1:8767/'
    asked=[]
    monkeypatch.setattr(launcher,'configured_host',lambda *args,**kwargs:'10.1.2.3')
    monkeypatch.setattr(launcher,'server_status',lambda port,host='127.0.0.1':asked.append((port,host)) or 'ready')
    monkeypatch.setattr(launcher.webbrowser,'open',lambda url:asked.append(url))
    assert launcher.main([])==0
    assert asked==[(8766,'10.1.2.3'),'http://10.1.2.3:8766/'], 'the running server is looked for where it binds'


def test_every_interface_serves_this_machine_and_the_network(monkeypatch):
    """Binding one address leaves the other refused; every interface serves both,
    and the address to open here is still the loopback one."""
    assert launcher.browse_url('0.0.0.0',8766)=='http://127.0.0.1:8766/'
    monkeypatch.setattr(launcher,'load_config',lambda:{'host':'0.0.0.0','port':8766})
    assert launcher.configured_host()=='0.0.0.0'
    asked=[]
    monkeypatch.setattr(launcher,'server_status',lambda port,host='127.0.0.1':asked.append(host) or 'ready')
    monkeypatch.setattr(launcher.webbrowser,'open',lambda url:None)
    assert launcher.main(['--no-browser'])==0
    assert asked==['0.0.0.0'], 'an existing dashboard is looked for over loopback'


def test_an_address_other_machines_can_reach_is_announced_as_such(monkeypatch,capsys):
    """This server has no login, so a reachable address is stated every run."""
    monkeypatch.setattr(launcher,'configured_host',lambda *args,**kwargs:'10.1.2.3')
    monkeypatch.setattr(launcher,'server_status',lambda port,host='127.0.0.1':'free')
    monkeypatch.setattr(launcher,'prepare_config',lambda *args:{'fixture_mode':True})
    class Stopped(Exception): pass
    def refuse(*args,**kwargs):
        raise Stopped
    monkeypatch.setattr(launcher.uvicorn,'Server',refuse)
    monkeypatch.setattr(launcher,'create_app',lambda config:None)
    try:
        launcher.main(['--no-browser'])
    except Stopped:
        pass
    printed=capsys.readouterr().out
    assert '10.1.2.3' in printed and '로그인이 없습니다' in printed
    monkeypatch.setattr(launcher,'configured_host',lambda *args,**kwargs:'0.0.0.0')
    monkeypatch.setattr(launcher,'lan_address',lambda port,probe='203.0.113.1':f'http://10.1.2.3:{port}/')
    try:
        launcher.main(['--no-browser'])
    except Stopped:
        pass
    printed=capsys.readouterr().out
    assert '모든 인터페이스' in printed and '로그인이 없습니다' in printed
    assert 'http://10.1.2.3:8766/' in printed, 'the address to hand to somebody else'


def test_static_modules_always_revalidate():
    """Modules import each other by bare path: a cached importer beside an edited
    dependency fails the boot, so every static file must be revalidated (ETag 304)."""
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    app = create_app({'fixture_mode': True, 'celestrak_enabled': False, 'opensky_enabled': False})
    with TestClient(app) as client:
        for path in ('/visualization/globe.js', '/static/app.js', '/communication/tracking_client.js'):
            response = client.get(path)
            assert response.status_code == 200, path
            assert response.headers.get('cache-control') == 'no-cache', path
            assert response.headers.get('etag'), path


def test_aircraft_polling_stays_inside_the_provider_daily_budget():
    """OpenSky bills per request and charges the most for an unbounded area; the
    shipped defaults must not exhaust the day's credits as the 15 s global poll
    did (measured: HTTP 429 with 18,081 s of lockout remaining)."""
    from user_application.apps.web_dashboard.application import load_config
    config = load_config()
    bounds = config['aircraft_bounds']
    assert set(bounds) == {'lamin', 'lamax', 'lomin', 'lomax'}, 'a bounded request is the cheaper tier'
    span = (bounds['lamax'] - bounds['lamin']) * (bounds['lomax'] - bounds['lomin'])
    assert 0 < span <= 25, f'{span} square degrees leaves the cheapest tier'
    for name, latitude, longitude in [('Jeju', 33.51, 126.53), ('Busan', 35.18, 129.08),
                                      ('Incheon', 37.46, 126.44), ('Seoul', 37.57, 126.98)]:
        assert bounds['lamin'] <= latitude <= bounds['lamax'], name
        assert bounds['lomin'] <= longitude <= bounds['lomax'], name
    # Sized against the pessimistic reading of the provider's tiers, so a wrong
    # guess about the cost of this area still cannot exhaust the day.
    daily = 86400 / config['aircraft_poll_seconds'] * 2
    assert daily <= 4000, f'{daily:.0f} credits a day exceeds the authenticated budget'


def test_a_live_source_replaces_the_bootstrap_it_supersedes():
    """Both the saved GP and the live GP carry the same satellites; keeping both
    registered would show every object twice."""
    from data.ingestion.source_records import SourceRecords
    records = SourceRecords()
    records.register('celestrak_saved', [{'NORAD_CAT_ID': 25544}], 1.0, format='celestrak_gp')
    records.register('celestrak', [{'NORAD_CAT_ID': 25544}], 2.0, format='celestrak_gp')
    assert len(records.records()) == 2
    assert records.discard('celestrak_saved') is True
    assert [record.source for record in records.records()] == ['celestrak']
    assert records.discard('celestrak_saved') is False, 'dropping twice is not an error'
