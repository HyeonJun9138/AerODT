"""Loopback-only asset QA preview. Does not expose the repository or start on import."""
import argparse
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import mimetypes

from asset_library import ROOT, LIBRARY, safe_path, check_id, write_json

OUTPUT = ROOT / "data/workspace/visual_assets/browser"
VENDOR = ROOT / "project_support/environment/visual_assets/node_modules/three"
PREVIEW = Path(__file__).parent / "preview"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        if route == "/favicon.ico":
            self.send_response(204); self.end_headers(); return
        roots = {"/library/": LIBRARY, "/vendor/": VENDOR, "/": PREVIEW}
        try:
            prefix = next(p for p in roots if route.startswith(p))
            file = safe_path(roots[prefix], route[len(prefix):] or "index.html")
            if not file.is_file():
                self.send_error(404); return
            content = file.read_bytes()
            mime = {".js": "text/javascript", ".wasm": "application/wasm", ".glb": "model/gltf-binary"}.get(file.suffix, mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            self.send_response(200); self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(content))); self.send_header("Cache-Control", "no-store")
            self.end_headers(); self.wfile.write(content)
        except (ValueError, OSError, StopIteration):
            self.send_error(404)

    def do_POST(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        if self.path != "/qa-result" or self.headers.get("Origin") != origin or self.headers.get("Host") != origin[7:]:
            self.send_error(403); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 2 * 1024 * 1024:
                raise ValueError("invalid length")
            result = json.loads(self.rfile.read(length))
            asset_id = check_id(result["asset_id"])
            catalog = json.loads((LIBRARY / "catalog.json").read_text(encoding="utf-8"))
            row = next(x for x in catalog["assets"] if x["asset_id"] == asset_id)
            meta = json.loads(safe_path(LIBRARY, row["metadata"]).read_text(encoding="utf-8"))
            flight = result.get('variant') == 'flight'
            expected = meta.get('flight_visual', meta['model']) if flight else meta['model']
            output_id = asset_id + ('_flight' if flight else '')
            if result["sha256"] != expected["sha256"]:
                raise ValueError("stale asset")
            picture = result.pop("thumbnail", None)
            if picture:
                binary = base64.b64decode(picture.split(",", 1)[1], validate=True)
                if not binary.startswith(b"\xff\xd8"):
                    raise ValueError("JPEG required")
                OUTPUT.mkdir(parents=True, exist_ok=True)
                (OUTPUT / f"{output_id}.jpg").write_bytes(binary)
            write_json(OUTPUT / f"{output_id}.json", result)
            self.send_response(204); self.end_headers()
        except (ValueError, KeyError, StopIteration, OSError):
            self.send_error(400)

    def log_message(self, fmt, *args):
        if str(args[1]) not in ("200", "204"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Asset QA: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
