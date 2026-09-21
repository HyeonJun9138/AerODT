"""Turn the shared vertiport and waypoint spreadsheets into AeroDT records.

The workbooks describe a Seoul/Incheon UAM network: vertiports with a class and
a position, and waypoints joined by a comma-separated list of names. AeroDT
stores a vertiport as a *definition* the model library compiles into a layout,
and a route as explicit nodes and directed links. This tool converts one into
the other, checks every record against the real validators and hands the result
to the Data layer, which owns the files.

It reads .xlsx with the standard library alone (a workbook is a zip of XML), so
it runs on any of the repository's interpreters without a new dependency.

    python project_support/tools/import_uam_network.py \
        --vertiports vertiport.xlsx --waypoints waypoint.xlsx [--dry-run]

What the source does not say is chosen here, in one place, and printed in the
report: the sheets carry no deck design, no flight-profile phase and no
corridor width.
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.simulation.route_records import RouteRecords                     # noqa: E402
from data.simulation.vertiport_records import VertiportRecords             # noqa: E402
from digital_twin.model_library.route_network import (CORRIDOR_SEGMENT, DEFAULT_WIDTH_M, fato_endpoints,  # noqa: E402
                                                      fato_id, validate_link, validate_node)
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition  # noqa: E402

SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
FEET_TO_METRES = 0.3048

# The sheets classify a vertiport but do not design its deck. One design per
# class, chosen here so the import is reproducible and the choice is visible.
CLASS_DESIGN = {
    "hub": {"pattern": "double", "gates": 8, "platform_height_m": 12.0,
            "fatos": [{"role": "takeoff"}, {"role": "landing"}]},
    "port": {"pattern": "row", "gates": 4, "platform_height_m": 6.0,
             "fatos": [{"role": "both"}]},
}
DEFAULT_DESIGN = CLASS_DESIGN["port"]
VEHICLE_CLASS = "medium"
# Between waypoints the sheets give one altitude and no phase: a cruise corridor.
WAYPOINT_SEGMENT = CORRIDOR_SEGMENT
# A vertiport's own links leave a take-off FATO and meet a landing FATO.
DEPARTURE_SEGMENT = "C"
ARRIVAL_SEGMENT = "G"


# ---------------------------------------------------------------- reading .xlsx

def _column_index(reference):
    index = 0
    for letter in reference:
        if not letter.isalpha():
            break
        index = index * 26 + (ord(letter.upper()) - 64)
    return index - 1


def read_sheet(path, sheet=0):
    """Rows of the sheet as dictionaries keyed by the header row."""
    with zipfile.ZipFile(path) as book:
        shared = []
        if "xl/sharedStrings.xml" in book.namelist():
            for item in ElementTree.fromstring(book.read("xl/sharedStrings.xml")).findall(f"{SHEET_NS}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{SHEET_NS}t")))
        sheets = sorted(name for name in book.namelist() if name.startswith("xl/worksheets/sheet"))
        grid = ElementTree.fromstring(book.read(sheets[sheet]))
    rows = []
    for row in grid.iter(f"{SHEET_NS}row"):
        cells = {}
        for cell in row.findall(f"{SHEET_NS}c"):
            kind, value = cell.get("t"), cell.find(f"{SHEET_NS}v")
            if kind == "inlineStr":
                text = "".join(node.text or "" for node in cell.iter(f"{SHEET_NS}t"))
            elif value is None or value.text is None:
                continue
            elif kind == "s":
                text = shared[int(value.text)]
            else:
                text = value.text
            cells[_column_index(cell.get("r", ""))] = text
        rows.append(cells)
    if not rows:
        return []
    width = max((max(cells) + 1) if cells else 0 for cells in rows)
    head = [str(rows[0].get(index, "") or "").strip() for index in range(width)]
    out = []
    for cells in rows[1:]:
        item = {head[index]: cells.get(index) for index in range(width) if head[index]}
        if any(value not in (None, "") for value in item.values()):
            out.append(item)
    return out


def _links_of(value):
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


# ---------------------------------------------------------------- the conversion

def build_vertiports(rows):
    """Validated vertiport definitions, keeping the sheet's own ids.

    The deck heading comes from INR_Deg — the bearing the sheet gives on the
    inner ring, and the only orientation it carries. Everything else about the
    deck comes from CLASS_DESIGN.
    """
    records = []
    for row in rows:
        identifier = str(row.get("vertiport_id") or "").strip()
        if not identifier:
            continue
        klass = str(row.get("Class") or "").strip().lower()
        design = CLASS_DESIGN.get(klass, DEFAULT_DESIGN)
        definition = validate_definition({
            "id": identifier,
            "name": str(row.get("Vertiport 명") or "").strip(),
            "latitude": row.get("위도"), "longitude": row.get("경도"),
            "heading_deg": row.get("INR_Deg") or 0,
            "vehicle_class": VEHICLE_CLASS,
            "ground_reference": "highest",
            **design,
        })
        records.append(definition)
    return records


def build_nodes(rows):
    """Validated waypoints, numbered in sheet order. The sheets give feet; the
    records keep metres above the ground, as every altitude here does."""
    nodes = []
    for index, row in enumerate(rows, start=1):
        name = str(row.get("Waypoint 명") or "").strip()
        if not name:
            continue
        feet = row.get("고도(ft)")
        node = validate_node({
            "id": f"WP{index:03d}", "name": name,
            "latitude": row.get("위도"), "longitude": row.get("경도"),
            "altitude_m": round(float(feet) * FEET_TO_METRES, 3) if feet not in (None, "") else None,
            "altitude_reference": "agl",
        }, [item["name"] for item in nodes])
        nodes.append(node)
    return nodes


def build_links(vertiport_rows, waypoint_rows, nodes, vertiports, width_m=DEFAULT_WIDTH_M):
    """Directed links from the sheets' undirected `Link` lists.

    Between waypoints a pair is written once, however many ends declared it.
    A vertiport's own list becomes two links per waypoint — out of a take-off
    FATO and into a landing one — because a route leaves and meets a vertiport
    at its FATOs, not at the vertiport itself.
    """
    by_name = {}
    for node in nodes:
        by_name.setdefault(node["name"], node["id"])
    endpoints = {item["id"]: item for item in fato_endpoints(
        [dict(record, layout=generate_layout(record)) for record in vertiports])}
    by_id = {node["id"]: node for node in nodes}

    def fato_for(record, role):
        for fato in record["fatos"]:
            if fato["role"] in (role, "both"):
                return fato_id(record["id"], fato["id"])
        return None

    raw, unresolved, seen = [], [], set()
    for row in waypoint_rows:
        here = by_name.get(str(row.get("Waypoint 명") or "").strip())
        for name in _links_of(row.get("Link")):
            there = by_name.get(name)
            if there is None:
                unresolved.append(name)
                continue
            pair = tuple(sorted((here, there)))
            if here is None or here == there or pair in seen:
                continue
            seen.add(pair)
            raw.append({"from": pair[0], "to": pair[1], "segment": WAYPOINT_SEGMENT, "width_m": width_m})
    for row, record in zip(vertiport_rows, vertiports):
        takeoff, landing = fato_for(record, "takeoff"), fato_for(record, "landing")
        for name in _links_of(row.get("Link")):
            there = by_name.get(name)
            if there is None:
                unresolved.append(name)
                continue
            if takeoff:
                raw.append({"from": takeoff, "to": there, "segment": DEPARTURE_SEGMENT})
            if landing:
                raw.append({"from": there, "to": landing, "segment": ARRIVAL_SEGMENT})

    links = []
    for index, item in enumerate(raw, start=1):
        links.append(validate_link(dict(item, id=f"LK{index:04d}"), by_id, endpoints, links))
    return links, sorted(set(unresolved))


# ---------------------------------------------------------------- the report

def summarise(vertiports, nodes, links):
    classes = {}
    for record in vertiports:
        classes[record["pattern"]] = classes.get(record["pattern"], 0) + 1
    segments = {}
    for link in links:
        segments[link["segment"]] = segments.get(link["segment"], 0) + 1
    return {"vertiports": len(vertiports), "patterns": classes, "nodes": len(nodes),
            "links": len(links), "segments": segments}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vertiports", required=True, help="vertiport.xlsx")
    parser.add_argument("--waypoints", required=True, help="waypoint.xlsx")
    parser.add_argument("--workspace", default=str(ROOT / "data" / "workspace" / "simulation"),
                        help="where the Data layer keeps vertiports.json and routes.json")
    parser.add_argument("--width", type=float, default=DEFAULT_WIDTH_M, help="cruise corridor width in metres")
    parser.add_argument("--dry-run", action="store_true", help="convert and report, write nothing")
    parser.add_argument("--json", action="store_true", help="print the records instead of a summary")
    args = parser.parse_args(argv)

    vertiport_rows = read_sheet(args.vertiports)
    waypoint_rows = read_sheet(args.waypoints)
    vertiports = build_vertiports(vertiport_rows)
    nodes = build_nodes(waypoint_rows)
    links, unresolved = build_links(vertiport_rows, waypoint_rows, nodes, vertiports, args.width)

    report = summarise(vertiports, nodes, links)
    report["unresolved_link_names"] = unresolved
    if args.json:
        print(json.dumps({"vertiports": vertiports, "nodes": nodes, "links": links}, ensure_ascii=False, indent=2))
    if not args.dry_run:
        workspace = Path(args.workspace)
        report["vertiports_merged"] = VertiportRecords(workspace / "vertiports.json").merge(vertiports)
        report["routes_merged"] = RouteRecords(workspace / "routes.json").merge(nodes, links)
        report["workspace"] = str(workspace)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
