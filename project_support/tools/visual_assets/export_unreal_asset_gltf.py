"""Exports one Unreal static mesh as glTF. Runs inside Unreal.

The sibling script export_unreal_vehicle_gltf.py assembles a whole model package
from its `links[].visual`. This one handles the other case: a candidate airframe
that arrives as a single mesh, either already in the project's content or as an
FBX that has to be imported first.

Invoked by `UnrealEditor-Cmd.exe <project> -ExecutePythonScript=<this file>`
with AERODT_EXPORT_OUTPUT and exactly one of AERODT_EXPORT_ASSET_PATH or
AERODT_EXPORT_SOURCE_FBX set.
"""

import json
import os
import traceback

import unreal

IMPORT_ROOT = "/Game/AeroDTImport"


def import_fbx(source, name):
    options = unreal.FbxImportUI()
    options.set_editor_property("import_mesh", True)
    options.set_editor_property("import_textures", True)
    options.set_editor_property("import_materials", True)
    # A candidate airframe is drawn, not animated here; a static mesh keeps the
    # export a single node and avoids importing a rig we would not use.
    options.set_editor_property("import_as_skeletal", False)
    options.set_editor_property("automated_import_should_detect_type", False)
    options.set_editor_property("mesh_type_to_import",
                                unreal.FBXImportType.FBXIT_STATIC_MESH)
    mesh_options = options.static_mesh_import_data
    mesh_options.set_editor_property("combine_meshes", True)
    mesh_options.set_editor_property("generate_lightmap_u_vs", False)
    mesh_options.set_editor_property("auto_generate_collision", False)

    task = unreal.AssetImportTask()
    task.set_editor_property("filename", source)
    task.set_editor_property("destination_path", "%s/%s" % (IMPORT_ROOT, name))
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", False)
    task.set_editor_property("options", options)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])

    imported = list(task.get_editor_property("imported_object_paths"))
    unreal.log("AERODT_EXPORT_IMPORTED: %s" % imported)
    for path in imported:
        asset = unreal.EditorAssetLibrary.load_asset(path)
        if isinstance(asset, unreal.StaticMesh):
            return asset, path
    raise RuntimeError("the FBX import produced no static mesh: %s" % source)


def rebuild_as_actors(source, name):
    """Re-places a blueprint's mesh components as ordinary actors.

    Exporting the blueprint actor itself writes the node hierarchy but no
    geometry, so each visible mesh component is put back into the world as a
    plain actor at the same world transform, carrying the same material
    overrides. The result is the vehicle the blueprint composes, in parts the
    exporter does write.
    """
    # Internal components are not part of the silhouette. On this airframe the
    # two battery cells alone are 85% of the triangles and are never seen from
    # outside, so the caller may name components to leave out.
    excluded = [x.strip() for x in os.environ.get("AERODT_EXPORT_EXCLUDE", "").split(";") if x.strip()]
    reduce_percent = float(os.environ.get("AERODT_EXPORT_REDUCE_TO_PERCENT", "0"))
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    spawned, parts, reduced = [], [], set()
    for index, component in enumerate(source.get_components_by_class(unreal.MeshComponent)):
        if any(token.lower() in component.get_name().lower() for token in excluded):
            parts.append({"component": component.get_name(), "excluded": True})
            continue
        mesh = None
        for prop in ("static_mesh", "skeletal_mesh_asset", "skeletal_mesh"):
            try:
                mesh = component.get_editor_property(prop)
            except Exception:
                continue
            if mesh is not None:
                break
        if mesh is None or not component.is_visible():
            continue
        transform = component.get_world_transform()
        if isinstance(mesh, unreal.SkeletalMesh):
            actor = actors.spawn_actor_from_class(
                unreal.SkeletalMeshActor, transform.translation, transform.rotation.rotator())
            target = actor.skeletal_mesh_component
            set_property(target, mesh, "skeletal_mesh_asset", "skeletal_mesh")
        else:
            if reduce_percent > 0.0 and mesh.get_name() not in reduced:
                reduced.add(mesh.get_name())
                reduce_to_lod(mesh, reduce_percent)
            actor = actors.spawn_actor_from_class(
                unreal.StaticMeshActor, transform.translation, transform.rotation.rotator())
            target = actor.static_mesh_component
            target.set_mobility(unreal.ComponentMobility.MOVABLE)
            target.set_static_mesh(mesh)
        actor.set_actor_scale3d(transform.scale3d)
        actor.set_actor_label("AeroDTExport_%s_%02d_%s" % (name, index, component.get_name()))
        materials = []
        for slot in range(component.get_num_materials()):
            material = component.get_material(slot)
            if material is not None:
                target.set_material(slot, material)
            materials.append(material.get_name() if material else None)
        spawned.append(actor)
        parts.append({"component": component.get_name(),
                      "mesh": mesh.get_name(),
                      "kind": "skeletal" if isinstance(mesh, unreal.SkeletalMesh) else "static",
                      "materials": materials, "excluded": False})
    return spawned, parts, actors


