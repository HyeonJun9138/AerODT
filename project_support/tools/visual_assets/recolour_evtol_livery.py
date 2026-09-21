"""Repaint the AMVLAB eVTOL so it reads the way the AirTaxi does.

The model was hard to see: a pale body on pale concrete, a canopy the same
value as the fuselage, and propeller blades that disappeared. Beside the
AirTaxi — bright white, near-black glass, dark blades — it had no anchor.

Nothing about the geometry changes. Two things do:

* the paint atlas is recoloured by swatch, and the blade island by region
  (the blades share the wings' blue, so a colour alone cannot separate them);
* the material's roughness goes up. At 0.345 the studio environment lays a
  broad specular sheen over every surface, which is what turned white into
  grey and the blue into a wash. The AirTaxi has a roughness *texture* and so
  keeps its colours; this model has one number, and 0.75 is the matte paint
  that number should have been.

Both the source model and the flight rig carry the same atlas, so both are
repainted and the flight rig's `source_sha256` is re-pointed at the repainted
source. Run it once; running it again on an already-repainted model is a
no-op because the swatches it looks for are gone.
"""
import hashlib
import io
import json
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
ASSET = ROOT / "digital_twin/model_library/visual_assets/aircraft/civilian/amvlab_evtol"

# What the AirTaxi does, said in this model's swatches. The white is already
# pure and stays pure; it only looked grey because of the sheen.
SWATCHES = (
    # canopy glass: the anchor the model had none of
    ("#283446", "#0E1218", 30),
    # struts and small grey parts: graphite rather than mid grey
    ("#757575", "#3A4048", 26),
    # wings and accents: the same blue, saturated enough to survive the deck
    ("#03439A", "#1450C8", 40),
)
# The propeller blades are their own island at the foot of the atlas and share
# the wings' blue, so they are taken by where they are rather than what colour
# they are. Left, top, right, bottom in texture pixels.
BLADE_ISLAND = (80, 890, 340, 1020)
BLADE_COLOUR = "#2A3038"
# Anything this close to white in the island is a highlight, not paint.
WHITE_FLOOR = 235
ROUGHNESS = 0.75


def rgb(text):
    return tuple(int(text[index:index + 2], 16) for index in (1, 3, 5))


def read_glb(data):
    """(json, chunks) where chunks keeps every chunk in file order."""
    magic, version, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError("not a glTF 2.0 binary")
    offset, document, chunks = 12, None, []
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        payload = data[offset:offset + length]
        offset += length
        chunks.append([kind, bytearray(payload)])
        if kind == 0x4E4F534A and document is None:
            document = json.loads(payload.decode("utf-8"))
    if document is None:
        raise ValueError("glb has no JSON chunk")
    return document, chunks


def write_glb(document, chunks):
    body = bytearray()
    for kind, payload in chunks:
        if kind == 0x4E4F534A:
            payload = bytearray(json.dumps(document, separators=(",", ":")).encode("utf-8"))
            payload += b" " * (-len(payload) % 4)
        else:
            payload = bytearray(payload)
            payload += b"\0" * (-len(payload) % 4)
        body += struct.pack("<II", len(payload), kind) + payload
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + bytes(body)


def repaint(png):
    """The atlas, repainted. Answers None when there is nothing left to do."""
    image = Image.open(io.BytesIO(png)).convert("RGBA")
    pixels = image.load()
    rules = [(rgb(source), rgb(target), tolerance) for source, target, tolerance in SWATCHES]
    left, top, right, bottom = BLADE_ISLAND
    touched = 0
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if left <= x < right and top <= y < bottom and not (r > WHITE_FLOOR and g > WHITE_FLOOR and b > WHITE_FLOOR):
                pixels[x, y] = (*rgb(BLADE_COLOUR), a)
                touched += 1
                continue
            for source, target, tolerance in rules:
                if all(abs(have - want) <= tolerance for have, want in ((r, source[0]), (g, source[1]), (b, source[2]))):
                    # Keep the pixel's own shading offset from its swatch so
                    # anti-aliased edges survive the repaint.
                    shift = ((r - source[0]) + (g - source[1]) + (b - source[2])) / 3
                    pixels[x, y] = (*(max(0, min(255, round(channel + shift))) for channel in target), a)
                    touched += 1
                    break
    if not touched:
        return None
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def repaint_glb(path):
    data = path.read_bytes()
    document, chunks = read_glb(data)
    binary = next(chunk for chunk in chunks if chunk[0] == 0x004E4942)
    changed = False
    for material in document.get("materials", []):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        if pbr.get("roughnessFactor") != ROUGHNESS:
            pbr["roughnessFactor"] = ROUGHNESS
            changed = True
    # The repainted PNG is not the size of the one it replaces, so the binary is
    # rebuilt rather than patched: every view is copied out in offset order and
    # laid down again with fresh offsets. Accessors address their view by index
    # and their own offset inside it, so both stay valid.
    views = document.get("bufferViews", [])
    content = []
    for view in views:
        start = view.get("byteOffset", 0)
        content.append(bytearray(binary[1][start:start + view["byteLength"]]))
    for image in document.get("images", []):
        index = image.get("bufferView")
        if index is None:
            continue
        painted = repaint(bytes(content[index]))
        if painted is None:
            continue
        content[index] = bytearray(painted)
        changed = True
    if not changed:
        return None
    rebuilt = bytearray()
    for view, payload in zip(views, content):
        rebuilt += b"\0" * (-len(rebuilt) % 4)
        view["byteOffset"] = len(rebuilt)
        view["byteLength"] = len(payload)
        rebuilt += payload
    rebuilt += b"\0" * (-len(rebuilt) % 4)
    binary[1] = rebuilt
    document["buffers"][0]["byteLength"] = len(rebuilt)
    return write_glb(document, chunks)


def main():
    meta = json.loads((ASSET / "asset.json").read_text(encoding="utf-8"))
    written = {}
    for record in ("model", "flight_visual"):
        path = ASSET / meta[record]["path"]
        painted = repaint_glb(path)
        if painted is None:
            print(f"{path.name}: already repainted")
            continue
        path.write_bytes(painted)
        written[record] = (len(painted), hashlib.sha256(painted).hexdigest())
        print(f"{path.name}: {len(painted)} bytes")
    if not written:
        return
    for record, (size, digest) in written.items():
        meta[record]["sha256"] = digest
        if "bytes" in meta[record]:
            meta[record]["bytes"] = size
    # The rig is still derived from this source; only its paint moved with it.
    if "model" in written:
        meta["flight_visual"]["source_sha256"] = written["model"][1]
    meta["conversion"] = dict(meta.get("conversion") or {},
                              livery="recolour_evtol_livery.py: canopy, blades and wing blue set against the "
                                     "AirTaxi, paint roughness 0.345 -> 0.75")
    (ASSET / "asset.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("asset.json updated")


if __name__ == "__main__":
    main()
