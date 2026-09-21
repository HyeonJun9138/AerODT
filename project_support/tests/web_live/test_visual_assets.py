"""Static visual packages must remain original, valid and independent of physics."""
import json
import math
from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "digital_twin/model_library/visual_assets"


def catalog():
    assert (ASSETS / "catalog.json").is_file(), "visual catalogue not generated"
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    return read_visual_catalog(ASSETS)


def test_catalog_metadata_and_ownership():
    document = catalog()
    assert document["schema_version"] == 1
    assert {"generic_aircraft", "generic_satellite"} <= {x["asset_id"] for x in document["assets"]}
    for entry in (a for a in document["assets"] if a['asset_id'].startswith('generic_')):
        assert entry["temporary"] is True
        assert entry["uri"].startswith("/visual-assets/")
        model = ASSETS / entry["uri"].removeprefix("/visual-assets/")
        assert model.resolve().is_relative_to(ASSETS.resolve())
        metadata = json.loads((model.parent / "asset.json").read_text())
        assert metadata["asset_id"] == entry["asset_id"]
        assert metadata["units"] == "metres"
        assert metadata["axes"] == {"forward": "+X", "up": "+Y", "handedness": "right"}
        assert metadata["license"] == "CC0-1.0"
        assert metadata["temporary"] is True
        assert metadata["size_m"] == entry["size_m"] > 0
        assert entry["metadata_uri"] == entry["uri"].replace("model.glb", "asset.json")
        assert (model.parent / "thumbnail.svg").is_file()
        assert "original" in (model.parent / "attribution.txt").read_text().lower()
    schema = json.loads((ASSETS.parent / "schemas/procedural_visual_asset.schema.json").read_text())
    assert {"asset_id", "axes", "units", "temporary", "license"} <= set(schema["required"])


def test_glb_chunks_geometry_and_scale():
    for entry in (a for a in catalog()["assets"] if a['asset_id'].startswith('generic_')):
        payload = (ASSETS / entry["uri"].removeprefix("/visual-assets/")).read_bytes()
        magic, version, length = struct.unpack_from("<4sII", payload)
        assert (magic, version, length) == (b"glTF", 2, len(payload))
        assert len(payload) < 100_000
        json_length, chunk_type = struct.unpack_from("<II", payload, 12)
        assert chunk_type == 0x4E4F534A and json_length % 4 == 0
        gltf = json.loads(payload[20:20 + json_length])
        offset = 20 + json_length
        binary_length, chunk_type = struct.unpack_from("<II", payload, offset)
        assert chunk_type == 0x004E4942
        assert offset + 8 + binary_length == length
        binary = payload[offset + 8:]
        assert gltf["buffers"] == [{"byteLength": binary_length}]
        assert gltf["scene"] == 0
        for view in gltf["bufferViews"]:
            assert view["byteOffset"] % 4 == 0
            assert view["byteOffset"] + view["byteLength"] <= binary_length
        positions = []
        for mesh in gltf["meshes"]:
            for primitive in mesh["primitives"]:
                accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
                view = gltf["bufferViews"][accessor["bufferView"]]
                assert accessor["componentType"] == 5126 and accessor["type"] == "VEC3"
                points = list(struct.iter_unpack("<fff", binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]))
                assert len(points) == accessor["count"] and len(points) % 3 == 0
                assert all(math.isfinite(v) for p in points for v in p)
                assert accessor["min"] == [min(p[i] for p in points) for i in range(3)]
                assert accessor["max"] == [max(p[i] for p in points) for i in range(3)]
                positions.extend(points)
        spans = [max(p[i] for p in positions) - min(p[i] for p in positions) for i in range(3)]
        assert math.isclose(max(spans), entry["size_m"], rel_tol=1e-6)


def test_generation_is_reproducible(tmp_path):
    tool = ROOT / "project_support/tools/generate_live_visual_assets.py"
    assert tool.is_file(), "original asset generator missing"
    subprocess.run([sys.executable, str(tool), "--output", str(tmp_path)], check=True)
    for generated in tmp_path.rglob("*"):
        if generated.is_file() and generated.name != 'procedural_catalog.json':
            assert generated.read_bytes() == (ASSETS / generated.relative_to(tmp_path)).read_bytes()