def spawn_blueprint(asset, name):
    """Puts the operator's own assembled vehicle in the world.

    A blueprint is how a project actually composes a vehicle: fuselage, flight
    surfaces, gear and rotors as separate meshes with their own material
    overrides. Exporting one of those meshes on its own gives loose parts in
    placeholder colours, so when the caller names a blueprint the whole actor
    is spawned and exported.
    """
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actor = actors.spawn_actor_from_object(asset, unreal.Vector(0, 0, 0),
                                           unreal.Rotator(0, 0, 0))
    if actor is None:
        raise RuntimeError("could not spawn blueprint %s" % name)
    actor.set_actor_label("AeroDTExport_%s" % name)
    return actor, actors


def describe_actor(actor):
    """What the spawned vehicle is actually made of, for the placement record."""
    parts = []
    for component in actor.get_components_by_class(unreal.MeshComponent):
        mesh = None
        for prop in ("static_mesh", "skeletal_mesh_asset", "skeletal_mesh"):
            try:
                mesh = component.get_editor_property(prop)
            except Exception:
                continue
            if mesh is not None:
                break
        materials = []
        for index in range(component.get_num_materials()):
            material = component.get_material(index)
            materials.append(material.get_name() if material else None)
        parts.append({"component": component.get_name(),
                      "mesh": mesh.get_name() if mesh else None,
                      "materials": materials,
                      "visible": bool(component.is_visible())})
    return parts


def load_mesh(path):
    """A candidate airframe may be authored either way.

    The same vehicle often exists twice in a project: a static mesh carrying
    placeholder materials and the rigged mesh the operator actually flies. The
    caller names which one it wants, so both are accepted here.
    """
    asset = unreal.EditorAssetLibrary.load_asset(path)
    if asset is None:
        asset = unreal.EditorAssetLibrary.load_asset(
            "%s.%s" % (path, path.rsplit("/", 1)[-1]))
    if not isinstance(asset, (unreal.StaticMesh, unreal.SkeletalMesh, unreal.Blueprint)):
        raise RuntimeError("not a static mesh, skeletal mesh or blueprint: %s" % path)
    return asset


def load_static_mesh(path):
    asset = load_mesh(path)
    if not isinstance(asset, unreal.StaticMesh):
        raise RuntimeError("not a static mesh: %s" % path)
    return asset


def set_property(target, value, *names):
    for name in names:
        try:
            target.set_editor_property(name, value)
            return name
        except Exception:
            continue
    raise RuntimeError("none of %s could be set" % (names,))


def spawn_for(mesh, name):
    """Puts the mesh in the world so the exporter can take its materials."""
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if isinstance(mesh, unreal.SkeletalMesh):
        actor = actors.spawn_actor_from_class(unreal.SkeletalMeshActor,
                                              unreal.Vector(0, 0, 0),
                                              unreal.Rotator(0, 0, 0))
        component = actor.skeletal_mesh_component
        # The property was renamed in UE 5.1; accept either spelling.
        set_property(component, mesh, "skeletal_mesh_asset", "skeletal_mesh")
    else:
        actor = actors.spawn_actor_from_class(unreal.StaticMeshActor,
                                              unreal.Vector(0, 0, 0),
                                              unreal.Rotator(0, 0, 0))
        component = actor.static_mesh_component
        component.set_mobility(unreal.ComponentMobility.MOVABLE)
        component.set_static_mesh(mesh)
    actor.set_actor_label("AeroDTExport_%s" % name)
    return actor, actors


def report_materials(mesh):
    """A CAD import often arrives with unresolved slots; say so instead of
    silently exporting the engine's grey fallback."""
    names = []
    if isinstance(mesh, unreal.SkeletalMesh):
        for entry in (mesh.get_editor_property("materials") or []):
            material = getattr(entry, "material_interface", None)
            names.append(material.get_name() if material else "<none>")
    else:
        for index in range(mesh.get_num_sections(0)):
            material = mesh.get_material(index)
            names.append(material.get_name() if material else "<none>")
    unreal.log("AERODT_EXPORT_MATERIAL_SLOTS: %s" % names)
    return names


