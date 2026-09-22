"""The vertiport and route stores count their saves, so the simulation revision
stamp can be handed out from memory while nothing has changed and is made
again the moment something has."""
import hashlib
import json

from data.simulation.route_records import RouteRecords
from data.simulation.vertiport_records import VertiportRecords


def definition(name, latitude=37.5, longitude=127.0):
    return {"name": name, "latitude": latitude, "longitude": longitude, "heading_deg": 0, "gates": 4,
            "platform_height_m": 20, "fatos": [{"role": "takeoff"}, {"role": "landing"}]}


def test_stores_count_every_save_and_nothing_else(tmp_path):
    ports = VertiportRecords(tmp_path / 'vertiports.json')
    routes = RouteRecords(tmp_path / 'routes.json')
    assert ports.version == 0 and routes.version == 0
    ports.list(); ports.get('VP-none'); routes.nodes(); routes.links()
    assert ports.version == 0 and routes.version == 0, 'reading is not a save'
    created = ports.create(definition('여의도'))
    assert ports.version == 1
    ports.update(created['id'], definition('여의도 2'))
    assert ports.version == 2
    assert ports.delete(created['id']) is not None
    assert ports.version == 3
    node = routes.create_node({"name": "영등포", "latitude": 37.515, "longitude": 126.925, "altitude_m": 304.8})
    other = routes.create_node({"name": "노량진", "latitude": 37.51, "longitude": 126.94, "altitude_m": 304.8})
    assert routes.version == 2
    link = routes.create_link({"from": node['id'], "to": other['id']})
    assert routes.version == 3
    routes.delete_link(link['id']); routes.delete_node(node['id'])
    assert routes.version == 5
    reopened = VertiportRecords(tmp_path / 'vertiports.json')
    assert reopened.version == 0, 'a fresh store starts its own count'


def stamp_of(ports, routes):
    stamp = hashlib.sha1()
    for group in (ports.list(), routes.nodes(), routes.links()):
        for record in group:
            stamp.update(json.dumps(record, sort_keys=True, ensure_ascii=False).encode("utf-8"))
        stamp.update(b"|")
    return stamp.hexdigest()[:16]


def test_the_version_pair_identifies_the_digest(tmp_path):
    """Same versions, same digest; a save moves the version and the digest."""
    ports = VertiportRecords(tmp_path / 'vertiports.json')
    routes = RouteRecords(tmp_path / 'routes.json')
    seen = {}
    def remembered():
        key = (ports.version, routes.version)
        if key not in seen:
            seen[key] = stamp_of(ports, routes)
        return seen[key]
    first = remembered()
    assert remembered() == first == stamp_of(ports, routes)
    ports.create(definition('봉천'))
    assert remembered() != first and remembered() == stamp_of(ports, routes)
    assert len(seen) == 2
