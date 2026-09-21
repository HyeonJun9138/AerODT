"""Offline visual-asset intake and checks; never imports a simulator or source project."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import struct
from pathlib import Path, PureWindowsPath

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = ROOT / "digital_twin/model_library/visual_assets"
SOURCES = Path(os.environ.get(
    "AERODT_VISUAL_ASSET_SOURCES",
    Path.home() / ".aerodt" / "visual_asset_sources",
)).expanduser().resolve()


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def check_id(value: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]*", value):
        raise ValueError(f"invalid asset id: {value}")
    return value


def safe_path(root: Path, relative: str) -> Path:
    if not relative or "\\" in relative or PureWindowsPath(relative).drive:
        raise ValueError(f"unsafe path: {relative}")
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root.resolve()):
        raise ValueError(f"path outside root: {relative}")
    return path


def read_glb(raw: bytes, *, allow_external: bool = False) -> dict:
    if len(raw) < 20:
        raise ValueError("short GLB")
    magic, version, size = struct.unpack_from("<4sII", raw)
    if magic != b"glTF" or version != 2 or size != len(raw):
        raise ValueError("invalid GLB header or truncated container")
    offset, chunks = 12, []
    while offset < size:
        if offset + 8 > size:
            raise ValueError("truncated chunk header")
        length, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        if length % 4 or offset + length > size:
            raise ValueError("invalid chunk length")
        chunks.append((kind, raw[offset:offset + length]))
        offset += length
    if not chunks or chunks[0][0] != b"JSON":
        raise ValueError("first GLB chunk must be JSON")
    if sum(kind == b"JSON" for kind, _ in chunks) != 1:
        raise ValueError("multiple JSON chunks")
    doc = json.loads(chunks[0][1].decode("utf-8"))
    if doc.get("asset", {}).get("version") != "2.0":
        raise ValueError("glTF 2.0 required")
    for item in doc.get("buffers", []) + doc.get("images", []):
        uri = item.get("uri", "")
        if uri and not uri.startswith("data:") and not allow_external:
            raise ValueError(f"external resource is not self-contained: {uri}")
    return doc


def material_fallback(raw: bytes) -> tuple[bytes, list[str]]:
    """Explicit degraded copy: retain geometry/base colours, discard unavailable textures.

    Does not fetch URIs. Only used for known incomplete source assets, never silently.
    All texture maps are dropped when this fallback is selected to avoid index remapping.
    """
    doc = read_glb(raw, allow_external=True)
    removed = [x["uri"] for x in doc.get("images", [])
               if x.get("uri") and not x["uri"].startswith("data:")]
    if not removed:
        return raw, []
    if any(x.get("uri") and not x["uri"].startswith("data:") for x in doc.get("buffers", [])):
        raise ValueError("external geometry cannot use material fallback")
    if doc.get("extensionsRequired"):
        raise ValueError("manual review required for material extensions")

    def drop_maps(value):
        if isinstance(value, dict):
            for key in list(value):
                if key.endswith("Texture"):
                    del value[key]
                else:
                    drop_maps(value[key])
        elif isinstance(value, list):
            for child in value:
                drop_maps(child)

    drop_maps(doc.get("materials", []))
    for key in ("textures", "images", "samplers"):
        doc.pop(key, None)
    body = json.dumps(doc, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    old_length = struct.unpack_from("<I", raw, 12)[0]
    rest = raw[20 + old_length:]
    result = struct.pack("<4sII", b"glTF", 2, 20 + len(body) + len(rest))
    result += struct.pack("<I4s", len(body), b"JSON") + body + rest
    read_glb(result)
    return result, removed


def repair_known_issues(raw: bytes) -> tuple[bytes, list[str]]:
    """Narrow repairs for observed exporter defects; never changes vertex positions."""
    doc = read_glb(raw)
    changes = []
    json_size = struct.unpack_from("<I", raw, 12)[0]
    rest = bytearray(raw[20 + json_size:])
    normals = {p["attributes"]["NORMAL"] for m in doc.get("meshes", [])
               for p in m["primitives"] if "NORMAL" in p.get("attributes", {})}
    for index in normals:
        accessor = doc["accessors"][index]
        if "bufferView" not in accessor:
            # Compressed attributes are handled by the renderer/validator, not decoded here.
            continue
        if accessor.get("sparse") or accessor["componentType"] != 5126 or accessor["type"] != "VEC3":
            raise ValueError("normal repair supports dense float VEC3 only")
        view = doc["bufferViews"][accessor["bufferView"]]
        if view.get("buffer", 0) != 0 or rest[4:8] != b"BIN\0":
            raise ValueError("unsupported buffer layout")
        start = 8 + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        count, zeros = 0, 0
        for i in range(accessor["count"]):
            offset = start + i * view.get("byteStride", 12)
            v = struct.unpack_from("<fff", rest, offset)
            length = math.sqrt(sum(c*c for c in v))
            if not math.isfinite(length):
                raise ValueError("nonfinite normal")
            if abs(length - 1) > 1e-6:
                # Undefined zero vectors only affect lighting. Record the fallback explicitly.
                replacement = tuple(c / length for c in v) if length > 1e-12 else (0, 1, 0)
                struct.pack_into("<fff", rest, offset, *replacement)
                count += 1
                zeros += length <= 1e-12
        if count:
            accessor.pop("min", None)
            accessor.pop("max", None)
            changes.append(f"normal accessor {index}: normalized {count}, undefined +Y lighting fallback {zeros}")
    for index, material in enumerate(doc.get("materials", [])):
        pbr = material.get("pbrMetallicRoughness", {})
        colors = pbr.get("baseColorFactor")
        if colors and any(c < 0 or c > 1 for c in colors):
            if any(c < -1e-5 or c > 1 + 1e-5 for c in colors):
                raise ValueError("large colour range error requires manual review")
            pbr["baseColorFactor"] = [min(1, max(0, c)) for c in colors]
            changes.append(f"material {index}: clamped floating-point colour overshoot")
    for mi, mesh in enumerate(doc.get("meshes", [])):
        for pi, primitive in enumerate(mesh["primitives"]):
            if "material" not in primitive:
                continue
            material = copy.deepcopy(doc["materials"][primitive["material"]])
            dropped = []
            def clean_maps(value):
                if isinstance(value, dict):
                    for k in list(value):
                        child = value[k]
                        if k.endswith("Texture") and isinstance(child, dict):
                            uv = child.get("extensions", {}).get("KHR_texture_transform", {}).get("texCoord", child.get("texCoord", 0))
                            if f"TEXCOORD_{uv}" not in primitive["attributes"]:
                                dropped.append(k)
                                del value[k]
                        else:
                            clean_maps(child)
            clean_maps(material)
            if dropped:
                primitive["material"] = len(doc["materials"])
                doc["materials"].append(material)
                changes.append(f"mesh {mi} primitive {pi}: no UV; copied base-colour material without {dropped}")
    if not changes:
        return raw, []
    body = json.dumps(doc, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    out = struct.pack("<4sII", b"glTF", 2, 20 + len(body) + len(rest))
    out += struct.pack("<I4s", len(body), b"JSON") + body + rest
    read_glb(out)
    return out, changes


def prepare_model(raw: bytes, *, repair: bool = False) -> tuple[bytes, dict]:
    output, missing = material_fallback(raw)
    changes = []
    if repair:
        output, changes = repair_known_issues(output)
    if output == raw:
        return output, {"operation": "none", "note": "Original GLB bytes preserved."}
    return output, {"operation": "web_compatibility_repair", "tool": "asset_library.py",
        "source_sha256": hashlib.sha256(raw).hexdigest(), "removed_uris": missing, "changes": changes,
        "note": "Vertex positions preserved. Missing texture/UV surfaces use base colours; undefined normals use a lighting fallback. Appearance is not guaranteed identical. " + "; ".join(changes)}


def file_record(path: Path, relative: str) -> dict:
    raw = path.read_bytes()
    return {"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def verify_file(root: Path, entry: dict) -> bytes:
    raw = safe_path(root, entry["path"]).read_bytes()
    if len(raw) != entry["bytes"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        raise ValueError(f"file checksum/length mismatch: {entry['path']}")
    return raw


def add_asset(library: Path, asset_id: str, category: str, raw: bytes,
              metadata: dict, thumbnail: bytes | None = None) -> dict:
    check_id(asset_id)
    if category not in ("aircraft/civilian", "aircraft/military", "spacecraft/satellites", "people/civilian"):
        raise ValueError("unsupported category")
    doc = read_glb(raw)
    if not doc.get("meshes"):
        raise ValueError("no geometry")
    destination = safe_path(library, f"{category}/{asset_id}")
    model = destination / "model.glb"
    previous = json.loads((destination / "asset.json").read_text(encoding="utf-8")) if (destination / "asset.json").is_file() else {}
    if model.exists() and model.read_bytes() != raw:
        raise ValueError(f"refusing to overwrite changed model: {asset_id}")
    destination.mkdir(parents=True, exist_ok=True)
    model.write_bytes(raw)
    metadata = dict(metadata)
    metadata.update({"schema_version": 1, "asset_id": asset_id, "category": category,
                     "purpose": "visual_only", "model": file_record(model, "model.glb")})
    metadata["geometry"] = {
        "meshes": len(doc.get("meshes", [])), "materials": len(doc.get("materials", [])),
        "animations": len(doc.get("animations", [])), "skins": len(doc.get("skins", [])),
        "required_extensions": doc.get("extensionsRequired", []),
        "native_coordinates": "glTF right-handed +Y up; forward axis is asset-specific",
        "physical_dimensions_verified": False,
    }
    metadata.setdefault("validation", {"container": "passed", "gltf_validator": "not_run", "browser": "not_run"})
    metadata.setdefault("conversion", {"operation": "none", "note": "Original GLB bytes preserved."})
    if thumbnail is not None:
        (destination / "thumbnail.jpg").write_bytes(thumbnail)
        metadata["thumbnail"] = file_record(destination / "thumbnail.jpg", "thumbnail.jpg")
    else:
        metadata["thumbnail"] = previous.get("thumbnail")
    if previous.get("model", {}).get("sha256") == metadata["model"]["sha256"]:
        # Intake must not undo an operator's restrictive rights review.
        if previous.get("rights", {}).get("public_export") is False:
            metadata["rights"] = previous["rights"]
        metadata["validation"] = previous.get("validation", metadata["validation"])
        if previous.get("display", {}).get("browser_measured_extent"):
            metadata["display"]["browser_measured_extent"] = previous["display"]["browser_measured_extent"]
    (destination / "attribution.txt").write_text(
        metadata["rights"]["credit"] + "\n" + metadata["source"].get("url", "") + "\n"
        + metadata["rights"].get("url", "") + "\n" + metadata["rights"]["note"]
        + "\nChanges: " + metadata["conversion"]["note"] + "\n", encoding="utf-8")
    write_json(destination / "asset.json", metadata)
    return metadata


def rebuild_catalog(library: Path) -> dict:
    items, hashes = [], {}
    for file in sorted(library.glob("*/*/*/asset.json")):
        item = json.loads(file.read_text(encoding="utf-8"))
        digest = item["model"]["sha256"]
        if digest in hashes:
            raise ValueError(f"duplicate GLB: {item['asset_id']} and {hashes[digest]}")
        hashes[digest] = item["asset_id"]
        items.append({"asset_id": item["asset_id"], "metadata": file.relative_to(library).as_posix()})
    catalog = {"schema_version": 1, "assets": items}
    write_json(library / "catalog.json", catalog)
    return catalog


def eligible_for_web(item: dict) -> bool:
    return (item.get("rights", {}).get("public_export") is True
            and item.get("validation", {}).get("gltf_validator") == "passed"
            and item.get("validation", {}).get("browser") == "passed")


def validate_library(library: Path) -> dict:
    catalog = json.loads((library / "catalog.json").read_text(encoding="utf-8"))
    errors, ids, hashes, paths = [], set(), set(), set()
    for row in catalog["assets"]:
        try:
            check_id(row["asset_id"])
            if row["asset_id"] in ids:
                raise ValueError("duplicate id")
            ids.add(row["asset_id"])
            meta = safe_path(library, row["metadata"])
            paths.add(meta)
            item = json.loads(meta.read_text(encoding="utf-8"))
            if item["asset_id"] != row["asset_id"] or item["purpose"] != "visual_only":
                raise ValueError("metadata identity/purpose mismatch")
            read_glb(verify_file(meta.parent, item["model"]))
            digest = item["model"]["sha256"]
            if digest in hashes:
                raise ValueError("duplicate model bytes")
            hashes.add(digest)
            if item.get("thumbnail"):
                verify_file(meta.parent, item["thumbnail"])
            if not item["rights"].get("credit") or not (meta.parent / "attribution.txt").is_file():
                raise ValueError("missing attribution")
            if not item.get("source"):
                raise ValueError("missing provenance")
        except (ValueError, KeyError, OSError) as exc:
            errors.append(f"{row['asset_id']}: {exc}")
    if paths != {p.resolve() for p in library.glob("*/*/*/asset.json")}:
        errors.append("catalog does not match metadata files")
    return {"assets": len(catalog["assets"]), "errors": errors}


def import_icdcdt(source: Path, library: Path = LIBRARY, archive: Path = SOURCES) -> dict:
    """Copy source bytes, retain aliases, and refuse checksum failures before intake."""
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    grouped = {}
    for row in manifest["models"]:
        grouped.setdefault(row["file"], []).append(row)
    if set(grouped) != {p.name for p in source.glob("*.glb")}:
        raise ValueError("source manifest/file inventory mismatch")
    # Verify the entire source before writing any model.
    for name, rows in grouped.items():
        for row in rows:
            verify_file(source, {"path": name, "sha256": row["sha256"], "bytes": row["bytes"]})
        read_glb(safe_path(source, name).read_bytes(), allow_external=True)
    destination = archive / "icdcdt"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("manifest.json", "README.md"):
        (destination / name.lower()).write_bytes((source / name).read_bytes())
    inventory = [file_record(p, p.name) for p in sorted(source.iterdir()) if p.is_file()]
    write_json(destination / "source_inventory.json", {"files": inventory})
    for name, rows in grouped.items():
        first = rows[0]
        asset_id = Path(name).stem
        provider = manifest["sources"][first["provider"]]
        nasa = first["provider"] == "nasa"
        url = provider.get("repository", "")
        if nasa:
            url += "/blob/" + provider["commit"] + "/3D%20Models/" + first["origin"]
        rights = {"label": "NASA media guidelines" if nasa else "Project owner/provider review",
                  "credit": provider["credit"], "url": provider.get("usage_guidelines", ""),
                  "public_export": nasa,
                  "note": "NASA attribution; no endorsement. Trademarks and third-party rights remain separate."
                          if nasa else "Local project use only pending owner/provider permission review; not cleared for public redistribution."}
        metadata = {
            "title": first["label"], "source": {"provider": first["provider"], "url": url,
                "revision": provider.get("commit"), "imported_from": "icdcdt", "original_file": name},
            "rights": rights,
            "representation": "generic" if first["provider"] == "spacetwin" or asset_id == "cubesat_1u" else "mission_visualization",
            "aliases": [{k: r[k] for k in ("key", "label", "exact", "series", "family", "size_m", "orientation", "extent") if k in r} for r in rows],
            "display": {"native_extent": first.get("extent"), "reference_extent_m": first.get("size_m"),
                        "scale_basis": "ICDCDT approximate display dimensions; not certified measurements",
                        "orientation": first.get("orientation")},
        }
        original = safe_path(source, name).read_bytes()
        output, conversion = prepare_model(original, repair=asset_id in ("goes_r", "jason"))
        metadata["conversion"] = conversion
        if output != original:
            (destination / name).write_bytes(original)
        add_asset(library, asset_id, "spacecraft/satellites", output,
                  metadata, safe_path(source, first["thumbnail"]).read_bytes())
    rebuild_catalog(library)
    return validate_library(library)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-icdcdt", type=Path, metavar="MODEL_DIRECTORY")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    result = import_icdcdt(args.import_icdcdt) if args.import_icdcdt else validate_library(LIBRARY)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(bool(result["errors"]))


if __name__ == "__main__":
    main()