def reduce_to_lod(mesh, percent_triangles):
    """Builds one reduced LOD so a CAD-density mesh can be delivered to a
    browser. The base LOD is left untouched."""
    settings = unreal.EditorScriptingMeshReductionSettings()
    settings.set_editor_property("percent_triangles", percent_triangles)
    settings.set_editor_property("screen_size", 0.5)
    options = unreal.EditorScriptingMeshReductionOptions()
    options.set_editor_property("reduction_settings", [settings])
    options.set_editor_property("auto_compute_lod_screen_size", True)
    try:
        subsystem = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
        subsystem.set_lods(mesh, options)
    except Exception:
        unreal.EditorStaticMeshLibrary.set_lods(mesh, options)
    unreal.log("AERODT_EXPORT_LODS: %d" % mesh.get_num_lods())
    return mesh.get_num_lods() - 1


def enum_value(enum_name, *candidates):
    """Enum member names differ between engine versions; take the first that exists."""
    enum = getattr(unreal, enum_name, None)
    if enum is None:
        return None
    for candidate in candidates:
        value = getattr(enum, candidate, None)
        if value is not None:
            return value
    return None


def apply_material_bake(options, bake_size):
    """Bakes complex material graphs down to small textures.

    An Unreal material instance (car paint, glass, brushed metal) has no glTF
    equivalent, so without baking the export carries the engine's grey default.
    Baking every material to one small texture set keeps the colours and costs
    a few hundred kilobytes rather than the source pack's gigabytes.
    """
    mode = enum_value("GLTFMaterialBakeMode", "SIMPLE", "Simple", "USE_MESH_DATA")
    if mode is not None:
        options.set_editor_property("bake_material_inputs", mode)
    size = enum_value("GLTFMaterialBakeSizePOT", "POT_%d" % bake_size,
                      "POT%d" % bake_size)
    if size is not None:
        options.set_editor_property("default_material_bake_size", size)
    unreal.log("AERODT_EXPORT_BAKE: mode=%s size=%s" % (mode, size))
    return {"bake_mode": str(mode), "bake_size": bake_size}


def export(world, spawned, output, quality, level_of_detail, bake_size):
    options = unreal.GLTFExportOptions()
    options.set_editor_property("export_uniform_scale", 0.01)
    options.set_editor_property("default_level_of_detail", level_of_detail)
    bake = apply_material_bake(options, bake_size) if bake_size else {}
    options.set_editor_property("texture_image_format",
                                unreal.GLTFTextureImageFormat.JPEG)
    options.set_editor_property("texture_image_quality", quality)
    # A blueprint composes its vehicle from skeletal components; the exporter
    # only writes their geometry when skin weights and the preview mesh are
    # enabled, which is also why the defaults are left alone here.
    for name, value in (("bundle_web_viewer", False), ("show_files_when_done", False),
                        ("export_preview_mesh", True), ("export_vertex_skin_weights", True),
                        ("export_lights", False), ("export_cameras", False)):
        try:
            options.set_editor_property(name, value)
        except Exception:
            pass
    selected = unreal.Set(unreal.Actor)
    for actor in spawned:
        selected.add(actor)
    return unreal.GLTFExporter.export_to_gltf(world, output, options, selected), bake


