"""Korean airspace — prohibited, restricted and danger areas, control zones and
the rest — for the map, from the national aeronautical map.

The data changes by the NOTAM cycle, not by the minute, so it is fetched once,
kept in the workspace and served from there until it is a day old. Every
provider answers in its own shape; this module turns each into one GeoJSON
FeatureCollection whose features carry the same few properties: an id, a name,
a kind from a fixed list, the vertical limits as the provider wrote them, and
the layer it came from. The display draws from those alone, so a new provider
is a fetch and a property map, never a change to the map.

Providers:
- `vworld`: the 공간정보 오픈플랫폼 Data API 2.0 (api.vworld.kr/req/data), which
  carries the 국토교통부 항공정보도 layers, with a V-World key bound to a domain.
- `wfs`: any OGC WFS that returns GeoJSON, with the key passed as a query
  parameter — the shape a 공공데이터포털 인증키 is used in.

It performs requests only when asked, never at import, and every failure is
reported as a status rather than raised at the caller.
"""
import asyncio
import json
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

USER_AGENT = "AeroDT/0.1 (local dashboard; airspace display)"
REFRESH_SECONDS = 86400
# Korea and its flight information region, generously.
DEFAULT_BBOX = (122.0, 30.0, 134.0, 40.0)
VWORLD_DATA_URL = "https://api.vworld.kr/req/data"
VWORLD_PAGE_SIZE = 1000

# The kinds the map knows, in the order they are drawn (later over earlier)
# and how each reads. A provider's layer names map onto these.
KINDS = {
    "fir": "비행정보구역",
    "adiz": "방공식별구역",
    "military": "군작전구역",
    "training": "훈련구역",
    "approach": "접근관제구역",
    "control": "관제권",
    "atz": "비행장교통구역",
    "ua": "초경량비행장치공역",
    "danger": "위험구역",
    "restricted": "비행제한구역",
    "prohibited": "비행금지구역",
    "corridor": "시계비행로·한강회랑",
    "other": "기타 공역",
}
# The V-World airspace layers of the 국토교통부 항공정보도, by kind. Codes that
# the service does not know are reported, not fatal, so an unsure one costs
# a line in the status rather than the whole display.
VWORLD_LAYERS = {
    "LT_C_AISPRHC": "prohibited",
    "LT_C_AISRESC": "restricted",
    "LT_C_AISDNGC": "danger",
    "LT_C_AISCTRC": "control",
    "LT_C_AISATZC": "atz",
    "LT_C_AISUAC": "ua",
    "LT_C_AISMOAC": "military",
    "LT_C_AISTMAC": "approach",
}
# The 항공정보도 labels each feature carries: `<layer>_lbl_1` is the name,
# `_lbl_2` and `_lbl_3` the two vertical limits — in an order that differs
# between layers — and `_lbl_4`, where it exists, a note. The layer's own
# name field (`prohibited`, `restricted`) holds styled markup and is left.
LABEL_SUFFIXES = ("_lbl_1", "_lbl_2", "_lbl_3", "_lbl_4")
# How the limits say "the ground": that one is the floor, whichever slot it is in.
GROUND_WORDS = ("SFC", "GND", "SURFACE", "GROUND", "지표", "지면")
# Property names providers use for the same things.
NAME_KEYS = ("name", "nm", "air_nm", "arsp_nm", "ftr_nm", "zone_nm", "title", "label", "id")
LOWER_KEYS = ("lower", "lwr", "lwr_lmt", "low_lmt", "alt_low", "lower_limit", "floor", "lowalt", "min_alt")
UPPER_KEYS = ("upper", "upr", "upr_lmt", "up_lmt", "alt_up", "upper_limit", "ceiling", "upalt", "max_alt")
KIND_KEYS = ("kind", "type", "air_type", "arsp_ty", "zone_ty", "category", "class")
# Words in a provider's kind or name that place it, when the layer does not.
KIND_WORDS = (
    ("prohibited", ("금지", "prohibit", " p-", "p ")), ("restricted", ("제한", "restrict", " r-")),
    ("danger", ("위험", "danger", " d-")), ("control", ("관제권", "ctr", "control zone")),
    ("approach", ("접근관제", "tma", "approach")), ("atz", ("비행장교통", "atz")),
    ("ua", ("초경량", "ua "), ), ("military", ("군작전", "moa")), ("training", ("훈련", "training")),
    ("adiz", ("방공식별", "adiz")), ("fir", ("비행정보구역", "fir")), ("corridor", ("회랑", "시계비행로", "corridor")),
)


def _first(properties, keys):
    for key in keys:
        for candidate in (key, key.upper(), key.capitalize()):
            value = properties.get(candidate)
            if value is not None and str(value).strip() and not str(value).lstrip().startswith("<"):
                return str(value).strip()
    return None


