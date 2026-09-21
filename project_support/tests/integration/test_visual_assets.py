"""Static visual assets: no simulator or ICDCDT imports."""
import importlib.util
import json
import struct
import tempfile
import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "asset_library", ROOT / "project_support/tools/visual_assets/asset_library.py")
LIB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIB)
sys.modules["asset_library"] = LIB
FETCH_SPEC = importlib.util.spec_from_file_location("fetch_public_assets", ROOT / "project_support/tools/visual_assets/fetch_public_assets.py")
FETCH = importlib.util.module_from_spec(FETCH_SPEC)
FETCH_SPEC.loader.exec_module(FETCH)


def glb(doc):
    body = json.dumps(doc).encode()
    body += b" " * (-len(body) % 4)
    return struct.pack("<4sII", b"glTF", 2, 20 + len(body)) + struct.pack("<I4s", len(body), b"JSON") + body


class VisualAssetTests(unittest.TestCase):
    def test_flight_variants_keep_sources_and_project_separate_rigs(self):
        import hashlib
        from digital_twin.model_library.visual_catalog import read_visual_catalog
        root = ROOT / 'digital_twin/model_library/visual_assets'
        catalog = {a['asset_id']: a for a in read_visual_catalog(root)['assets']}
        for identifier, count in [('joby_s4', 6), ('kp2a', 4), ('x_57', 2), ('amvlab_evtol', 8)]:
            directory = root / 'aircraft/civilian' / identifier
            meta = json.loads((directory / 'asset.json').read_text(encoding='utf-8'))
            flight = meta['flight_visual']
            self.assertEqual(hashlib.sha256((directory / 'model.glb').read_bytes()).hexdigest(), meta['model']['sha256'])
            self.assertEqual(flight['source_sha256'], meta['model']['sha256'])
            self.assertEqual(hashlib.sha256((directory / flight['path']).read_bytes()).hexdigest(), flight['sha256'])
            self.assertTrue(catalog[identifier]['uri'].endswith('/model.glb'))
            self.assertTrue(catalog[identifier]['flight_visual']['uri'].endswith('/flight_model.glb'))
            self.assertEqual(len(catalog[identifier]['flight_visual']['rotors']['nodes']), count)
            doc = LIB.read_glb((directory / flight['path']).read_bytes())
            self.assertFalse(doc.get('skins'), 'flight rig is static geometry plus explicit node hinges')

    def test_passenger_prototype_is_self_contained_and_not_a_satellite(self):
        from digital_twin.model_library.visual_catalog import read_visual_catalog
        root = ROOT / 'digital_twin/model_library/visual_assets'
        item = next(a for a in read_visual_catalog(root)['assets'] if a['asset_id'] == 'kenney_blocky_person_b')
        self.assertEqual(item['kind'], 'person')
        doc = LIB.read_glb((root / 'people/civilian/kenney_blocky_person_b/model.glb').read_bytes())
        self.assertTrue({'idle', 'walk', 'sit'} <= {a['name'] for a in doc['animations']})
        self.assertTrue(all('uri' not in image for image in doc['images']))

    def test_people_variants_keep_distinct_textures_and_boarding_clips(self):
        root = ROOT / 'digital_twin/model_library/visual_assets/people/civilian'
        hashes = set()
        for variant in 'abcefijkmpq':
            directory = root / f'kenney_blocky_person_{variant}'
            metadata = json.loads((directory / 'asset.json').read_text(encoding='utf-8'))
            hashes.add(metadata['model']['sha256'])
            doc = LIB.read_glb((directory / 'model.glb').read_bytes())
            self.assertTrue({'idle', 'walk', 'sit'} <= {a['name'] for a in doc['animations']})
            self.assertTrue(all('uri' not in image for image in doc['images']))
            self.assertEqual(metadata['rights']['label'], 'CC0-1.0')
        self.assertEqual(len(hashes), 11)

    def test_glb_parses(self):
        self.assertEqual(LIB.read_glb(glb({"asset": {"version": "2.0"}}))["asset"]["version"], "2.0")

    def test_truncation_rejected(self):
        with self.assertRaises(ValueError):
            LIB.read_glb(glb({"asset": {"version": "2.0"}})[:-4])

    def test_external_resource_rejected(self):
        for uri in ["texture.png", "https://example.org/a.bin", "../secret.bin"]:
            with self.assertRaises(ValueError):
                LIB.read_glb(glb({"asset": {"version": "2.0"}, "buffers": [{"uri": uri}]}))

    def test_bad_chunk_size_rejected(self):
        raw = bytearray(glb({"asset": {"version": "2.0"}}))
        struct.pack_into("<I", raw, 12, 99999)
        with self.assertRaises(ValueError):
            LIB.read_glb(raw)

    def test_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ["../escape", "/escape", "C:/escape", "..\\escape"]:
                with self.assertRaises(ValueError):
                    LIB.safe_path(Path(tmp), name)

    def test_asset_id_rejected(self):
        with self.assertRaises(ValueError):
            LIB.check_id("../asset")

    def test_missing_texture_fallback_is_explicit(self):
        source = glb({"asset": {"version": "2.0"},
                      "images": [{"uri": "missing.tga"}], "textures": [{"source": 0}],
                      "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "baseColorFactor": [1, 0, 0, 1]}}]})
        output, removed = LIB.material_fallback(source)
        doc = LIB.read_glb(output)
        self.assertEqual(removed, ["missing.tga"])
        self.assertNotIn("baseColorTexture", doc["materials"][0]["pbrMetallicRoughness"])
        self.assertEqual(doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"], [1, 0, 0, 1])

    def test_inventory_checksum_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model.glb").write_bytes(glb({"asset": {"version": "2.0"}}))
            with self.assertRaises(ValueError):
                LIB.verify_file(root, {"path": "model.glb", "sha256": "0" * 64, "bytes": 0})

    def test_catalog_integrity(self):
        report = LIB.validate_library(ROOT / "digital_twin/model_library/visual_assets")
        self.assertGreaterEqual(report["assets"], 50)
        self.assertEqual(report["errors"], [])

    def test_repair_preserves_unrelated_materials(self):
        doc = {"asset": {"version": "2.0"}, "materials": [
            {"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "baseColorFactor": [1.0000001, 0, 0, 1]}}],
            "meshes": [{"primitives": [{"attributes": {}, "material": 0}, {"attributes": {"TEXCOORD_0": 0}, "material": 0}]}]}
        output, changes = LIB.repair_known_issues(glb(doc))
        fixed = LIB.read_glb(output)
        self.assertGreater(len(changes), 0)
        self.assertIn("baseColorTexture", fixed["materials"][0]["pbrMetallicRoughness"])
        replacement = fixed["meshes"][0]["primitives"][0]["material"]
        self.assertNotIn("baseColorTexture", fixed["materials"][replacement]["pbrMetallicRoughness"])
        self.assertEqual(fixed["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][0], 1)

    def test_normal_repair_keeps_direction(self):
        doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
               "bufferViews": [{"buffer": 0, "byteLength": 12}],
               "accessors": [{"bufferView": 0, "componentType": 5126, "count": 1, "type": "VEC3"}],
               "meshes": [{"primitives": [{"attributes": {"NORMAL": 0}}]}]}
        raw = bytearray(glb(doc)); raw += struct.pack("<I4sfff", 12, b"BIN\0", 0, 2, 0)
        struct.pack_into("<I", raw, 8, len(raw))
        out, changes = LIB.repair_known_issues(bytes(raw))
        self.assertEqual(struct.unpack_from("<fff", out, len(out) - 12), (0, 1, 0))
        self.assertTrue(changes)

    def test_public_selection_requires_both_rights_and_validation(self):
        item = {"rights": {"public_export": False}, "validation": {"gltf_validator": "passed", "browser": "passed"}}
        self.assertFalse(LIB.eligible_for_web(item))
        item["rights"]["public_export"] = True
        self.assertTrue(LIB.eligible_for_web(item))
        item["validation"]["browser"] = "not_run"
        self.assertFalse(LIB.eligible_for_web(item))

    def test_source_cache_is_revision_scoped(self):
        first = FETCH.cache_folder("nasa", "a" * 40)
        second = FETCH.cache_folder("nasa", "b" * 40)
        self.assertNotEqual(first, second)
        self.assertEqual(first.name, "a" * 40)

    def test_reimport_does_not_relax_reviewed_rights(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = glb({"asset": {"version": "2.0"}, "meshes": [{"primitives": []}]})
            meta = {"title": "Test", "source": {"url": "https://example.org", "provider": "test"},
                    "rights": {"credit": "test", "note": "Reviewed: internal only", "public_export": False}}
            LIB.add_asset(root, "test_model", "aircraft/civilian", raw, meta)
            replacement = {**meta, "rights": {**meta["rights"], "public_export": True}}
            current = LIB.add_asset(root, "test_model", "aircraft/civilian", raw, replacement)
            self.assertFalse(current["rights"]["public_export"])

    def test_asset_schema(self):
        import jsonschema
        schema = json.loads((ROOT / "digital_twin/model_library/schemas/visual_asset.schema.json").read_text(encoding="utf-8"))
        for file in (ROOT / "digital_twin/model_library/visual_assets").glob("*/*/*/asset.json"):
            jsonschema.validate(json.loads(file.read_text(encoding="utf-8")), schema)


if __name__ == "__main__":
    unittest.main()
