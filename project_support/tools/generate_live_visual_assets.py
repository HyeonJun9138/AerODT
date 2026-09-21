"""Generate deterministic original low-poly glTF 2.0 placeholders, without dependencies.

Coordinates are right handed, +X forward and +Y up; lengths are metres.
These meshes describe appearance only, never dynamics or a real vehicle type.
"""
import argparse
import json
import math
from pathlib import Path
import struct

DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "digital_twin/model_library/visual_assets"
ATTRIBUTION = "AeroDT contributors; original procedural placeholder geometry; CC0-1.0."
AXES = {"forward": "+X", "up": "+Y", "handedness": "right"}


def box(center, size):
    x, y, z = center
    a, b, c = (v / 2 for v in size)
    vertices = [(x-a,y-b,z-c),(x+a,y-b,z-c),(x+a,y+b,z-c),(x-a,y+b,z-c),
                (x-a,y-b,z+c),(x+a,y-b,z+c),(x+a,y+b,z+c),(x-a,y+b,z+c)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)]
    return [tuple(vertices[i] for i in face) for face in faces]


def aircraft_parts():
    # Four-sided tapered fuselage, swept wings, horizontal stabilizer and upright fin.
    parts = []
    rings = [[(x,-r,-r),(x,-r,r),(x,r,r),(x,r,-r)] for x,r in [(-16,.35),(-10,1.2),(8,1.2),(16,0)]]
    hull = [tuple(reversed(rings[0]))]
    for left, right in zip(rings, rings[1:]):
        for i in range(4):
            j = (i + 1) % 4
            hull.append((left[i],left[j],right[j],right[i]))
    parts.append(("fuselage", 0, hull))
    for side in (-1, 1):
        # Winding is corrected below, with flat normals for every face.
        wing = [(5,0,side),(-5,0,side*14),(-8,0,side*14),(-3,0,side)]
        parts.append((f"wing_{side}", 0, [tuple(wing)]))
        tail = [(-10,.3,side*.3),(-13,.3,side*5),(-15,.3,side*5),(-14,.3,side*.3)]
        parts.append((f"tail_{side}", 1, [tuple(tail)]))
    parts.append(("vertical_tail", 1, [((-10,.5,0),(-14,5,0),(-16,5,0),(-15,.5,0))]))
    parts.append(("cockpit", 2, box((8,1.15,0),(3,.5,1.5))))
    return parts


def satellite_parts():
    parts = [("instrument_bus", 3, box((0,0,0),(3,2,2))),
             ("panel_boom", 0, box((0,0,0),(.25,.25,16)))]
    for side in (-1, 1):
        parts.append((f"solar_panel_{side}", 2, box((0,0,side*4.75),(4,.12,6.5))))
        for step in range(1, 6):
            parts.append((f"panel_grid_{side}_{step}", 0, box((0,.07,side*(1.5+step)),(4,.015,.035))))
    parts.append(("antenna", 0, box((0,1.75,0),(.12,1.5,.12))))
    return parts