# A scheduled day draws one shared flight rig for every cabin class. Measured,
# three of the four rigs are 7.35 m along their longest axis and the fourth is
# 8.12 m, and every airframe used to declare the same 8.123 m display extent -
# so an eight-seater was drawn the size of a two-seater, and narrower than a
# four-seater. Each airframe now says what its own class measures.
def test_each_cabin_class_declares_its_own_drawn_size_against_the_rig_it_measures():
    from digital_twin.model_library.flight_schedule import SEAT_CLASSES
    assets = {asset["asset_id"]: asset for asset in catalog()["assets"]}
    sizes = []
    for item in SEAT_CLASSES:
        asset = assets.get(item["asset_id"])
        assert asset, item["asset_id"]
        flight = asset.get("flight_visual")
        assert flight, f'{item["asset_id"]}: the day draws the flight rig, so it must be published'
        drawn, measured = flight.get("size_m"), flight.get("measured_m")
        assert drawn and measured, f'{item["asset_id"]}: a scaled rig needs both its drawn size and its own measurement'
        # The measurement is of that file, not a number somebody typed: the
        # whole reason the classes looked alike was a copied extent.
        assert abs(measured - rig_extent(item["asset_id"])) < 0.01, item["asset_id"]
        assert 0.5 <= drawn / measured <= 2.5, f'{item["asset_id"]}: {drawn}/{measured} is a scale, not a rebuild'
        # Tall enough that a person standing beside it is not the same height:
        # the rigs are flat, so a size normalised on the span alone left a
        # two-seater 1.89 m tall next to a 1.75 m passenger.
        height = rig_height(item["asset_id"]) * drawn / measured
        assert 2.4 <= height <= 5.5, f'{item["asset_id"]}: drawn {height:.2f} m tall'
        sizes.append((item["seats"], drawn))
    assert [size for _seats, size in sizes] == sorted(size for _seats, size in sizes), \
        f"a bigger cabin is drawn as the bigger aircraft: {sizes}"
    assert sizes[-1][1] >= sizes[0][1] * 1.4, f"and visibly so: {sizes}"
    # Every rig is drawn larger than the file, because every one of them is
    # authored smaller than the aircraft it stands for.
    for item in SEAT_CLASSES:
        flight = assets[item["asset_id"]]["flight_visual"]
        assert flight["size_m"] > flight["measured_m"], item["asset_id"]


def rig_height(asset_id):
    """How tall that airframe's flight rig is, from the file itself."""
    return rig_extent(asset_id, axis=1)


def rig_extent(asset_id, axis=None):
    """The longest side of that airframe's flight rig, from the file itself.

    `axis` picks one instead: 0 is the body length, 1 the height, 2 the span,
    which is how the rigs are authored (forward +X, up +Y).
    """
    import itertools
    path = ASSETS / "aircraft/civilian" / asset_id / "flight_model.glb"
    body = path.read_bytes()
    document = json.loads(body[20:20 + struct.unpack_from("<I", body, 12)[0]])
    nodes, meshes, accessors = document["nodes"], document["meshes"], document["accessors"]
    low, high = [math.inf] * 3, [-math.inf] * 3

    def matrix_of(node):
        if "matrix" in node:
            m = node["matrix"]
            return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                    [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        s = node.get("scale", [1, 1, 1])
        t = node.get("translation", [0, 0, 0])
        rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        return [[rotation[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]

    def times(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

    def walk(index, parent):
        node = nodes[index]
        world = times(parent, matrix_of(node))
        if "mesh" in node:
            for primitive in meshes[node["mesh"]]["primitives"]:
                accessor = accessors[primitive["attributes"]["POSITION"]]
                if "min" not in accessor:
                    continue
                for corner in itertools.product(*zip(accessor["min"], accessor["max"])):
                    for i in range(3):
                        value = sum(world[i][j] * corner[j] for j in range(3)) + world[i][3]
                        low[i], high[i] = min(low[i], value), max(high[i], value)
        for child in node.get("children", ()):
            walk(child, world)

    identity = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    scene = document.get("scenes", [{}])[document.get("scene", 0)]
    for root in scene.get("nodes", range(len(nodes))):
        walk(root, identity)
    sides = [high[i] - low[i] for i in range(3)]
    return sides[axis] if axis is not None else max(sides)
