"""Importing the shared UAM spreadsheets into AeroDT records.

The sheets are data from outside the repository: a vertiport carries a class and a position but no deck
design, and links are an undirected list of names. These tests pin what the
importer decides on the sheets' behalf and prove the result is what the model
library and the Data layer already accept.
"""
import json
import zipfile

import pytest

from data.simulation.route_records import RouteRecords
from data.simulation.vertiport_records import VertiportRecords
from digital_twin.model_library.route_network import fato_id, validate_link, validate_node
from digital_twin.model_library.vertiport_layout import generate_layout
from project_support.tools.import_uam_network import (CLASS_DESIGN, build_links, build_nodes, build_vertiports,
                                                      read_sheet, summarise)

VERTIPORT_ROWS = [
    {"vertiport_id": "VP001", "Vertiport 명": "여의도", "Class": "port", "위도": 37.526513, "경도": 126.922845,
     "INR_Deg": 0, "Link": "선유도 17고지, 영등포"},
    {"vertiport_id": "VP012", "Vertiport 명": "광화문", "Class": "hub", "위도": 37.56901, "경도": 126.973604,
     "INR_Deg": 45, "Link": "금화터널"},
]
WAYPOINT_ROWS = [
    {"Waypoint 명": "선유도 17고지", "위도": 37.542307, "경도": 126.90249, "고도(ft)": 1000, "Link": "영등포"},
    {"Waypoint 명": "영등포", "위도": 37.515965, "경도": 126.907756, "고도(ft)": 1000, "Link": "선유도 17고지"},
    {"Waypoint 명": "금화터널", "위도": 37.570076, "경도": 126.951769, "고도(ft)": 1500, "Link": "없는 지점"},
]


def test_a_class_chooses_the_deck_the_sheet_does_not_describe():
    records = build_vertiports(VERTIPORT_ROWS)
    assert [item["id"] for item in records] == ["VP001", "VP012"], "the sheet's own ids are kept"
    port, hub = records
    assert port["name"] == "여의도" and port["latitude"] == 37.526513
    assert port["pattern"] == CLASS_DESIGN["port"]["pattern"] and port["gates"] == CLASS_DESIGN["port"]["gates"]
    assert [f["role"] for f in port["fatos"]] == ["both"]
    assert hub["pattern"] == CLASS_DESIGN["hub"]["pattern"] and hub["gates"] == CLASS_DESIGN["hub"]["gates"]
    assert [f["role"] for f in hub["fatos"]] == ["takeoff", "landing"]
    assert hub["heading_deg"] == 45, "the inner-ring bearing is the only orientation the sheet gives"
    assert port["ground_reference"] == "highest", "no altitude in the sheet: the deck follows the terrain"
    for record in records:                       # what the map will actually draw
        layout = generate_layout(record)
        assert layout["gates"] and layout["fatos"] and layout["chargers"]


def test_waypoint_feet_become_metres_above_the_ground_and_ids_follow_the_sheet():
    nodes = build_nodes(WAYPOINT_ROWS)
    assert [item["id"] for item in nodes] == ["WP001", "WP002", "WP003"]
    assert [item["name"] for item in nodes] == ["선유도 17고지", "영등포", "금화터널"]
    assert nodes[0]["altitude_m"] == pytest.approx(304.8, abs=1e-3)
    assert nodes[2]["altitude_m"] == pytest.approx(457.2, abs=1e-3)
    assert all(item["altitude_reference"] == "agl" for item in nodes)


def test_a_pair_is_written_once_and_a_vertiport_joins_at_its_fatos():
    vertiports = build_vertiports(VERTIPORT_ROWS)
    nodes = build_nodes(WAYPOINT_ROWS)
    links, unresolved = build_links(VERTIPORT_ROWS, WAYPOINT_ROWS, nodes, vertiports)
    assert unresolved == ["없는 지점"], "a name with no row is reported, not dropped in silence"
    pairs = [(item["from"], item["to"], item["segment"]) for item in links]
    # 선유도 17고지 and 영등포 name each other; the pair is one link, not two.
    assert sum(1 for a, b, _ in pairs if {a, b} == {"WP001", "WP002"}) == 1
    assert [seg for a, b, seg in pairs if {a, b} == {"WP001", "WP002"}] == ["F"]
    assert all(item["width_m"] for item in links if item["segment"] == "F"), "a cruise corridor has a width"
    assert all(item["width_m"] is None for item in links if item["segment"] != "F")
    # The port's single FATO takes off and lands, so its waypoint gets both.
    assert (fato_id("VP001", "F1"), "WP001", "C") in pairs
    assert ("WP001", fato_id("VP001", "F1"), "G") in pairs
    # The hub has one FATO for each direction.
    assert (fato_id("VP012", "F1"), "WP003", "C") in pairs
    assert ("WP003", fato_id("VP012", "F2"), "G") in pairs
    assert len({item["id"] for item in links}) == len(links), "every link has its own id"
    counts = summarise(vertiports, nodes, links)
    assert counts["links"] == len(links) and counts["nodes"] == 3


