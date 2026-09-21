"""Collect a reviewed, pinned selection; not an unrestricted marketplace scraper."""
import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from asset_library import LIBRARY, SOURCES, add_asset, prepare_model, rebuild_catalog, write_json

NASA_REV = "11ebb4ee043715aefbba6aeec8a61746fad67fa7"
AMV_REV = "91d835e8e851b2317fe79af291c9fed6153fd525"
NASA_FOLDERS = {
    "global_hawk": "Global Hawk", "x_57": "X-57",
    "ace": "Advanced Composition Explorer", "aim": "Aeronomy of Ice in the Mesosphere",
    "acrimsat": "Active Cavity Irradiance Monitor Satellite (AcrimSAT) (A)",
    "cluster_ii": "Cluster II", "cnofs": "Communication and Navigation Outage Forecast System (CNOFS)",
    "cubesat_2u": "CubeSat - 2 RU Generic", "icecube": "CubeSat - ICECube", "mirata": "CubeSat - MiRaTa",
    "dscovr": "Deep Space Climate Observatory (DSCOVR) (Triana)", "rhessi": "HESSI-RHESSI",
    "icesat": "Ice, Clouds, and Land Elevation Satellite (ICESat) (A)", "kepler": "Kepler (A)",
    "landsat_1_3": "Landsat 1, 2, and 3", "landsat_4_5": "Landsat 4 and 5", "mir": "Mir",
    "roman": "Nancy Grace Roman Space Telescope (A)", "jason_2": "Ocean Surface Topography Mission (OSTM Jason-2)",
    "quikscat": "Quick Scatterometer (QuikSCAT)", "seastar": "SeaStar", "skylab": "Skylab",
    "stereo": "Solar TErrestrial RElations Observatory (STEREO)", "soho": "Solar and Heliospheric Observatory",
    "spitzer": "Spitzer Space Telescope", "suzaku": "Suzaku",
    "trmm": "Tropical Rainfall Measuring Mission (TRMM)", "wmap": "Wilkinson Microwave Anisotropy Probe (WMAP)",
    "wind": "Wind",
}


def fetch(url: str, destination: Path) -> bytes:
    if destination.is_file():
        return destination.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "AeroDT-VisualAssetIntake/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("asset exceeds intake size limit (64 MiB)")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return data


def raw_url(repo, revision, path):
    return f"https://raw.githubusercontent.com/{repo}/{revision}/" + urllib.parse.quote(path, safe="/")


def cache_folder(provider: str, revision: str) -> Path:
    if provider not in ("nasa", "amvlab") or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("invalid pinned source revision")
    return SOURCES / provider / revision


def download_all():
    results, pending = [], []
    nasa_dir = cache_folder("nasa", NASA_REV)
    tree = json.loads(fetch(f"https://api.github.com/repos/nasa/NASA-3D-Resources/git/trees/{NASA_REV}?recursive=1", nasa_dir / "tree.json"))
    for repo, rev, source_id, documents in [
        ("nasa/NASA-3D-Resources", NASA_REV, "nasa", ["README.md", "meta.json"]),
        ("amvlab/aircraft-models", AMV_REV, "amvlab", ["README.md", "LICENSE"]),
    ]:
        for name in documents:
            fetch(raw_url(repo, rev, name), cache_folder(source_id, rev) / name.lower())
    for asset_id, folder in NASA_FOLDERS.items():
        candidates = [x for x in tree["tree"] if x["path"].startswith(f"3D Models/{folder}/") and x["path"].endswith(".glb")]
        if len(candidates) != 1:
            pending.append({"asset_id": asset_id, "reason": "requires manual variant selection", "candidates": candidates})
            continue
        path = candidates[0]["path"]
        url = raw_url("nasa/NASA-3D-Resources", NASA_REV, path)
        try:
            original = fetch(url, nasa_dir / asset_id / "source.glb")
            # Verify Git blob id from pinned tree, not just transfer length.
            git_hash = hashlib.sha1(b"blob " + str(len(original)).encode() + b"\0" + original).hexdigest()
            if git_hash != candidates[0]["sha"]:
                raise ValueError("pinned Git blob hash mismatch")
            output, conversion = prepare_model(original, repair=asset_id in ("jason_2", "quikscat"))
            category = "aircraft/military" if asset_id == "global_hawk" else "aircraft/civilian" if asset_id == "x_57" else "spacecraft/satellites"
            meta = {
                "title": folder, "source": {"provider": "nasa", "url": url, "revision": NASA_REV, "original_file": path},
                "rights": {"label": "NASA media guidelines", "url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
                    "credit": "NASA 3D Resources; individual contributor credit should be retained where supplied",
                    "public_export": True, "note": "NASA repository asset declaration applies; no endorsement. Logos and third-party rights remain separate. Repository meta.json also names NOSA 1.3; retained for review."},
                "representation": "research_livery_military_origin" if asset_id == "global_hawk" else "generic" if asset_id == "cubesat_2u" else "mission_visualization",
                "display": {"native_extent": None, "reference_extent_m": None, "scale_basis": "unverified; preview auto-fit only", "forward_axis": "unverified"},
                "aliases": [],
            }
            meta["conversion"] = conversion
            add_asset(LIBRARY, asset_id, category, output, meta)
            results.append(asset_id)
        except Exception as exc:
            pending.append({"asset_id": asset_id, "source": url, "reason": str(exc)})
    for name in ["A320", "A350", "A380", "B737", "B787", "EVTOL", "drone"]:
        asset_id = "amvlab_" + name.lower()
        path = f"models/{name}_nologo.glb"
        url = raw_url("amvlab/aircraft-models", AMV_REV, path)
        try:
            original = fetch(url, cache_folder("amvlab", AMV_REV) / asset_id / "source.glb")
            meta = {"title": name + " (logo-free)",
                "source": {"provider": "amvlab", "url": url, "revision": AMV_REV, "original_file": path},
                "rights": {"label": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/",
                    "credit": "amvlab / aircraft-models", "public_export": True,
                    "note": "Retain attribution, license link and modification notice. No manufacturer endorsement or accuracy certification."},
                "representation": "generic" if name in ("EVTOL", "drone") else "type_visualization",
                "aliases": [], "display": {"native_extent": None, "reference_extent_m": None, "scale_basis": "unverified; preview auto-fit only", "forward_axis": "unverified"}}
            output, conversion = prepare_model(original, repair=name == "A320")
            meta["conversion"] = conversion
            add_asset(LIBRARY, asset_id, "aircraft/civilian", output, meta)
            results.append(asset_id)
        except Exception as exc:
            pending.append({"asset_id": asset_id, "source": url, "reason": str(exc)})
    rebuild_catalog(LIBRARY)
    write_json(SOURCES / "public_intake.json", {"collected": results, "pending": pending})
    print(json.dumps({"collected": len(results), "pending": pending}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    download_all()
