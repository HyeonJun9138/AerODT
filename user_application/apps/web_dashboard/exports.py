"""What the Library can hand to the operator's own computer as a file.

The dashboard is one machine several people reach over the network, so the
design work living in its workspace has to be able to leave it: a file the
browser saves on whichever computer asked for it. This module decides what
those files contain and what they are called; the wire adapter only sets the
header that makes a browser save rather than display.

Each export is self-describing. A file carries when it left, what it holds
and — for the design data — the rules the numbers were generated under, so
somebody reading it a month later does not have to ask which version of the
generator drew those taxiways. Nothing here reaches for storage or the
network: the callables it is given answer for those.
"""
import json
import tempfile
import zipfile
from datetime import datetime, timezone

from data.simulation.flight_runs import STATE_EXPORT_CHUNK_BYTES

SCHEMA_VERSION = 1
SOURCE = "AeroDT Live Twin"
JSON_MEDIA = "application/json; charset=utf-8"
GEOJSON_MEDIA = "application/geo+json; charset=utf-8"
ZIP_MEDIA = "application/zip"
_ZIP_READ_BYTES = 64 * 1024


class ZipArchive:
    """A ZIP body built on a spooled temporary file and then streamed once.

    ZIP needs its central directory at the end, so it cannot be made directly
    from an HTTP iterator.  `SpooledTemporaryFile` keeps a small export in
    memory but transparently rolls a long sortie onto the server's temporary
    disk.  The file is closed and removed after the response iterator ends.
    """

    def __init__(self, entries):
        self._entries = entries

    @staticmethod
    def _write_entry(archive, name, content):
        with archive.open(name, "w") as output:
            if isinstance(content, (bytes, bytearray)):
                output.write(content)
                return
            for block in content:
                if block:
                    output.write(block)

    def __iter__(self):
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b") as file:
            with zipfile.ZipFile(file, "w", compression=zipfile.ZIP_DEFLATED,
                                 compresslevel=6) as archive:
                for name, content in self._entries():
                    self._write_entry(archive, name, content)
            file.seek(0)
            while block := file.read(_ZIP_READ_BYTES):
                yield block

# The files on offer, in the order the Library lists them. `stem` names the
# file, `format` decides the extension and the media type.
EXPORTS = [
    {"id": "vertiports", "label": "버티포트 설계", "stem": "vertiports", "format": "json",
     "note": "저장된 버티포트 정의와 각 판의 생성된 배치(FATO·게이트·유도로·충전시설). "
             "정의만 저장되고 배치는 읽을 때마다 다시 생성되므로, 정의를 그대로 다시 넣으면 같은 판이 나옵니다."},
    {"id": "routes", "label": "항로 설계", "stem": "routes", "format": "json",
     "note": "지점(위경도·고도)과 구간(방향·종류·회랑 폭), 그리고 버티포트에서 유도되는 FATO 끝점. "
             "FATO 끝점은 저장되는 값이 아니라 버티포트에서 계산된 것이라 참고용으로 함께 담습니다."},
    {"id": "network", "label": "전체 묶음 (스케줄링 전달용)", "stem": "network", "format": "json",
     "note": "버티포트와 항로를 한 파일로. 스케줄링·비행계획 담당자에게 넘기는 형태이며, "
             "각 필드의 뜻은 project_support/docs/uam_network_data_handoff.md에 적혀 있습니다."},
    {"id": "flight_run", "label": "비행 시뮬레이션 기록", "stem": "flight-run", "format": "zip",
     "note": "가장 최근 시뮬레이션 비행의 ZIP 기록입니다. 비행 정보와 계획, 매 틱 상태를 담되, "
             "긴 비행의 상태는 8 MiB 이하 JSONL 조각으로 나눕니다. 압축을 풀어 필요한 조각만 분석할 수 있습니다."},
    {"id": "airspace", "label": "공역 (GeoJSON)", "stem": "airspace", "format": "geojson",
     "note": "지도에 그리는 비행금지·제한·위험구역과 관제권 등을 GeoJSON으로. "
             "QGIS 같은 GIS 도구에서 바로 열립니다. 공역 자료를 받아둔 뒤에만 내려받을 수 있습니다."},
    # What a replayed day produced. Taken while the day is still running, these
    # are of everything up to that moment rather than of a finished run.
    {"id": "scenario_flights", "label": "비행계획 재생 · 편별 결과", "stem": "scenario-flights", "format": "csv",
     "file": "flights.csv",
     "note": "재생한 비행계획의 편마다 한 줄. 계획된 출발·착륙 시각과 실제로 그렇게 된 시각, 그 차이, "
             "PSU가 준 착륙 번호와 대기한 시간, 그리고 항로가 없어 직항 회랑으로 날았는지가 들어 있습니다. "
             "엑셀에서 바로 열립니다."},
    {"id": "scenario_tracks", "label": "비행계획 재생 · 항적", "stem": "scenario-tracks", "format": "jsonl",
     "file": "tracks.jsonl",
     "note": "비행 중인 기체의 1초 간격 위치·고도·기수·속도와 그때의 비행 단계. 한 줄에 한 표본이라 "
             "큰 파일도 줄 단위로 읽을 수 있습니다. 주기 중인 기체는 기록하지 않습니다."},
    {"id": "scenario_holds", "label": "비행계획 재생 · PSU 대기", "stem": "scenario-holds", "format": "json",
     "file": "holds.json",
     "note": "착륙을 기다린 편마다 어느 버티포트에서 몇 번으로, 얼마나 기다렸는지. 대기 시간 시각화의 "
             "입력으로 쓰려고 통계와 함께 담습니다."},
]
EXPORT_IDS = tuple(item["id"] for item in EXPORTS)


