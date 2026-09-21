"""Exports a model package's Unreal meshes as one glTF binary. Runs inside Unreal.

Invoked by `UnrealEditor-Cmd.exe <project> -ExecutePythonScript=<this file>` with
AERODT_EXPORT_MODEL_PACKAGE and AERODT_EXPORT_OUTPUT set. It assembles the
package's `links[].visual` entries into a single actor selection and exports
that selection, so the resulting file shows the vehicle the way the model
package defines it rather than three loose parts.

Nothing here touches the preserved ProjectAirSim tree: the meshes are only read
through the mounted /Drone content plugin.
"""

import json
import math
import os
import traceback

import unreal


def strip_json_comments(source):
    """Model packages are JSONC; Unreal's Python has no tolerant JSON reader."""
    out, index, length = [], 0, len(source)
    while index < length:
        char = source[index]
        if char == '"':
            end = index + 1
            while end < length:
                if source[end] == "\\":
                    end += 2
                    continue
                if source[end] == '"':
                    break
                end += 1
            out.append(source[index:end + 1])
            index = end + 1
        elif source.startswith("//", index):
            index = source.find("\n", index)
            if index < 0:
                break
        elif source.startswith("/*", index):
            closing = source.find("*/", index + 2)
            index = length if closing < 0 else closing + 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def parse_triple(value):
    parts = value.split()
    if len(parts) != 3:
        raise ValueError("expected three numbers: %r" % value)
    return [float(part) for part in parts]


def unreal_transform(origin):
    """NED metres and right-handed rpy to Unreal NEU centimetres and rotator.

    Mirrors ProjectAirSim's UnrealRobotLink and the AeroDTUamSim host: the
    translation flips Z, and the rotation is conjugated for the left-handed
    frame. Only yaw appears in the current packages; anything else is refused
    rather than silently mis-oriented.
    """
    x, y, z = parse_triple(origin.get("xyz", "0 0 0"))
    roll, pitch, yaw = parse_triple(origin.get("rpy-deg", "0 0 0"))
    if abs(roll) > 1e-9 or abs(pitch) > 1e-9:
        raise ValueError(
            "visual origin uses roll/pitch (%r); extend the exporter with a "
            "quaternion conversion before exporting this package" % origin)
    location = unreal.Vector(x * 100.0, y * 100.0, -z * 100.0)
    # Conjugating a pure-yaw rotation is a sign flip on the yaw.
    rotation = unreal.Rotator(0.0, 0.0, -yaw)
    return location, rotation


def visual_links(model_package):
    with open(model_package, "r", encoding="utf-8-sig") as stream:
        document = json.loads(strip_json_comments(stream.read()))
    links = []
    for link in document.get("links", []):
        visual = link.get("visual")
        if not visual:
            continue
        geometry = visual.get("geometry") or {}
        if geometry.get("type") != "unreal_mesh" or not geometry.get("name"):
            continue
        links.append({
            "name": link.get("name", ""),
            "mesh": geometry["name"],
            "origin": visual.get("origin", {}),
        })
    if not links:
        raise ValueError("model package declares no unreal_mesh visuals")
    return links


def load_mesh(path):
    mesh = unreal.EditorAssetLibrary.load_asset(path)
    if mesh is None:
        mesh = unreal.EditorAssetLibrary.load_asset("%s.%s" % (path, path.rsplit("/", 1)[-1]))
    if mesh is None:
        raise ValueError("cannot load static mesh %s" % path)
    return mesh


def editor_world():
    subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
    return subsystem.get_editor_world()


def spawn_parts(links):
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    spawned, placements = [], []
    for index, link in enumerate(links):
        mesh = load_mesh(link["mesh"])
        location, rotation = unreal_transform(link["origin"])
        actor = actors.spawn_actor_from_class(unreal.StaticMeshActor, location, rotation)
        actor.set_actor_label("AeroDTExport_%02d_%s" % (index, link["name"] or "link"))
        component = actor.static_mesh_component
        component.set_mobility(unreal.ComponentMobility.MOVABLE)
        component.set_static_mesh(mesh)
        spawned.append(actor)
        placements.append({
            "link": link["name"],
            "mesh": link["mesh"],
            "unreal_location_cm": [location.x, location.y, location.z],
            "unreal_yaw_deg": rotation.yaw,
        })
    return spawned, placements


"""Texture quality that keeps the file inside the existing library's range.

The source materials carry 4K PNG maps; exporting them losslessly produced a
41 MB file, which is three times the largest asset already in the library and
far too heavy to stream onto the live globe. JPEG at 90 is one lossy step
applied by the exporter itself, so the stored bytes stay exactly what Unreal
produced and no post-hoc image edit has to be justified.
"""
TEXTURE_OPTIONS = {"texture_image_format": "JPEG", "texture_image_quality": 90}


def export(world, actors, output):
    options = unreal.GLTFExportOptions()
    # Centimetres to metres: the library records real dimensions, so the export
    # must not be left in Unreal units.
    options.set_editor_property("export_uniform_scale", 0.01)
    options.set_editor_property(
        "texture_image_format",
        unreal.GLTFTextureImageFormat.JPEG)
    options.set_editor_property("texture_image_quality",
                                TEXTURE_OPTIONS["texture_image_quality"])
    for name, value in (("bundle_web_viewer", False), ("show_files_when_done", False),
                        ("export_preview_mesh", False), ("export_lights", False),
                        ("export_cameras", False)):
        try:
            options.set_editor_property(name, value)
        except Exception:
            pass  # Option names differ between engine versions; defaults are safe.
    selected = unreal.Set(unreal.Actor)
    for actor in actors:
        selected.add(actor)
    return unreal.GLTFExporter.export_to_gltf(world, output, options, selected)


def main():
    model_package = os.environ["AERODT_EXPORT_MODEL_PACKAGE"]
    output = os.environ["AERODT_EXPORT_OUTPUT"]
    manifest_path = os.path.splitext(output)[0] + ".placement.json"

    links = visual_links(model_package)
    unreal.log("AERODT_EXPORT: %d visual links from %s" % (len(links), model_package))
    spawned, placements = spawn_parts(links)
    try:
        result = export(editor_world(), spawned, output)
        ok = result[0] if isinstance(result, tuple) else bool(result)
        messages = result[1] if isinstance(result, tuple) and len(result) > 1 else None
        if messages is not None:
            for error in list(messages.errors):
                unreal.log_error("AERODT_EXPORT_GLTF_ERROR: %s" % error)
            for warning in list(messages.warnings):
                unreal.log_warning("AERODT_EXPORT_GLTF_WARNING: %s" % warning)
        if not ok or not os.path.isfile(output):
            raise RuntimeError("glTF export did not produce %s" % output)
        with open(manifest_path, "w", encoding="utf-8") as stream:
            json.dump({
                "schema_version": 1,
                "model_package": model_package,
                "output": output,
                "unreal_engine": unreal.SystemLibrary.get_engine_version(),
                "export_uniform_scale": 0.01,
                "texture_options": TEXTURE_OPTIONS,
                "placements": placements,
            }, stream, ensure_ascii=False, indent=2)
        unreal.log("AERODT_EXPORT=OK %s" % output)
    finally:
        actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        for actor in spawned:
            actors.destroy_actor(actor)


try:
    main()
except Exception:
    unreal.log_error("AERODT_EXPORT=FAIL\n%s" % traceback.format_exc())
    raise
