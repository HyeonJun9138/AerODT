import json
import pytest
from pathlib import Path
from user_application.apps.web_dashboard import credentials
from user_application.apps.web_dashboard.credentials import (credential_paths, configure_airspace, configure_cesium,
                                                             configure_datago, configure_opensky)


@pytest.fixture(autouse=True)
def isolated_local_credentials(tmp_path, monkeypatch):
    monkeypatch.setattr(credentials, 'LOCAL_CREDENTIAL_DIRECTORY', tmp_path / 'local_credentials')


def test_local_deployment_credentials_win_over_profile(tmp_path):
    directory = credentials.LOCAL_CREDENTIAL_DIRECTORY
    directory.mkdir()
    (directory / 'cesium.json').write_text('{"accessToken":"local-test-token"}')
    env = {'LOCALAPPDATA': str(tmp_path / 'absent_profile')}
    configure_cesium(environ=env, home=tmp_path / 'home')
    assert env['AERODT_CESIUM_ION_TOKEN'] == 'local-test-token'


def test_loads_local_credentials_without_putting_secrets_in_config(tmp_path):
    path = tmp_path / 'opensky.json'
    path.write_text(json.dumps({'clientId': 'test-id', 'clientSecret': 'test-secret'}))
    env = {}
    configure_opensky(path, env)
    assert env['AERODT_OPENSKY_CLIENT_ID'] == 'test-id'
    assert env['AERODT_OPENSKY_CLIENT_SECRET'] == 'test-secret'


def test_invalid_credentials_raise_sanitized_error(tmp_path):
    path = tmp_path / 'opensky.json'
    path.write_text('private-invalid-content')
    with pytest.raises(ValueError) as error:
        configure_opensky(path, {})
    assert 'private-invalid-content' not in str(error.value)


@pytest.mark.parametrize('failure', [PermissionError(13, 'private-detail'),
                                   OSError(5, 'private-detail')])
def test_read_errors_are_not_reported_as_missing(tmp_path, monkeypatch, failure):
    def fail_read(*args, **kwargs):
        raise failure
    monkeypatch.setattr(Path, 'read_text', fail_read)
    with pytest.raises(ValueError) as error:
        configure_cesium(tmp_path / 'cesium.json', {})
    message = str(error.value)
    assert 'could not be read' in message
    assert type(failure).__name__ in message
    assert f'errno={failure.errno}' in message
    assert 'private-detail' not in message


def test_unreadable_location_can_fall_back_to_readable_profile(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    directory = home / 'AppData/Local/AeroDT/credentials'
    directory.mkdir(parents=True)
    (directory / 'cesium.json').write_text('{"accessToken":"test-token"}')
    inaccessible = tmp_path / 'inaccessible'
    original = Path.read_text
    def read(path, *args, **kwargs):
        if inaccessible in path.parents:
            raise PermissionError(13, 'private-detail')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)
    env = {'LOCALAPPDATA': str(inaccessible)}
    configure_cesium(environ=env, home=home)
    assert env['AERODT_CESIUM_ION_TOKEN'] == 'test-token'


def test_complete_environment_takes_precedence(tmp_path):
    env = {'AERODT_OPENSKY_CLIENT_ID': 'id', 'AERODT_OPENSKY_CLIENT_SECRET': 'secret'}
    configure_opensky(tmp_path / 'absent.json', env)
    assert env['AERODT_OPENSKY_CLIENT_ID'] == 'id'


# ---------------------------------------------------------------- where the files are looked for

def test_every_home_shaped_location_is_tried_in_order(tmp_path):
    home = tmp_path / 'profile'
    env = {'LOCALAPPDATA': str(home / 'AppData/Local'), 'USERPROFILE': str(home)}
    paths = credential_paths('cesium.json', env, home=home)
    assert paths[0] == credentials.LOCAL_CREDENTIAL_DIRECTORY / 'cesium.json'
    assert paths[1] == home / 'AppData/Local/AeroDT/credentials/cesium.json'
    assert home / 'AppData/Local/AeroDT/credentials/cesium.json' in paths
    assert len({str(path) for path in paths}) == len(paths), 'no duplicates'


