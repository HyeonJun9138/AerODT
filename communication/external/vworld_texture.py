"""Adapt V-World legacy CRN/technique materials to modern glTF in memory.

No geometry, georeferencing or LOD is changed. Texture2DDecoder (MIT, its
Crunch codec public domain) unpacks CRN; Pillow makes a bounded WebP atlas.
Cesium no longer reads compressedImage3DTiles.crunch and otherwise displays
the source's one-pixel white placeholder. Two conversion slots are owned by
the caller, outside the event loop. Nothing is written to disk.
"""
import io
import json
import math
import struct

MAX_ATLAS_EDGE = 1024
MAX_SOURCE_PIXELS = 4096 * 4096
MAX_ATLASES = 256
MAX_TILE_TEXTURE_PIXELS = 4 * 1024 * 1024
MAX_OVERVIEW_TEXTURE_PIXELS = 256 * 1024
MAX_TILE_SOURCE_PIXELS = 512 * 1024 * 1024


def atlas_dimensions(data):
    if len(data) < 74 or data[:2] != b"Hx":
        raise ValueError("Invalid CRN header")
    width, height = struct.unpack_from(">HH", data, 12)
    if not width or not height or width * height > MAX_SOURCE_PIXELS or data[17] != 1 or data[18] not in (0, 2):
        raise ValueError("Unsupported or oversized CRN atlas")
    return width, height


def decode_atlas(data, max_edge=MAX_ATLAS_EDGE):
    width, height = atlas_dimensions(data)
    import texture2ddecoder
    from PIL import Image
    blocks = texture2ddecoder.unpack_crunch(data)
    block_bytes = 8 if data[18] == 0 else 16
    if len(blocks) != ((width + 3) // 4) * ((height + 3) // 4) * block_bytes:
        raise ValueError("Invalid CRN block size")
    decode = texture2ddecoder.decode_bc1 if data[18] == 0 else texture2ddecoder.decode_bc3
    pixels = decode(blocks, width, height)
    image = Image.frombytes("RGBA", (width, height), pixels, "raw", "BGRA")
    if data[18] == 0:
        image = image.convert("RGB")
    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, "WEBP", quality=90, method=0)
    return output.getvalue()


def modernize_b3dm(content, *, decoder=decode_atlas, overview=False):
    if len(content) < 28 or content[:4] != b"b3dm":
        raise ValueError("Invalid b3dm")
    header = list(struct.unpack_from("<7I", content))
    offset = 28 + sum(header[3:])
    if header[1] != 1 or header[2] != len(content) or offset + 28 > len(content):
        raise ValueError("Invalid b3dm lengths")
    glb = content[offset:]
    if glb[:4] != b"glTF" or struct.unpack_from("<I", glb, 4)[0] != 2:
        raise ValueError("Unsupported glTF version")
    length, kind = struct.unpack_from("<II", glb, 12)
    if kind != 0x4E4F534A or 28 + length > len(glb):
        raise ValueError("Invalid glTF JSON")
    doc = json.loads(glb[20:20 + length])
    images = doc.get("images", [])
    legacy = [(i, image.get("extras", {}).get("compressedImage3DTiles", {}).get("crunch")) for i, image in enumerate(images)]
    legacy = [(i, info) for i, info in legacy if info]
    if not legacy:
        return content
    if len(legacy) > MAX_ATLASES:
        raise ValueError("Too many CRN atlases")
    binary_length, binary_kind = struct.unpack_from("<II", glb, 20 + length)
    if binary_kind != 0x004E4942 or 28 + length + binary_length > len(glb):
        raise ValueError("Invalid glTF binary")
    binary = glb[28 + length:28 + length + binary_length]
    views = doc.get("bufferViews", [])
    replacements = {}
    atlases = []
    for index, info in legacy:
        view_index = info["bufferView"]
        view = views[view_index]
        start, size = view.get("byteOffset", 0), view["byteLength"]
        if start < 0 or size < 0 or start + size > len(binary):
            raise ValueError("Invalid CRN buffer view")
        crn = binary[start:start + size]
        width, height = atlas_dimensions(crn)
        atlases.append((view_index, crn, width, height))
        images[index] = {"bufferView": view_index, "mimeType": "image/webp"}
    pixels = sum(w * h for _, _, w, h in atlases)
    if pixels > MAX_TILE_SOURCE_PIXELS:
        raise ValueError("Tile exceeds source texture budget")
    budget = MAX_OVERVIEW_TEXTURE_PIXELS if overview else MAX_TILE_TEXTURE_PIXELS
    scale = min(1.0, math.sqrt(budget / max(1, pixels)))
    # A coarse parent may hold over 100 atlases. Budget the WHOLE tile, not
    # merely each image: otherwise one parent alone consumes 500 MB of VRAM.
    # Native near-field child tiles have fewer atlases and retain more detail.
    for index, crn, width, height in atlases:
        edge = max(16, min(256 if overview else MAX_ATLAS_EDGE, int(max(width, height) * scale)))
        replacements[index] = decoder(crn, max_edge=edge)
    # Compact all buffer views, preserving their indices and geometry bytes.
    packed = bytearray()
    for index, view in enumerate(views):
        start, size = view.get("byteOffset", 0), view["byteLength"]
        if view.get("buffer", 0) != 0 or start < 0 or start + size > len(binary):
            raise ValueError("Invalid buffer view")
        packed.extend(b"\0" * (-len(packed) % 4))
        data = replacements.get(index, binary[start:start + size])
        view.update(buffer=0, byteOffset=len(packed), byteLength=len(data))
        packed.extend(data)
    packed.extend(b"\0" * (-len(packed) % 4))
    doc["buffers"] = [{"byteLength": len(packed)}]
    for texture in doc.get("textures", []):
        if any(texture.get("source") == i for i, _ in legacy):
            texture.setdefault("extensions", {})["EXT_texture_webp"] = {"source": texture["source"]}
            texture.pop("source", None)
    for material in doc.get("materials", []):
        extension = material.get("extensions", {}).pop("KHR_techniques_webgl", None)
        diffuse = (extension or {}).get("values", {}).get("u_diffuse")
        if isinstance(diffuse, dict) and "index" in diffuse:
            material["pbrMetallicRoughness"] = {"baseColorTexture": diffuse, "metallicFactor": 0, "roughnessFactor": 1}
            # Aerial facade photography has baked lighting, not PBR maps.
            material.setdefault("extensions", {})["KHR_materials_unlit"] = {}
    doc.get("extensions", {}).pop("KHR_techniques_webgl", None)
    for key in ("extensionsUsed", "extensionsRequired"):
        values = [v for v in doc.get(key, []) if v != "KHR_techniques_webgl"]
        doc[key] = list(dict.fromkeys(values + ["EXT_texture_webp"] + (["KHR_materials_unlit"] if key == "extensionsUsed" else [])))
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    glb_length = 28 + len(encoded) + len(packed)
    glb = (struct.pack("<5I", 0x46546C67, 2, glb_length, len(encoded), 0x4E4F534A) + encoded
           + struct.pack("<2I", len(packed), 0x004E4942) + packed)
    header[2] = offset + len(glb)
    return struct.pack("<7I", *header) + content[28:offset] + glb
