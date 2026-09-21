"""Explicit launch-time credential loading; never part of config or wire state.

Credentials are read from the local deployment first, then the operator profile. The launch
environment is not trusted to describe that profile: %LOCALAPPDATA% can be
missing or stale in a shell, so every profile-shaped location is tried in turn
and the failure names what was tried.
"""
import json
import os
from pathlib import Path

CREDENTIAL_DIRECTORY = 'AeroDT/credentials'
LOCAL_CREDENTIAL_DIRECTORY = Path(__file__).resolve().parents[2] / 'configs/web_dashboard/credentials'


def credential_paths(name, env, home=None):
    """Every place `name` may live, most specific first, without duplicates."""
    home = Path(home) if home else Path.home()
    roots = []
    local = env.get('LOCALAPPDATA')
    if local:
        roots.append(Path(local))
    profile = env.get('USERPROFILE')
    if profile:
        roots.append(Path(profile) / 'AppData/Local')
    roots.append(home / 'AppData/Local')
    roots.append(home / '.aerodt')
    paths = [LOCAL_CREDENTIAL_DIRECTORY / name]
    seen = {str(paths[0]).lower()}
    for root in roots:
        path = root / CREDENTIAL_DIRECTORY / name
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            paths.append(path)
    return paths


def _read(name, env, path, home, override):
    """Parsed JSON from `path`, or from the first location that has the file."""
    candidates = [Path(path)] if path else credential_paths(name, env, home)
    tried = []
    failures = []
    for candidate in candidates:
        try:
            return json.loads(candidate.read_text(encoding='utf-8-sig'))
        except OSError as error:
            tried.append(str(candidate))
            # Do not include exception text: only paths and numeric OS codes.
            # Permission errors must not masquerade as missing credentials.
            failures.append((isinstance(error, FileNotFoundError),
                             f'{candidate}: {type(error).__name__} '
                             f'(errno={error.errno}, winerror={getattr(error, "winerror", None)})'))
        except ValueError:
            raise ValueError(f'{name} is not valid JSON ({candidate})') from None
    locations = ' | '.join(tried)
    if any(not missing for missing, _ in failures):
        details = ' | '.join(detail for _, detail in failures)
        raise ValueError(f'{name} could not be read. OS errors: {details}. '
                         f'Set {override} to override.') from None
    raise ValueError(f'{name} not found. Looked in: {locations}. '
                     f'Set {override} to override.') from None


def configure_opensky(path=None, environ=None, home=None):
    env = os.environ if environ is None else environ
    keys = ('AERODT_OPENSKY_CLIENT_ID', 'AERODT_OPENSKY_CLIENT_SECRET')
    if all(env.get(key) for key in keys):
        return
    content = _read('opensky.json', env, path, home, ' and '.join(keys))
    try:
        values = (content['clientId'], content['clientSecret'])
        if not all(isinstance(value, str) and value.strip() for value in values):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError('opensky.json needs string "clientId" and "clientSecret" fields') from None
    env.update(zip(keys, (value.strip() for value in values)))


def configure_cesium(path=None, environ=None, home=None):
    env = os.environ if environ is None else environ
    key = 'AERODT_CESIUM_ION_TOKEN'
    if env.get(key):
        return
    content = _read('cesium.json', env, path, home, key)
    try:
        value = content['accessToken']
        if not isinstance(value, str) or not value.strip():
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError('cesium.json needs a string "accessToken" field') from None
    env[key] = value.strip()


def configure_vworld(path=None, environ=None, home=None):
    env = os.environ if environ is None else environ
    key = 'AERODT_VWORLD_API_KEY'
    if env.get(key):
        return
    content = _read('vworld.json', env, path, home, key)
    try:
        value = content['apiKey']
        if not isinstance(value, str) or not value.strip():
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError('vworld.json needs a string "apiKey" field') from None
    env[key] = value.strip()


def configure_datago(path=None, environ=None, home=None):
    """A 공공데이터포털 (data.go.kr) 인증키, for the airspace data. Stored decoded;
    a key pasted URL-encoded from the portal is decoded on the way in."""
    env = os.environ if environ is None else environ
    key = 'AERODT_DATAGO_SERVICE_KEY'
    if env.get(key):
        return
    content = _read('datago.json', env, path, home, key)
    try:
        value = content['serviceKey']
        if not isinstance(value, str) or not value.strip():
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError('datago.json needs a string "serviceKey" field') from None
    from urllib.parse import unquote
    value = value.strip()
    env[key] = unquote(value) if '%' in value else value


def configure_airspace(environ=None, home=None):
    """Whichever airspace credential exists: the portal key, or a V-World key.
    Raises with both reasons when neither does."""
    env = os.environ if environ is None else environ
    reasons = []
    for configure in (configure_datago, configure_vworld):   # configure_vworld: the V-World loader above
        try:
            configure(environ=env, home=home)
            return
        except ValueError as error:
            reasons.append(str(error))
    raise ValueError(' / '.join(reasons))