def main():
    output = os.environ["AERODT_EXPORT_OUTPUT"]
    name = os.environ.get("AERODT_EXPORT_NAME") or os.path.splitext(
        os.path.basename(output))[0]
    asset_path = os.environ.get("AERODT_EXPORT_ASSET_PATH", "")
    source_fbx = os.environ.get("AERODT_EXPORT_SOURCE_FBX", "")
    quality = int(os.environ.get("AERODT_EXPORT_TEXTURE_QUALITY", "90"))
    # A source authored in arbitrary units exports at that size. Scaling here
    # means the stored model's own extent is metres, like every other asset in
    # the library, instead of a number that only looks like one.
    model_scale = float(os.environ.get("AERODT_EXPORT_SCALE", "1"))
    reduce_percent = float(os.environ.get("AERODT_EXPORT_REDUCE_TO_PERCENT", "0"))
    bake_size = int(os.environ.get("AERODT_EXPORT_BAKE_SIZE", "0"))
    if bool(asset_path) == bool(source_fbx):
        raise ValueError("set exactly one of AERODT_EXPORT_ASSET_PATH or "
                         "AERODT_EXPORT_SOURCE_FBX")

    if source_fbx:
        mesh, resolved = import_fbx(source_fbx, name)
    else:
        mesh, resolved = load_mesh(asset_path), asset_path

    if isinstance(mesh, unreal.Blueprint):
        source, actors = spawn_blueprint(mesh, name)
        spawned, parts, actors = rebuild_as_actors(source, name)
        actors.destroy_actor(source)
        if not spawned:
            raise RuntimeError("the blueprint has no visible mesh components")
        slots = sorted({m for part in parts for m in (part.get("materials") or []) if m})
        unreal.log("AERODT_EXPORT_BLUEPRINT_PARTS: %d" % len(parts))
        level_of_detail = int(os.environ.get("AERODT_EXPORT_LOD", "0"))
        return finish(spawned, actors, name, output, quality, level_of_detail, bake_size,
                      model_scale, resolved, source_fbx, slots, parts, reduce_percent)

    parts = []
    slots = report_materials(mesh)
    level_of_detail = 0
    if reduce_percent > 0.0 and isinstance(mesh, unreal.StaticMesh):
        level_of_detail = reduce_to_lod(mesh, reduce_percent)
    elif reduce_percent > 0.0:
        # Skeletal reduction is a different pipeline; say so rather than
        # silently exporting the full-density mesh as if it had been reduced.
        unreal.log_warning("AERODT_EXPORT_REDUCE_SKIPPED: skeletal meshes are not "
                           "reduced here; set AERODT_EXPORT_LOD instead")
    level_of_detail = int(os.environ.get("AERODT_EXPORT_LOD", level_of_detail))

    actor, actors = spawn_for(mesh, name)
    return finish([actor], actors, name, output, quality, level_of_detail, bake_size,
                  model_scale, resolved, source_fbx, slots, parts, reduce_percent)


def finish(spawned, actors, name, output, quality, level_of_detail, bake_size,
           model_scale, resolved, source_fbx, slots, parts, reduce_percent):
    if model_scale != 1.0:
        for actor in spawned:
            actor.set_actor_scale3d(unreal.Vector(model_scale, model_scale, model_scale))
        unreal.log("AERODT_EXPORT_SCALE_APPLIED: %g" % model_scale)
    try:
        world = unreal.get_editor_subsystem(
            unreal.UnrealEditorSubsystem).get_editor_world()
        result, bake = export(world, spawned, output, quality, level_of_detail,
                              bake_size)
        ok = result[0] if isinstance(result, tuple) else bool(result)
        messages = result[1] if isinstance(result, tuple) and len(result) > 1 else None
        report = {"errors": [], "warnings": [], "suggestions": []}
        if messages is not None:
            for field in report:
                try:
                    report[field] = [str(x) for x in list(getattr(messages, field))][:40]
                except Exception:
                    pass
        if messages is not None:
            for error in list(messages.errors):
                unreal.log_error("AERODT_EXPORT_GLTF_ERROR: %s" % error)
            for warning in list(messages.warnings)[:20]:
                unreal.log_warning("AERODT_EXPORT_GLTF_WARNING: %s" % warning)
        if not ok or not os.path.isfile(output):
            raise RuntimeError("glTF export did not produce %s" % output)
        with open(os.path.splitext(output)[0] + ".placement.json", "w",
                  encoding="utf-8") as stream:
            json.dump({
                "schema_version": 1,
                "single_mesh": True,
                "asset_path": resolved,
                "source_fbx": source_fbx,
                "output": output,
                "unreal_engine": unreal.SystemLibrary.get_engine_version(),
                "export_uniform_scale": 0.01,
                "texture_options": {"texture_image_format": "JPEG",
                                    "texture_image_quality": quality},
                "material_slots": slots,
                "actor_parts": parts,
                "export_messages": report,
                "material_bake": bake,
                "model_scale": model_scale,
                "reduction": {"percent_triangles": reduce_percent,
                              "exported_level_of_detail": level_of_detail},
                # One mesh at the origin cannot reveal the axis mapping the way a
                # placed assembly does; the consumer records it from the export
                # convention plus what the rendered preview actually shows.
                "placements": [{"link": name, "mesh": resolved,
                                "unreal_location_cm": [0.0, 0.0, 0.0],
                                "unreal_yaw_deg": 0.0}],
            }, stream, ensure_ascii=False, indent=2)
        unreal.log("AERODT_EXPORT=OK %s" % output)
    finally:
        for actor in spawned:
            actors.destroy_actor(actor)


try:
    main()
except Exception:
    unreal.log_error("AERODT_EXPORT=FAIL\n%s" % traceback.format_exc())
    raise