def make_glb(parts):
    binary = bytearray()
    gltf = {"asset": {"version": "2.0", "generator": "AeroDT original procedural visual assets"},
            "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
            "buffers": [], "bufferViews": [], "accessors": [],
            "materials": [{"name": name, "doubleSided": True,
                "pbrMetallicRoughness": {"baseColorFactor": color, "metallicFactor": .15, "roughnessFactor": .65}}
                for name,color in [("ivory",[.82,.87,.9,1]),("blue_tail",[.08,.4,.65,1]),
                                   ("solar_glass",[.025,.09,.23,1]),("gold_bus",[.82,.55,.14,1])]],
            "extras": {"units": "metres", "axes": AXES, "temporary": True}}
    def accessor(values, bounds=False):
        offset = len(binary)
        packed = b"".join(struct.pack("<fff", *v) for v in values)
        binary.extend(packed)
        view = len(gltf["bufferViews"])
        gltf["bufferViews"].append({"buffer": 0,"byteOffset":offset,"byteLength":len(packed),"target":34962})
        result = {"bufferView":view,"componentType":5126,"count":len(values),"type":"VEC3"}
        if bounds:
            actual = list(struct.iter_unpack("<fff", packed))
            result.update(min=[min(v[i] for v in actual) for i in range(3)],max=[max(v[i] for v in actual) for i in range(3)])
        gltf["accessors"].append(result)
        return len(gltf["accessors"]) - 1
    for name, material, faces in parts:
        positions, normals = [], []
        for face in faces:
            for i in range(1, len(face)-1):
                triangle = [face[0],face[i],face[i+1]]
                a = [triangle[1][j]-triangle[0][j] for j in range(3)]
                b = [triangle[2][j]-triangle[0][j] for j in range(3)]
                normal = [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
                length = math.sqrt(sum(v*v for v in normal))
                if length == 0:
                    continue
                positions.extend(triangle)
                normals.extend([tuple(v/length for v in normal)]*3)
        primitive = {"attributes":{"POSITION":accessor(positions,True),"NORMAL":accessor(normals)},"material":material,"mode":4}
        gltf["meshes"].append({"name":name,"primitives":[primitive]})
        gltf["nodes"].append({"name":name,"mesh":len(gltf["meshes"])-1})
        gltf["scenes"][0]["nodes"].append(len(gltf["nodes"])-1)
    gltf["buffers"] = [{"byteLength":len(binary)}]
    encoded = json.dumps(gltf,separators=(",",":"),ensure_ascii=True).encode()
    encoded += b" " * (-len(encoded) % 4)
    return (struct.pack("<4sII",b"glTF",2,28+len(encoded)+len(binary)) +
            struct.pack("<II",len(encoded),0x4E4F534A)+encoded +
            struct.pack("<II",len(binary),0x004E4942)+binary)


def generate(output):
    entries = []
    for asset_id,kind,relative,size,parts in [
        ("generic_aircraft","aircraft","procedural/aircraft/civilian/generic_aircraft",32,aircraft_parts()),
        ("generic_satellite","satellite","procedural/spacecraft/satellites/generic_satellite",16,satellite_parts())]:
        folder = output / relative
        folder.mkdir(parents=True,exist_ok=True)
        uri = f"/visual-assets/{relative}"
        entry = {"asset_id":asset_id,"kind":kind,"uri":uri+"/model.glb","size_m":size,
                 "attribution":ATTRIBUTION,"temporary":True,"metadata_uri":uri+"/asset.json"}
        metadata = {**entry,"schema_version":1,"units":"metres","axes":AXES,"license":"CC0-1.0",
                    "thumbnail_uri":uri+"/thumbnail.svg",
                    "description":"Original generic visual placeholder, not a physical or branded vehicle model.",
                    "size_definition":"Largest model-space bounding-box dimension; no node scale transforms."}
        (folder / "model.glb").write_bytes(make_glb(parts))
        (folder / "asset.json").write_text(json.dumps(metadata,indent=2)+"\n",encoding="utf-8",newline="\n")
        (folder / "attribution.txt").write_text(ATTRIBUTION+"\nOriginal geometry and thumbnail generated locally; no third-party assets.\nCC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\nTemporary display asset only. +X forward, +Y up, right-handed; metres.\n",encoding="utf-8",newline="\n")
        drawing = ('<path fill="#cbdce6" d="M 128 22 L 139 82 L 220 145 L 218 156 L 140 126 L 138 192 L 166 215 L 166 224 L 128 212 L 90 224 L 90 215 L 118 192 L 116 126 L 38 156 L 36 145 L 117 82 Z"/>' if kind == "aircraft" else '<path stroke="#cbdce6" stroke-width="5" d="M 32 128 H 224 M 128 64 V 102"/><path fill="#153969" stroke="#6096ba" stroke-width="2" d="M 24 98 H 100 V 162 H 24 Z M 156 98 H 232 V 162 H 156 Z"/><path stroke="#6096ba" d="M 48 98 V 162 M 74 98 V 162 M 180 98 V 162 M 206 98 V 162 M 24 130 H 100 M 156 130 H 232"/><rect x="106" y="105" width="44" height="46" fill="#d0a03f"/>')
        (folder / "thumbnail.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img"><title>{asset_id} temporary asset</title><rect width="256" height="256" rx="20" fill="#122335"/>{drawing}</svg>\n',encoding="utf-8",newline="\n")
        entries.append(entry)
    (output / "procedural_catalog.json").write_text(json.dumps({"schema_version":1,"assets":entries},indent=2)+"\n",encoding="utf-8",newline="\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=DEFAULT_OUTPUT)
    generate(parser.parse_args().output)