def _workbook(path, head, rows):
    """The smallest .xlsx the reader has to cope with: shared strings and numbers."""
    strings, order = {}, []
    for value in [*head, *(v for row in rows for v in row if isinstance(v, str))]:
        if value not in strings:
            strings[value] = len(order)
            order.append(value)
    def cell(reference, value):
        if isinstance(value, str):
            return f'<c r="{reference}" t="s"><v>{strings[value]}</v></c>'
        return f'<c r="{reference}"><v>{value}</v></c>'
    body = []
    for index, row in enumerate([head, *rows], start=1):
        cells = "".join(cell(f"{chr(65 + column)}{index}", value) for column, value in enumerate(row))
        body.append(f'<row r="{index}">{cells}</row>')
    with zipfile.ZipFile(path, "w") as book:
        book.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        book.writestr("xl/sharedStrings.xml",
                      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                      + "".join(f"<si><t>{value}</t></si>" for value in order) + "</sst>")
        book.writestr("xl/worksheets/sheet1.xml",
                      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                      f'<sheetData>{"".join(body)}</sheetData></worksheet>')


def test_the_reader_takes_a_workbook_apart_without_a_spreadsheet_library(tmp_path):
    path = tmp_path / "sheet.xlsx"
    _workbook(path, ["Waypoint 명", "위도", "고도(ft)"], [["영등포", 37.515965, 1000], ["금화터널", 37.570076, 1500]])
    rows = read_sheet(path)
    assert [row["Waypoint 명"] for row in rows] == ["영등포", "금화터널"]
    assert float(rows[0]["위도"]) == 37.515965
    assert [row["고도(ft)"] for row in rows] == ["1000", "1500"]


def test_the_data_layer_takes_the_import_and_gives_it_back_for_editing(tmp_path):
    vertiports = build_vertiports(VERTIPORT_ROWS)
    nodes = build_nodes(WAYPOINT_ROWS)
    links, _ = build_links(VERTIPORT_ROWS, WAYPOINT_ROWS, nodes, vertiports)

    store = VertiportRecords(tmp_path / "vertiports.json")
    assert store.merge(vertiports) == (2, 0)
    assert [item["id"] for item in store.list()] == ["VP001", "VP012"], "the sheet's ids survive the store"
    assert store.get("VP001")["name"] == "여의도"
    created = store.get("VP001")["created_at"]
    # Importing the same source again replaces rather than doubles, and an edit
    # through the ordinary API still works on an imported record.
    assert store.merge(vertiports) == (0, 2)
    assert len(store.list()) == 2 and store.get("VP001")["created_at"] == created
    edited = store.update("VP001", dict(vertiports[0], name="여의도 허브"))
    assert edited["name"] == "여의도 허브" and edited["id"] == "VP001"
    assert store.delete("VP012") and len(store.list()) == 1

    routes = RouteRecords(tmp_path / "routes.json")
    counts = routes.merge(nodes, links)
    assert counts == {"nodes": (3, 0), "links": (len(links), 0)}
    assert routes.merge(nodes, links) == {"nodes": (0, 3), "links": (0, len(links))}
    assert routes.node("WP001")["name"] == "선유도 17고지"
    assert routes.update_node("WP001", dict(nodes[0], name="선유도"))["name"] == "선유도"
    # Deleting a waypoint takes the links that touched it, as it does for any node.
    assert routes.delete_node("WP002") > 0
    assert all("WP002" not in (link["from"], link["to"]) for link in routes.links())

    # On disk it is the same document the Data layer writes for hand-made records.
    document = json.loads((tmp_path / "vertiports.json").read_text(encoding="utf-8"))
    assert document["schema_version"] == 1 and isinstance(document["vertiports"], list)


def test_imported_records_are_what_the_validators_would_have_produced():
    """Nothing the importer writes could not have been typed into the form."""
    vertiports = build_vertiports(VERTIPORT_ROWS)
    nodes = build_nodes(WAYPOINT_ROWS)
    links, _ = build_links(VERTIPORT_ROWS, WAYPOINT_ROWS, nodes, vertiports)
    for node in nodes:
        assert validate_node(node) == {key: value for key, value in node.items() if key != "id"} | {"id": node["id"]}
    by_id = {node["id"]: node for node in nodes}
    from digital_twin.model_library.route_network import fato_endpoints
    endpoints = {item["id"]: item for item in fato_endpoints(
        [dict(record, layout=generate_layout(record)) for record in vertiports])}
    for link in links:
        assert validate_link(link, by_id, endpoints, [other for other in links if other["id"] != link["id"]])
