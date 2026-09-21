"""Read-only local QA server; not the dashboard and not a simulator process.

Fixtures: data/workspace/navigation_benchmark/{snapshot,assets,routes}.json.
Visit http://127.0.0.1:8892/qa/navigation_performance_check.html after starting.
It never contacts the dashboard or loads credentials. Stop with Ctrl+C.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[3]
MOUNTS = {
    "communication": ROOT / "communication/browser",
    "visualization": ROOT / "digital_twin/visualization/web",
    "visual-assets": ROOT / "digital_twin/model_library/visual_assets",
    "static": ROOT / "user_application/web",
    "qa": ROOT / "project_support/tools/web_visualization",
    "bench": ROOT / "data/workspace/navigation_benchmark",
}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parts = unquote(urlparse(path).path).strip("/").split("/")
        if parts[0].startswith("nav") and parts[0][3:].isdigit():
            parts = parts[1:]
        base = MOUNTS.get(parts[0] if parts else "", MOUNTS["bench"] / "absent")
        target = base.joinpath(*parts[1:]).resolve()
        return str(target if target.is_relative_to(base.resolve()) else base / "absent")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8892), Handler).serve_forever()
