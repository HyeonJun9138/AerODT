"""Takes an Unreal glTF export into the shared visual asset library.

The export already carries the model package's own part layout, so this step
only has to measure it and record where it came from. Sizes and the forward
axis are derived from the file rather than declared: the placement manifest
says where each part was put in Unreal, and the same parts in the glTF reveal
the axis mapping the exporter applied.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from asset_library import (LIBRARY, add_asset, prepare_model, rebuild_catalog,
                           read_glb, validate_library)

ROOT = Path(__file__).resolve().parents[3]
# The bytes are exactly what the Unreal exporter wrote, so provenance points at
# the preserved ProjectAirSim tree rather than at an edited copy.
PROJECTAIRSIM_COMMIT = "097429f56fee32b0edfe508820bf2323ee7f2cb2"


def glb_document(raw: bytes) -> tuple[dict, bytes]:
    doc = read_glb(raw)
    size = struct.unpack_from("<I", raw, 12)[0]
    offset = 20 + size
    body = b""
    while offset < len(raw):
        length, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        if kind == b"BIN\x00":
            body = raw[offset:offset + length]
            break
        offset += length
    return doc, body


def quaternion_matrix(q: list[float]) -> list[list[float]]:
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def accessor_bounds(doc: dict, body: bytes, accessor: dict) -> tuple[list, list]:
    """Position bounds, decoded when the exporter left min/max off."""
    if "min" in accessor and "max" in accessor:
        return accessor["min"], accessor["max"]
    view = doc["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride") or 12
    low = [math.inf] * 3
    high = [-math.inf] * 3
    for index in range(accessor["count"]):
        point = struct.unpack_from("<3f", body, start + index * stride)
        for axis in range(3):
            low[axis] = min(low[axis], point[axis])
            high[axis] = max(high[axis], point[axis])
    return low, high


def scene_bounds(doc: dict, body: bytes = b"") -> tuple[list[float], list[float], int]:
    """Axis-aligned bounds of every mesh node, in the file's own units."""
    low = [math.inf] * 3
    high = [-math.inf] * 3
    triangles = 0
    for node in doc.get("nodes", []):
        if "mesh" not in node:
            continue
        translation = node.get("translation", [0.0, 0.0, 0.0])
        rotation = quaternion_matrix(node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
        scale = node.get("scale", [1.0, 1.0, 1.0])
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
            corner_min, corner_max = accessor_bounds(doc, body, accessor)
            indices = primitive.get("indices")
            if indices is not None:
                triangles += doc["accessors"][indices]["count"] // 3
            for bit in range(8):
                corner = [corner_max[axis] if bit >> axis & 1 else corner_min[axis]
                          for axis in range(3)]
                scaled = [corner[axis] * scale[axis] for axis in range(3)]
                world = [
                    sum(rotation[axis][k] * scaled[k] for k in range(3)) + translation[axis]
                    for axis in range(3)
                ]
                for axis in range(3):
                    low[axis] = min(low[axis], world[axis])
                    high[axis] = max(high[axis], world[axis])
    if not all(map(math.isfinite, low + high)):
        raise ValueError("the export has no positioned geometry")
    return low, high, triangles


def axis_mapping(doc: dict, placements: list[dict], scale: float) -> dict:
    """Which glTF axis each Unreal axis became, measured from a placed part.

    A part that sits away from the origin on all three Unreal axes pins the
    mapping exactly; guessing it would make every heading on the map wrong.
    """
    by_name = {node.get("name", ""): node for node in doc.get("nodes", [])}
    for index, placement in enumerate(placements):
        unreal = [value * scale for value in placement["unreal_location_cm"]]
        if min(abs(value) for value in unreal) < 1e-3:
            continue
        node = next((by_name[name] for name in by_name
                     if name.endswith(placement["link"])), None)
        if node is None or "translation" not in node:
            continue
        target = node["translation"]
        mapping = {}
        for source_axis, value in enumerate(unreal):
            for gltf_axis, exported in enumerate(target):
                if abs(abs(exported) - abs(value)) < 1e-3:
                    mapping["XYZ"[source_axis]] = (
                        ("+" if math.copysign(1, exported) == math.copysign(1, value) else "-")
                        + "XYZ"[gltf_axis])
                    break
        if len(mapping) == 3 and len(set(v[1] for v in mapping.values())) == 3:
            return {"measured_from_link": placement["link"], "unreal_to_gltf": mapping}
    raise ValueError("could not measure the Unreal-to-glTF axis mapping")


def build_metadata(doc: dict, placements: list[dict], manifest: dict,
                   package_relative: str, body: bytes = b"") -> dict:
    low, high, triangles = scene_bounds(doc, body)
    extents = [high[axis] - low[axis] for axis in range(3)]
    mapping = axis_mapping(doc, placements, manifest["export_uniform_scale"])
    forward = mapping["unreal_to_gltf"]["X"]  # Unreal +X is the vehicle nose.
    up = mapping["unreal_to_gltf"]["Z"]
    longest = max(extents)
    return {
        "title": "ProjectAirSim AirTaxi (quad tiltrotor UAM)",
        "source": {
            "provider": "microsoft/projectairsim",
            "url": "https://github.com/microsoft/ProjectAirSim",
            "revision": PROJECTAIRSIM_COMMIT,
            "original_file": "unreal/Blocks/Plugins/Drone/Content/AirTaxi/"
                             "{AirTaxi_Fuselage,AirTaxi_Shroud,AirTaxi_Rotor}.uasset",
            "note": "Assembled from the AeroDT model package " + package_relative
                    + " and exported with Unreal " + manifest.get("unreal_engine", "")
                    + " glTF exporter.",
        },
        "rights": {
            "label": "MIT",
            "url": "https://github.com/microsoft/ProjectAirSim/blob/main/LICENSE",
            "credit": "Microsoft Corporation / ProjectAirSim",
            "public_export": True,
            "note": "MIT licence; the copyright and permission notice must travel with "
                    "the model. Sample content, not a certified vehicle geometry.",
        },
        "representation": "specific",
        "aliases": ["aerodt_airtaxi", "uam_tiltrotor"],
        "display": {
            "native_extent": longest,
            "reference_extent_m": longest,
            "scale_basis": "metres; measured from the export bounding box "
                           "(exporter uniform scale "
                           + repr(manifest["export_uniform_scale"]) + ")",
            "forward_axis": forward,
            "up_axis": up,
            "extent_m": {"length": extents[0], "height": extents[1], "width": extents[2]},
            "axis_mapping": mapping,
            "part_count": len(placements),
        },
        "conversion": {
            "operation": "unreal_gltf_export",
            "tool": "project_support/tools/visual_assets/export_unreal_vehicle_gltf.py",
            "note": "Unreal glTF exporter output, unmodified. Textures were written as "
                    "JPEG quality " + str(manifest.get("texture_options", {}).get(
                        "texture_image_quality", "?"))
                    + " by the exporter; lossless PNG produced a 41 MB file. Geometry and "
                      "part placement come from the model package and are not edited here.",
        },
        "validation": {"container": "passed", "gltf_validator": "not_run", "browser": "not_run"},
        "geometry_note": {"rendered_triangles_estimate": triangles},
    }


def compact_document(doc: dict, body: bytes) -> tuple[bytes, int, int]:
    """Drops accessors and buffer views nothing references any more.

    The validator checks every accessor in the file, not only the ones that are
    drawn, so primitives emptied by the reducer keep failing it even after they
    are unhooked. Removing them means renumbering, which is what this does; no
    kept vertex is touched.
    """
    used_accessors: set[int] = set()
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            used_accessors.update(primitive.get("attributes", {}).values())
            if primitive.get("indices") is not None:
                used_accessors.add(primitive["indices"])
            for target in primitive.get("targets", []):
                used_accessors.update(target.values())
    for skin in doc.get("skins", []):
        if skin.get("inverseBindMatrices") is not None:
            used_accessors.add(skin["inverseBindMatrices"])
    for animation in doc.get("animations", []):
        for sampler in animation.get("samplers", []):
            used_accessors.update(
                value for value in (sampler.get("input"), sampler.get("output"))
                if value is not None)

    accessors = doc.get("accessors", [])
    kept_accessors = sorted(used_accessors)
    accessor_map = {old: new for new, old in enumerate(kept_accessors)}

    used_views = {accessors[i]["bufferView"] for i in kept_accessors
                  if "bufferView" in accessors[i]}
    for image in doc.get("images", []):
        if "bufferView" in image:
            used_views.add(image["bufferView"])
    views = doc.get("bufferViews", [])
    kept_views = sorted(used_views)
    view_map = {old: new for new, old in enumerate(kept_views)}

    new_body = bytearray()
    new_views = []
    for old in kept_views:
        view = dict(views[old])
        start = view.get("byteOffset", 0)
        chunk = body[start:start + view["byteLength"]]
        new_body += b"\x00" * (-len(new_body) % 4)
        view["byteOffset"] = len(new_body)
        new_body += chunk
        view["buffer"] = 0
        new_views.append(view)

    new_accessors = []
    for old in kept_accessors:
        accessor = dict(accessors[old])
        if "bufferView" in accessor:
            accessor["bufferView"] = view_map[accessor["bufferView"]]
        new_accessors.append(accessor)

    doc["accessors"] = new_accessors
    doc["bufferViews"] = new_views
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {name: accessor_map[index]
                                       for name, index in primitive["attributes"].items()}
            if primitive.get("indices") is not None:
                primitive["indices"] = accessor_map[primitive["indices"]]
            if primitive.get("targets"):
                primitive["targets"] = [
                    {name: accessor_map[index] for name, index in target.items()}
                    for target in primitive["targets"]]
    for skin in doc.get("skins", []):
        if skin.get("inverseBindMatrices") is not None:
            skin["inverseBindMatrices"] = accessor_map[skin["inverseBindMatrices"]]
    for animation in doc.get("animations", []):
        for sampler in animation.get("samplers", []):
            for key in ("input", "output"):
                if sampler.get(key) is not None:
                    sampler[key] = accessor_map[sampler[key]]
    for image in doc.get("images", []):
        if "bufferView" in image:
            image["bufferView"] = view_map[image["bufferView"]]
    doc["buffers"] = [{"byteLength": len(new_body)}]
    return bytes(new_body), len(accessors) - len(new_accessors), len(views) - len(new_views)


def sanitise_reduced_export(raw: bytes) -> tuple[bytes, list[str]]:
    """Narrow repairs for what Unreal's mesh reducer leaves behind.

    Reducing a CAD mesh with many small material sections empties some of them
    outright, and the exporter then writes zero-count accessors, omits position
    bounds and emits denormalised normals. None of that is recoverable content,
    so the repairs here only drop primitives that draw nothing, describe the
    bounds that are already implied by the vertex data, and renormalise
    normals. No vertex position is moved.
    """
    doc, body = glb_document(raw)
    body = bytearray(body)
    changes: list[str] = []

    dropped = 0
    for mesh in doc.get("meshes", []):
        kept = []
        for primitive in mesh["primitives"]:
            position = doc["accessors"][primitive["attributes"]["POSITION"]]
            indices = primitive.get("indices")
            empty = position.get("count", 0) == 0 or (
                indices is not None and doc["accessors"][indices].get("count", 0) == 0)
            if empty:
                dropped += 1
            else:
                kept.append(primitive)
        mesh["primitives"] = kept
    if dropped:
        changes.append("dropped %d primitives that the reducer emptied" % dropped)
    if any(not mesh["primitives"] for mesh in doc.get("meshes", [])):
        raise ValueError("a mesh lost every primitive; the reduction was too severe")

    described = 0
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
            if "min" in accessor and "max" in accessor:
                continue
            low, high = accessor_bounds(doc, bytes(body), accessor)
            accessor["min"] = [float(value) for value in low]
            accessor["max"] = [float(value) for value in high]
            described += 1
    if described:
        changes.append("computed position bounds for %d accessors" % described)

    # Secondary UV sets and tangents from a CAD import routinely carry NaN.
    # They are not sampled by any resolved material here, and a channel whose
    # values are not numbers cannot be repaired into meaningful ones, so the
    # broken channel is removed rather than guessed at. TEXCOORD_0 is never
    # dropped: if that one is broken the export is not usable and should fail.
    COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    droppable = set()
    checked: dict[int, bool] = {}
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            for name, index in list(primitive["attributes"].items()):
                if name in ("POSITION", "NORMAL", "TEXCOORD_0"):
                    continue
                if index not in checked:
                    accessor = doc["accessors"][index]
                    usable = True
                    if ("bufferView" in accessor and not accessor.get("sparse")
                            and accessor["componentType"] == 5126):
                        view = doc["bufferViews"][accessor["bufferView"]]
                        width = COMPONENTS[accessor["type"]]
                        stride = view.get("byteStride") or 4 * width
                        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                        for item in range(accessor["count"]):
                            values = struct.unpack_from("<%df" % width, body,
                                                        start + item * stride)
                            if not all(map(math.isfinite, values)):
                                usable = False
                                break
                    checked[index] = usable
                if not checked[index]:
                    droppable.add(name)
                    del primitive["attributes"][name]
    if droppable:
        changes.append("dropped vertex channels the reducer left invalid: "
                       + ", ".join(sorted(droppable)))
        # glTF requires indexed semantics to run 0, 1, 2 without gaps, so the
        # surviving UV sets are renumbered after a broken one is removed.
        renumbered = 0
        for mesh in doc.get("meshes", []):
            for primitive in mesh["primitives"]:
                coords = sorted(
                    (int(name.rsplit("_", 1)[1]), name)
                    for name in primitive["attributes"] if name.startswith("TEXCOORD_"))
                for position, (original, name) in enumerate(coords):
                    if original == position:
                        continue
                    primitive["attributes"]["TEXCOORD_%d" % position] = (
                        primitive["attributes"].pop(name))
                    renumbered += 1
        if renumbered:
            changes.append("renumbered %d texture coordinate sets to stay contiguous"
                           % renumbered)

    # The reducer leaves zero-length tangents behind. Dropping the channel is
    # not an option because the material still needs a tangent space, so the
    # degenerate ones are replaced with a valid direction; only normal-map
    # orientation on those few vertices is affected.
    tangents = {p["attributes"]["TANGENT"] for m in doc.get("meshes", [])
                for p in m["primitives"] if "TANGENT" in p.get("attributes", {})}
    repaired = 0
    for index in sorted(tangents):
        accessor = doc["accessors"][index]
        if ("bufferView" not in accessor or accessor.get("sparse")
                or accessor["componentType"] != 5126 or accessor["type"] != "VEC4"):
            continue
        view = doc["bufferViews"][accessor["bufferView"]]
        stride = view.get("byteStride") or 16
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        for item in range(accessor["count"]):
            offset = start + item * stride
            x, y, z, w = struct.unpack_from("<4f", body, offset)
            length = math.sqrt(x * x + y * y + z * z)
            if math.isfinite(length) and abs(length - 1.0) <= 1e-6:
                continue
            if math.isfinite(length) and length > 1e-12:
                x, y, z = x / length, y / length, z / length
            else:
                x, y, z = 1.0, 0.0, 0.0
            if w not in (1.0, -1.0):
                w = 1.0
            struct.pack_into("<4f", body, offset, x, y, z, w)
            repaired += 1
    if repaired:
        changes.append("repaired %d degenerate tangents" % repaired)

    normals = {p["attributes"]["NORMAL"] for m in doc.get("meshes", [])
               for p in m["primitives"] if "NORMAL" in p.get("attributes", {})}
    fixed = degenerate = 0
    for index in sorted(normals):
        accessor = doc["accessors"][index]
        if "bufferView" not in accessor or accessor.get("sparse"):
            continue
        if accessor["componentType"] != 5126 or accessor["type"] != "VEC3":
            continue
        view = doc["bufferViews"][accessor["bufferView"]]
        stride = view.get("byteStride") or 12
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        for item in range(accessor["count"]):
            offset = start + item * stride
            vector = struct.unpack_from("<3f", body, offset)
            length = math.sqrt(sum(value * value for value in vector))
            if math.isfinite(length) and abs(length - 1.0) <= 1e-6:
                continue
            if math.isfinite(length) and length > 1e-12:
                replacement = tuple(value / length for value in vector)
            else:
                # An undefined normal only affects lighting; +Y is the same
                # fallback the shared library uses.
                replacement = (0.0, 1.0, 0.0)
                degenerate += 1
            struct.pack_into("<3f", body, offset, *replacement)
            fixed += 1
    if fixed:
        changes.append("renormalised %d normals (%d undefined, +Y lighting fallback)"
                       % (fixed, degenerate))

    body_bytes, lost_accessors, lost_views = compact_document(doc, bytes(body))
    body = bytearray(body_bytes)
    if lost_accessors or lost_views:
        changes.append("removed %d unreferenced accessors and %d buffer views"
                       % (lost_accessors, lost_views))

    if not changes:
        return raw, []
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    body_bytes = bytes(body)
    body_bytes += b"\x00" * (-len(body_bytes) % 4)
    out = struct.pack("<4sII", b"glTF", 2,
                      12 + 8 + len(text) + 8 + len(body_bytes))
    out += struct.pack("<I4s", len(text), b"JSON") + text
    out += struct.pack("<I4s", len(body_bytes), b"BIN\x00") + body_bytes
    read_glb(out)
    return out, changes


def build_metadata_from_spec(doc: dict, manifest: dict, spec: dict,
                             body: bytes) -> dict:
    """Metadata for a single mesh whose provenance the operator supplies.

    A one-part export placed at the origin cannot reveal the axis mapping the
    way an assembly does, and an arbitrary source says nothing about its unit
    convention, so both stay whatever the spec declares - "unverified" unless
    someone actually looked at the rendered model.
    """
    low, high, triangles = scene_bounds(doc, body)
    extents = [high[axis] - low[axis] for axis in range(3)]
    display = {
        "native_extent": max(extents),
        "reference_extent_m": spec.get("reference_extent_m"),
        "scale_basis": spec.get(
            "scale_basis", "export units; source unit convention not verified"),
        "forward_axis": spec.get("forward_axis", "unverified"),
        "up_axis": spec.get("up_axis", "unverified"),
        "extent": {"x": extents[0], "y": extents[1], "z": extents[2]},
        "part_count": len(manifest.get("placements", [])),
    }
    note = spec.get("conversion_note", "")
    reduction = manifest.get("reduction") or {}
    if reduction.get("percent_triangles"):
        note += (" Geometry was reduced to %g%% of the source triangle count by "
                 "the Unreal mesh reducer and exported from that level of detail."
                 % (reduction["percent_triangles"] * 100))
    return {
        "title": spec["title"],
        "source": spec["source"],
        "rights": spec["rights"],
        "representation": spec.get("representation", "generic"),
        "aliases": spec.get("aliases", []),
        "display": display,
        "conversion": {
            "operation": "unreal_gltf_export",
            "tool": "project_support/tools/visual_assets/export_unreal_asset_gltf.py",
            "note": ("Unreal glTF exporter output, unmodified. Textures written as "
                     "JPEG quality %s by the exporter. %s"
                     % (manifest.get("texture_options", {}).get(
                         "texture_image_quality", "?"), note)).strip(),
            "material_slots": manifest.get("material_slots", []),
        },
        "validation": {"container": "passed", "gltf_validator": "not_run",
                       "browser": "not_run"},
        "geometry_note": {"rendered_triangles_estimate": triangles},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, required=True,
                        help="the .glb written by one of the export tools")
    parser.add_argument("--asset-id", default="projectairsim_airtaxi")
    parser.add_argument("--category", default="aircraft/civilian")
    parser.add_argument("--spec", type=Path, default=None,
                        help="JSON provenance and rights spec for a single-mesh export")
    arguments = parser.parse_args()

    raw = arguments.export.read_bytes()
    sanitised: list[str] = []
    manifest_path = arguments.export.with_suffix("").with_suffix(".placement.json")
    if not manifest_path.is_file():
        manifest_path = arguments.export.parent / (arguments.export.stem + ".placement.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    doc, body = glb_document(raw)

    package_relative = ""
    if manifest.get("model_package"):
        package = Path(manifest["model_package"])
        try:
            package_relative = package.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            package_relative = package.name

    if arguments.spec is not None:
        spec = json.loads(arguments.spec.read_text(encoding="utf-8"))
        if spec.get("sanitise_reduced_export"):
            raw, sanitised = sanitise_reduced_export(raw)
            # The shared library already knows how to renormalise normals and
            # drop texture maps whose UV set is gone; reuse it rather than
            # writing a second opinion on the same defects.
            raw, shared = prepare_model(raw, repair=True)
            if shared.get("changes"):
                sanitised = sanitised + list(shared["changes"])
            doc, body = glb_document(raw)
        metadata = build_metadata_from_spec(doc, manifest, spec, body)
        if sanitised:
            metadata["conversion"]["note"] += (
                " Repairs after export, none of which move a vertex: "
                + "; ".join(sanitised) + ".")
            metadata["conversion"]["repairs"] = sanitised
    else:
        metadata = build_metadata(doc, manifest["placements"], manifest,
                                  package_relative, body)
    triangles = metadata.pop("geometry_note")["rendered_triangles_estimate"]
    result = add_asset(LIBRARY, arguments.asset_id, arguments.category, raw, metadata)
    # add_asset owns the geometry block; the triangle count is ours to add.
    path = LIBRARY / arguments.category / arguments.asset_id / "asset.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["geometry"]["rendered_triangles"] = triangles
    measured = arguments.spec is None
    stored["geometry"]["native_coordinates"] = (
        "glTF right-handed +Y up; forward "
        + str(result["display"]["forward_axis"]) + ", up "
        + str(result["display"]["up_axis"])
        + (" (measured from the export)" if measured
           else " (declared by the intake spec)"))
    stored["geometry"]["physical_dimensions_verified"] = measured
    path.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    rebuild_catalog(LIBRARY)
    report = validate_library(LIBRARY)
    print(json.dumps({
        "asset_id": arguments.asset_id,
        "bytes": len(raw),
        "extent": stored["display"].get("extent_m") or stored["display"].get("extent"),
        "forward_axis": stored["display"]["forward_axis"],
        "up_axis": stored["display"]["up_axis"],
        "public_export": stored["rights"]["public_export"],
        "triangles": triangles,
        "library": report,
    }, ensure_ascii=False, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