def test_credentials_load_when_localappdata_is_missing_or_wrong(tmp_path):
    home = tmp_path / 'profile'
    directory = home / 'AppData/Local/AeroDT/credentials'
    directory.mkdir(parents=True)
    (directory / 'cesium.json').write_text(json.dumps({'accessToken': 'token-value'}), encoding='utf-8')
    (directory / 'opensky.json').write_text(json.dumps({'clientId': 'id', 'clientSecret': 'secret'}), encoding='utf-8')

    # No LOCALAPPDATA at all: the profile directory still answers.
    env = {'USERPROFILE': str(home)}
    configure_cesium(environ=env, home=home)
    assert env['AERODT_CESIUM_ION_TOKEN'] == 'token-value'
    env = {'USERPROFILE': str(home)}
    configure_opensky(environ=env, home=home)
    assert env['AERODT_OPENSKY_CLIENT_ID'] == 'id'

    # LOCALAPPDATA pointing somewhere without the file: the next location answers.
    env = {'LOCALAPPDATA': str(tmp_path / 'elsewhere'), 'USERPROFILE': str(home)}
    configure_cesium(environ=env, home=home)
    assert env['AERODT_CESIUM_ION_TOKEN'] == 'token-value'


def test_failure_names_the_locations_tried_without_leaking_values(tmp_path):
    home = tmp_path / 'empty'
    env = {'LOCALAPPDATA': str(tmp_path / 'nowhere')}
    with pytest.raises(ValueError) as error:
        configure_cesium(environ=env, home=home)
    message = str(error.value)
    assert 'cesium.json' in message and 'nowhere' in message, 'the operator can see where it looked'
    assert 'AERODT_CESIUM_ION_TOKEN' in message, 'and how to override it'


def test_an_explicit_path_still_wins(tmp_path):
    path = tmp_path / 'cesium.json'
    path.write_text(json.dumps({'accessToken': 'explicit'}), encoding='utf-8')
    env = {}
    configure_cesium(path, env)
    assert env['AERODT_CESIUM_ION_TOKEN'] == 'explicit'


# ---------------------------------------------------------------- airspace keys

def test_a_portal_key_is_stored_decoded_and_read_from_the_credential_store(tmp_path):
    path = tmp_path / 'datago.json'
    path.write_text(json.dumps({'serviceKey': 'abc%2Bdef%3D%3D'}), encoding='utf-8')
    env = {}
    configure_datago(path, env)
    assert env['AERODT_DATAGO_SERVICE_KEY'] == 'abc+def==', 'pasted URL-encoded from the portal, kept decoded'
    plain = tmp_path / 'plain.json'
    plain.write_text(json.dumps({'serviceKey': ' already/decoded+key== '}), encoding='utf-8')
    env = {}
    configure_datago(plain, env)
    assert env['AERODT_DATAGO_SERVICE_KEY'] == 'already/decoded+key=='
    with pytest.raises(ValueError) as error:
        configure_datago(tmp_path / 'absent.json', {})
    assert 'datago.json not found' in str(error.value)


def test_airspace_takes_whichever_key_exists_and_names_both_when_neither_does(tmp_path):
    home = tmp_path / 'profile'
    directory = home / 'AppData/Local/AeroDT/credentials'
    directory.mkdir(parents=True)
    env = {'USERPROFILE': str(home)}
    with pytest.raises(ValueError) as error:
        configure_airspace(environ=env, home=home)
    assert 'datago.json' in str(error.value) and 'vworld.json' in str(error.value)
    (directory / 'datago.json').write_text(json.dumps({'serviceKey': 'portal-key'}), encoding='utf-8')
    env = {'USERPROFILE': str(home)}
    configure_airspace(environ=env, home=home)
    assert env['AERODT_DATAGO_SERVICE_KEY'] == 'portal-key'
    assert 'AERODT_VWORLD_API_KEY' not in env, 'the first key that exists is enough'