def _labels(properties):
    """The `*_lbl_n` labels of a 항공정보도 feature by suffix, or an empty dict."""
    found = {}
    for key, value in properties.items():
        for suffix in LABEL_SUFFIXES:
            if str(key).lower().endswith(suffix) and value is not None and str(value).strip():
                found[suffix] = str(value).strip()
    return found


def _is_ground(text):
    words = (text or "").upper()
    return any(word in words for word in GROUND_WORDS) or words.strip() in ("0", "0FT", "0 FT")


# A label is a vertical limit when it says the ground or carries a height unit.
LIMIT_WORDS = ("FT", "AMSL", "AGL", "MSL", "HEI", "FL ", "FL")


def _is_limit(text):
    words = (text or "").upper()
    if _is_ground(words) or "UNL" in words:   # unlimited is a ceiling too
        return True
    return any(word in words for word in LIMIT_WORDS) and any(ch.isdigit() for ch in words)


def _height_value(text):
    """A rough number of feet from a limit label, for ordering two limits only:
    'FL 225' is 22500, '3 000 AGL' is 3000, words are 0."""
    digits = "".join(ch for ch in (text or "") if ch.isdigit())
    if not digits:
        return 0.0
    value = float(digits)
    return value * 100 if (text or "").upper().replace(" ", "").startswith("FL") else value


def limits_of(properties):
    """(lower, upper) as the provider wrote them: the explicit keys when a
    provider has them, otherwise the two 항공정보도 labels sorted so the one that
    says the ground — or the smaller — is the floor."""
    lower, upper = _first(properties, LOWER_KEYS), _first(properties, UPPER_KEYS)
    if lower or upper:
        return lower, upper
    labels = _labels(properties)
    pair = [labels.get(suffix) for suffix in ("_lbl_2", "_lbl_3", "_lbl_4")]
    pair = [item for item in pair if item and _is_limit(item)][:2]
    if not pair:
        return None, None
    if len(pair) == 1:
        return (pair[0], None) if _is_ground(pair[0]) else (None, pair[0])
    first, second = pair
    if _is_ground(first) and not _is_ground(second):
        return first, second
    if _is_ground(second) and not _is_ground(first):
        return second, first
    return (first, second) if _height_value(first) <= _height_value(second) else (second, first)


def note_of(properties):
    """A 항공정보도 label that is neither the name nor a limit: what the zone is for."""
    labels = _labels(properties)
    for suffix in ("_lbl_4", "_lbl_3", "_lbl_2"):
        text = labels.get(suffix)
        if text and not _is_limit(text):
            return text
    return None


def kind_of(layer_kind, properties):
    """The kind a feature is drawn as: the layer's, or read from its words."""
    if layer_kind in KINDS and layer_kind != "other":
        return layer_kind
    words = " ".join(filter(None, (_first(properties, KIND_KEYS), _first(properties, NAME_KEYS)))).lower()
    for kind, hints in KIND_WORDS:
        if any(hint.strip() in words for hint in hints):
            return kind
    return "other"


def normalise(features, layer, layer_kind="other"):
    """One provider's features as the map's: the same properties on every one.
    Anything without a polygon is left out — the map draws areas."""
    out = []
    for index, feature in enumerate(features or ()):
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") not in ("Polygon", "MultiPolygon") or not geometry.get("coordinates"):
            continue
        properties = feature.get("properties") or {}
        if not isinstance(properties, dict):
            properties = {}
        kind = kind_of(layer_kind, properties)
        labels = _labels(properties)
        name = _first(properties, NAME_KEYS) or labels.get("_lbl_1") or f"{KINDS.get(kind, kind)} {index + 1}"
        lower, upper = limits_of(properties)
        entry = {
            "type": "Feature",
            "id": f"{layer}:{feature.get('id') or _first(properties, ('id', 'fid', 'objectid', 'gid')) or index + 1}",
            "geometry": geometry,
            "properties": {"name": name, "kind": kind, "kind_label": KINDS.get(kind, KINDS["other"]),
                           "lower": lower, "upper": upper, "layer": layer},
        }
        note = note_of(properties)
        # A note that only repeats what kind of zone it is says nothing new.
        if note and note != KINDS.get(kind) and note != entry["properties"]["name"]:
            entry["properties"]["note"] = note
        out.append(entry)
    return out


def vworld_request(key, domain, layer, bbox=DEFAULT_BBOX, page=1, size=VWORLD_PAGE_SIZE):
    """The query for one page of one layer of the V-World Data API 2.0."""
    west, south, east, north = bbox
    return {"service": "data", "version": "2.0", "request": "GetFeature", "key": key, "domain": domain,
            "data": layer, "geomFilter": f"BOX({west},{south},{east},{north})", "crs": "EPSG:4326",
            "format": "json", "size": str(size), "page": str(page)}


