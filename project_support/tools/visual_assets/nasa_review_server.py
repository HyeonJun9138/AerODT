"""Local-only manual browser review host; no browser automation."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import base64,json,hashlib
ROOT=Path(__file__).resolve().parents[3]
SHELF=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def do_POST(self):
        name=self.path.removeprefix('/save/')
        if not self.path.startswith('/save/') or name not in [p.name for p in SHELF.glob('nasa_*')]: self.send_error(404);return
        length=int(self.headers.get('Content-Length','0'))
        if not 0<length<2000000: self.send_error(400);return
        raw=self.rfile.read(length).decode('ascii')
        if not raw.startswith('data:image/jpeg;base64,'): self.send_error(400);return
        body=base64.b64decode(raw.split(',',1)[1],validate=True)
        from PIL import Image
        from io import BytesIO
        im=Image.open(BytesIO(body));im.thumbnail((760,480));im.save(SHELF/name/'thumbnail.jpg','JPEG',quality=86,optimize=True)
        p=SHELF/name/'asset.json';m=json.loads(p.read_text(encoding='utf8'));data=(SHELF/name/'thumbnail.jpg').read_bytes()
        m['thumbnail'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),width=im.width,height=im.height,view='Repaired model, manual browser studio render; no GLB loaded by the library shelf')
        p.write_text(json.dumps(m,ensure_ascii=False,indent=2),encoding='utf8')
        self.send_response(200);self.end_headers();self.wfile.write(b'ok')
ThreadingHTTPServer(('127.0.0.1',8879),Handler).serve_forever()
