"""Reports what an Unreal asset is made of. Runs inside Unreal, changes nothing.

Used when an exported model does not look like the vehicle the operator knows:
a static mesh carries its own default slot materials, while the blueprint that
is actually placed in their level may override them per component.

Invoked with AERODT_PROBE_ASSETS (semicolon-separated asset paths) and
AERODT_PROBE_OUTPUT (a JSON file). The result goes to the file rather than the
log, which does not reliably reach stdout in an unattended run.
"""

import json
import os
import traceback

import unreal


def describe_material(material):
    if material is None:
        return None
    record = {"name": material.get_name()}
    try:
        if isinstance(material, unreal.MaterialInstance):
            parent = material.get_editor_property("parent")
            record["parent"] = parent.get_name() if parent else None
    except Exception:
        pass
    return record


def overrides_of(component):
    try:
        return [describe_material(m) for m in (component.get_editor_property("override_materials") or [])]
    except Exception:
        return []


def describe(path):
    asset = unreal.EditorAssetLibrary.load_asset(path)
    if asset is None:
        return {"path": path, "error": "not found"}
    record = {"path": path, "type": type(asset).__name__}
    if isinstance(asset, unreal.StaticMesh):
        record["slots"] = [describe_material(asset.get_material(i))
                           for i in range(asset.get_num_sections(0))]
    elif isinstance(asset, unreal.SkeletalMesh):
        slots = []
        for entry in (asset.get_editor_property("materials") or []):
            slots.append(describe_material(getattr(entry, "material_interface", None)))
        record["slots"] = slots
    elif isinstance(asset, unreal.Blueprint):
        klass = asset.generated_class()
        record["generated_class"] = klass.get_name() if klass else None
        components = []
        if klass is not None:
            defaults = unreal.get_default_object(klass)
            # Component templates are subobjects of the default object; walking
            # its attributes is the version-independent way to reach them.
            for name in dir(defaults):
                if name.startswith("__"):
                    continue
                try:
                    value = getattr(defaults, name)
                except Exception:
                    continue
                if isinstance(value, unreal.StaticMeshComponent):
                    mesh = value.get_editor_property("static_mesh")
                    components.append({"attribute": name, "kind": "static",
                                       "mesh": mesh.get_name() if mesh else None,
                                       "overrides": overrides_of(value)})
                elif isinstance(value, unreal.SkeletalMeshComponent):
                    mesh = value.get_editor_property("skeletal_mesh")
                    components.append({"attribute": name, "kind": "skeletal",
                                       "mesh": mesh.get_name() if mesh else None,
                                       "overrides": overrides_of(value)})
        record["components"] = components
    return record


def main():
    output = os.environ["AERODT_PROBE_OUTPUT"]
    paths = [p.strip() for p in os.environ["AERODT_PROBE_ASSETS"].split(";") if p.strip()]
    result = {"schema_version": 1, "assets": [describe(path) for path in paths]}
    with open(output, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)


try:
    main()
except Exception:
    try:
        with open(os.environ.get("AERODT_PROBE_OUTPUT", "probe_error.json"), "w",
                  encoding="utf-8") as stream:
            json.dump({"error": traceback.format_exc()}, stream, indent=2)
    except Exception:
        pass
    raise