def vworld_page(body):
    """Features and paging from one V-World answer, or a ValueError with the
    service's own words when it refused."""
    response = (body or {}).get("response") or {}
    if response.get("status") != "OK":
        error = response.get("error") or {}
        raise ValueError(f"{error.get('code', 'ERROR')}: {error.get('text', 'no detail')}")
    collection = ((response.get("result") or {}).get("featureCollection") or {})
    page = response.get("page") or {}
    current, total = int(page.get("current") or 1), int(page.get("total") or 1)
    return collection.get("features") or [], current, total


def wfs_request(key_param, key, layer):
    return {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typename": layer,
            "outputFormat": "application/json", "srsname": "EPSG:4326", key_param: key}


class AirspaceSource:
    """Fetches, keeps and reports the airspace collection.

    `config` carries `provider` ('vworld' or 'wfs'), the provider's `url`,
    `layers` (code → kind) and for the WFS shape `key_param`; `key` and
    `domain` come from the credential store. `directory` is where the answer
    is kept between runs."""

    def __init__(self, config, key, directory, *, domain="localhost", transport=None, clock=time.time,
                 timeout_seconds=30.0, refresh_seconds=REFRESH_SECONDS):
        self.config = dict(config or {})
        self.provider = str(self.config.get("provider") or "vworld").lower()
        self.key = key
        self.domain = domain
        self.directory = Path(directory)
        self.path = self.directory / "airspace.geojson"
        self.transport = transport
        self.clock = clock
        self.timeout = timeout_seconds
        self.refresh = refresh_seconds
        self.layers = dict(self.config.get("layers") or (VWORLD_LAYERS if self.provider == "vworld" else {}))
        self.state = "off" if not key else "idle"
        self.detail = "인증키 없음" if not key else "요청 전"
        self.collection = None
        self.fetched_at = None
        self.problems = []
        self._lock = asyncio.Lock()
        self._client = None
        self._load_cache()

    # ---- what is known ----------------------------------------------------
    def status(self):
        return {"state": self.state, "detail": self.detail, "provider": self.provider,
                "fetched_at": self.fetched_at, "features": len((self.collection or {}).get("features") or []),
                "layers": list(self.layers), "problems": list(self.problems)}

    def fresh(self):
        return self.fetched_at is not None and self.clock() - self.fetched_at < self.refresh

    def _load_cache(self):
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
            self.collection = {"type": "FeatureCollection", "features": stored.get("features") or []}
            self.fetched_at = float(stored.get("fetched_at") or 0) or None
            self.problems = list(stored.get("problems") or [])
            if self.collection["features"]:
                self.state, self.detail = "ready", f"저장본 · {len(self.collection['features'])}개 구역"
        except (OSError, ValueError, TypeError):
            pass

    def _save(self):
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"fetched_at": self.fetched_at, "problems": self.problems,
                                             "features": self.collection["features"]}, ensure_ascii=False),
                                 encoding="utf-8")
        except OSError:
            pass

    # ---- fetching ---------------------------------------------------------
    def _http(self):
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout, transport=self.transport, headers={"User-Agent": USER_AGENT})
        return self._client

    async def close(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _fetch_vworld(self, layer):
        url = self.config.get("url") or VWORLD_DATA_URL
        bbox = tuple(self.config.get("bbox") or DEFAULT_BBOX)
        features, page = [], 1
        while True:
            response = await self._http().get(url, params=vworld_request(self.key, self.domain, layer, bbox, page))
            response.raise_for_status()
            got, current, total = vworld_page(response.json())
            features.extend(got)
            if current >= total or not got:
                return features
            page = current + 1

    async def _fetch_wfs(self, layer):
        url = self.config.get("url")
        if not url:
            raise ValueError("url: required for the wfs provider")
        response = await self._http().get(url, params=wfs_request(self.config.get("key_param") or "serviceKey", self.key, layer))
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("type") != "FeatureCollection":
            raise ValueError("not a GeoJSON FeatureCollection")
        return body.get("features") or []

    async def fetch(self, force=False):
        """The collection, from the store when it is fresh, otherwise from the
        provider — one layer at a time, so one bad layer costs one line."""
        if not self.key:
            return self.collection or {"type": "FeatureCollection", "features": []}
        async with self._lock:
            if not force and self.fresh() and self.collection:
                return self.collection
            self.state, self.detail = "loading", "요청 중"
            features, problems = [], []
            fetcher = self._fetch_vworld if self.provider == "vworld" else self._fetch_wfs
            for layer, kind in self.layers.items():
                try:
                    features.extend(normalise(await fetcher(layer), layer, kind))
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                    problems.append(f"{layer}: {error}")
            if features or not problems:
                self.collection = {"type": "FeatureCollection", "features": features}
                self.fetched_at = self.clock()
                self.problems = problems
                self.state = "ready" if features else "empty"
                self.detail = f"{len(features)}개 구역" + (f" · {len(problems)}개 레이어 실패" if problems else "")
                self._save()
            else:
                self.state, self.detail, self.problems = "error", problems[0], problems
            return self.collection or {"type": "FeatureCollection", "features": []}