def _now(clock=None):
    return datetime.fromtimestamp(clock(), timezone.utc) if clock else datetime.now(timezone.utc)


def filename(kind, when):
    """`aerodt-routes-20260910.json`: what it is and the day it left, so two
    downloads a week apart do not overwrite each other in a downloads folder."""
    item = next((entry for entry in EXPORTS if entry["id"] == kind), None)
    if item is None:
        raise ValueError(f"kind: one of {', '.join(EXPORT_IDS)}")
    return f"aerodt-{item['stem']}-{when.strftime('%Y%m%d')}.{item['format']}"


MEDIA_TYPES = {"geojson": GEOJSON_MEDIA, "json": JSON_MEDIA, "zip": ZIP_MEDIA,
               "csv": "text/csv; charset=utf-8", "jsonl": "application/x-ndjson; charset=utf-8"}


def media_type(kind):
    item = next((entry for entry in EXPORTS if entry["id"] == kind), None)
    return MEDIA_TYPES.get(item["format"], JSON_MEDIA) if item else JSON_MEDIA


def scenario_file(kind):
    """The recorded file a scenario export hands over, or None for the rest."""
    item = next((entry for entry in EXPORTS if entry["id"] == kind), None)
    return (item or {}).get("file")


class Exports:
    """The catalogue and the documents.

    Every argument is a callable answering the live data, so this class holds
    no state of its own and an export is always of what is stored now:
    `vertiports()` the wire-shaped vertiports (definition plus layout),
    `routes()` the route network, `route_options()` and `vertiport_options()`
    the rules those were built under, and `airspace()` the collection with its
    status, or None when no airspace credential is configured.
    """

    def __init__(self, *, vertiports, routes, route_options, vertiport_options, airspace=None,
                 flight_runs=None, scenario=None, clock=None):
        self._vertiports = vertiports
        self._routes = routes
        self._route_options = route_options
        self._vertiport_options = vertiport_options
        self._airspace = airspace
        # The stored simulation runs: list(), plan(id) and states(id).
        self._flight_runs = flight_runs
        # The scheduled day being replayed, if one is loaded: export(name) and
        # export_summary(name).
        self._scenario = scenario
        self._clock = clock

    # ---- what is on offer -------------------------------------------------
    def describe(self):
        """Every export with what it would contain right now, so the Library
        can say '버티포트 18개' before anything is downloaded. An export with
        nothing behind it is listed as unavailable rather than hidden: the
        operator should see that the airspace file exists and why it is empty."""
        when = _now(self._clock)
        items = []
        for entry in EXPORTS:
            summary, available = self._summary(entry["id"])
            items.append({**{key: entry[key] for key in ("id", "label", "note", "format")},
                          "filename": filename(entry["id"], when),
                          "summary": summary, "available": available})
        return {"schema_version": SCHEMA_VERSION, "exports": items}

    def _summary(self, kind):
        try:
            recorded = scenario_file(kind)
            if recorded:
                if self._scenario is None:
                    return "비행계획 재생이 연결되지 않음", False
                return self._scenario.export_summary(recorded)
            if kind == "vertiports":
                count = len(self._vertiports())
                return f"버티포트 {count}개", count > 0
            if kind == "routes":
                network = self._routes()
                nodes, links = len(network.get("nodes") or ()), len(network.get("links") or ())
                return f"지점 {nodes}개 · 구간 {links}개", nodes > 0 or links > 0
            if kind == "network":
                network = self._routes()
                return (f"버티포트 {len(self._vertiports())}개 · 지점 {len(network.get('nodes') or ())}개 · "
                        f"구간 {len(network.get('links') or ())}개"), True
            if kind == "flight_run":
                latest = self._latest_run()
                if latest is None:
                    return "기록된 비행 없음", False
                summary = latest.get("summary") or {}
                return f"{latest.get('label') or latest.get('run_id')} · 상태 {summary.get('states', 0)}개", True
            collection = self._airspace_collection()
            if collection is None:
                return "공역 자료 없음 (인증 설정 필요)", False
            count = len(collection.get("features") or ())
            return f"{count}개 구역", count > 0
        except Exception:
            # A store that cannot be read is a summary problem, never a crash
            # of the whole panel: the file itself will report the same.
            return "확인할 수 없음", False

    def _latest_run(self):
        if self._flight_runs is None:
            return None
        listed = self._flight_runs.list() or []
        return listed[0] if listed else None

    def _airspace_collection(self):
        if self._airspace is None:
            return None
        answer = self._airspace()
        return None if answer is None else answer

    # ---- the files --------------------------------------------------------
    def build(self, kind):
        """(filename, media_type, document) for `kind`, or None when there is
        nothing to hand over (the airspace with no credential)."""
        if kind not in EXPORT_IDS:
            raise ValueError(f"kind: one of {', '.join(EXPORT_IDS)}")
        when = _now(self._clock)
        stamp = when.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        recorded = scenario_file(kind)
        if recorded:
            # These are files the day already wrote, handed over as they are
            # rather than wrapped: a CSV inside a JSON envelope is not a CSV.
            text = None if self._scenario is None else self._scenario.export(recorded)
            return None if text is None else (filename(kind, when), media_type(kind), text)
        document = self._document(kind, stamp)
        if document is None:
            return None
        return filename(kind, when), media_type(kind), document

    def _document(self, kind, stamp):
        head = {"schema_version": SCHEMA_VERSION, "kind": kind, "exported_at": stamp, "source": SOURCE}
        if kind == "vertiports":
            records = self._vertiports()
            return {**head, "count": len(records),
                    "design_rules": self._vertiport_options(),
                    "vertiports": records}
        if kind == "routes":
            network = self._routes()
            return {**head, "counts": self._counts(network),
                    "segments": self._route_options(),
                    "nodes": network.get("nodes") or [],
                    "links": network.get("links") or [],
                    "fatos": network.get("fatos") or []}
        if kind == "flight_run":
            latest = self._latest_run()
            if latest is None:
                return None
            run_id = latest["run_id"]
            plan = self._flight_runs.plan(run_id)
            return ZipArchive(lambda: self._flight_run_entries(head, latest, plan))
        if kind == "network":
            network = self._routes()
            records = self._vertiports()
            return {**head,
                    "counts": {"vertiports": len(records), **self._counts(network)},
                    "reference": "project_support/docs/uam_network_data_handoff.md",
                    "design_rules": self._vertiport_options(),
                    "segments": self._route_options(),
                    "vertiports": records,
                    "routes": {"nodes": network.get("nodes") or [], "links": network.get("links") or [],
                               "fatos": network.get("fatos") or []}}
        collection = self._airspace_collection()
        if collection is None:
            return None
        # GeoJSON keeps its own shape; the metadata rides alongside as extra
        # top-level members, which the format allows and readers ignore.
        return {"type": "FeatureCollection", "exported_at": stamp, "source": SOURCE,
                "kind": kind, "features": collection.get("features") or []}

    @staticmethod
    def _counts(network):
        return {"nodes": len(network.get("nodes") or ()), "links": len(network.get("links") or ()),
                "fatos": len(network.get("fatos") or ())}

    def _flight_run_entries(self, head, run, plan):
        """The files inside a single-sortie archive.

        State chunks deliberately retain JSONL rather than becoming JSON
        arrays: tools can consume one chunk line by line and an archival run
        never expands to one enormous object in browser or server memory.
        """
        run_id = run["run_id"]
        manifest = {**head, "run": run, "plan_file": "plan.json",
                    "state_format": "JSON Lines (UTF-8; one state per row)",
                    "state_files": "states/part-*.jsonl",
                    "state_chunk_max_bytes": STATE_EXPORT_CHUNK_BYTES}
        guide = (
            "AeroDT 비행 시뮬레이션 기록\n\n"
            "manifest.json: 내보내기 시각, 비행 정보, 파일 형식\n"
            "plan.json: 이 소티가 따른 비행 계획\n"
            "states/part-*.jsonl: 시간 순 StateSnapshot. 한 줄이 한 상태입니다.\n\n"
            f"상태 파일은 비압축 기준 최대 {STATE_EXPORT_CHUNK_BYTES // (1024 * 1024)} MiB씩 나뉩니다. "
            "각 조각은 독립적인 JSONL 파일이므로 필요한 구간만 읽을 수 있습니다.\n"
        )
        yield "README.txt", guide.encode("utf-8")
        yield "manifest.json", self._json_bytes(manifest)
        yield "plan.json", self._json_bytes(plan)
        chunks = iter(self._state_chunks(run_id))
        first = next(chunks, None)
        if first is None:
            yield "states/part-00001.jsonl", b""
            return
        yield "states/part-00001.jsonl", first
        for number, chunk in enumerate(chunks, start=2):
            yield f"states/part-{number:05d}.jsonl", chunk

    def _state_chunks(self, run_id):
        chunked = getattr(self._flight_runs, "state_chunks", None)
        if callable(chunked):
            yield from chunked(run_id, max_bytes=STATE_EXPORT_CHUNK_BYTES)
            return
        # Kept for small test/demonstration stores that predate state_chunks.
        # Production FlightRuns always takes the bounded, on-disk route above.
        pending = bytearray()
        for state in self._flight_runs.states(run_id):
            line = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
            if pending and len(pending) + len(line) > STATE_EXPORT_CHUNK_BYTES:
                yield bytes(pending)
                pending.clear()
            pending.extend(line)
        if pending:
            yield bytes(pending)

    @staticmethod
    def _json_bytes(document):
        return (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
