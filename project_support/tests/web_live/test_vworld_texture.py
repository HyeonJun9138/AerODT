import json
import struct

import pytest

from communication.external.vworld_texture import modernize_b3dm, decode_atlas, MAX_TILE_TEXTURE_PIXELS, MAX_OVERVIEW_TEXTURE_PIXELS


def make_tile(doc=None, binary=b"abcdcrn!"):
    doc = doc or {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}], "images": []}
    encoded = json.dumps(doc).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    glb = (struct.pack("<5I", 0x46546C67, 2, 28 + len(encoded) + len(binary), len(encoded), 0x4E4F534A)
           + encoded + struct.pack("<2I", len(binary), 0x004E4942) + binary)
    return struct.pack("<7I", 0x6D643362, 1, 28 + len(glb), 0, 0, 0, 0) + glb


def test_crunch_and_legacy_technique_become_real_webp_material_without_moving_geometry():
    crn = bytearray(74)
    crn[:2] = b"Hx"
    struct.pack_into(">HH", crn, 12, 16, 16)
    crn[17] = 1
    doc = {"asset": {"version": "2.0"}, "extensionsUsed": ["KHR_techniques_webgl", "CESIUM_RTC"],
           "extensions": {"KHR_techniques_webgl": {"techniques": []}, "CESIUM_RTC": {"center": [1, 2, 3]}},
           "buffers": [{"byteLength": 78}], "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 4},
                                                               {"buffer": 0, "byteOffset": 4, "byteLength": 74}],
           "images": [{"uri": "white-placeholder", "extras": {"compressedImage3DTiles": {"crunch": {"bufferView": 1}}}}],
           "textures": [{"source": 0, "sampler": 0}],
           "materials": [{"extensions": {"KHR_techniques_webgl": {"values": {"u_diffuse": {"index": 0, "texCoord": 0}}}}}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 1, "type": "SCALAR"}]}
    seen = []
    def decode(crn, *, max_edge):
        seen.append(crn)
        return b"RIFFwebp-test-image"
    tile = modernize_b3dm(make_tile(doc, b"abcd" + crn), decoder=decode)
    assert seen == [bytes(crn)]
    glb = tile[28:]
    length = struct.unpack_from("<I", glb, 12)[0]
    result = json.loads(glb[20:20 + length])
    assert result["images"] == [{"bufferView": 1, "mimeType": "image/webp"}]
    assert result["textures"][0]["extensions"]["EXT_texture_webp"]["source"] == 0
    assert result["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0
    assert result["extensions"]["CESIUM_RTC"] == {"center": [1, 2, 3]}
    assert result["accessors"] == doc["accessors"]
    assert glb[28 + length:32 + length] == b"abcd", "geometry bytes unchanged"
    assert struct.unpack_from("<I", tile, 8)[0] == len(tile)
    assert "KHR_techniques_webgl" not in result["extensionsUsed"]


def test_standard_materials_are_passed_through_without_conversion():
    tile = make_tile()
    assert modernize_b3dm(tile) is tile


@pytest.mark.parametrize("data", [b"", b"b3dm" + b"\0" * 60, make_tile()[:-4]])
def test_bad_container_lengths_fail_closed(data):
    with pytest.raises(ValueError):
        modernize_b3dm(data)


def test_source_texture_budget_is_checked_before_entering_native_decoder():
    header = bytearray(74)
    header[:2] = b"Hx"
    struct.pack_into(">HH", header, 12, 65535, 65535)
    with pytest.raises(ValueError):
        decode_atlas(header)


def test_a_hundred_atlas_parent_has_a_whole_tile_budget_not_a_hundred_megapixels():
    header = bytearray(74)
    header[:2] = b"Hx"
    struct.pack_into(">HH", header, 12, 1024, 1024)
    header[17] = 1
    count = 102
    doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": count * 74}],
           "bufferViews": [{"buffer": 0, "byteOffset": i * 74, "byteLength": 74} for i in range(count)],
           "images": [{"extras": {"compressedImage3DTiles": {"crunch": {"bufferView": i}}}} for i in range(count)]}
    edges = []
    def decode(_data, *, max_edge):
        edges.append(max_edge)
        return b"RIFF"
    modernize_b3dm(make_tile(doc, bytes(header) * count), decoder=decode)
    assert len(edges) == count and sum(edge * edge for edge in edges) <= MAX_TILE_TEXTURE_PIXELS
    assert all(128 < edge < 256 for edge in edges), "coarse parents cannot exhaust VRAM"
    full_pixels = sum(edge * edge for edge in edges)
    edges.clear()
    modernize_b3dm(make_tile(doc, bytes(header) * count), decoder=decode, overview=True)
    assert sum(edge * edge for edge in edges) <= MAX_OVERVIEW_TEXTURE_PIXELS
    assert full_pixels / sum(edge * edge for edge in edges) > 15, "far parents use about 1/16 of the texture upload, not full facade atlases"
