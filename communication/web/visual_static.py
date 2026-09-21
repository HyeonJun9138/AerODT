"""Bounded, revalidated GLB responses without per-64 KiB thread-pool reads."""
import asyncio
import gzip
from collections import OrderedDict
from pathlib import Path

from starlette.datastructures import Headers
from starlette.responses import FileResponse, Response
from starlette.staticfiles import StaticFiles, NotModifiedResponse

from communication.web.vworld_routes import accepts_gzip


class BufferedModelFiles(StaticFiles):
    def __init__(self, *args, cache_bytes=32*1024*1024, file_bytes=20*1024*1024, **kwargs):
        super().__init__(*args, **kwargs)
        self.cache_bytes, self.file_bytes = cache_bytes, file_bytes
        self.cache = OrderedDict()
        self.preparing = {}
        self.bytes = 0
        self.slots = asyncio.Semaphore(2)

    @staticmethod
    def read_model(path, signature, limit):
        with open(path, 'rb') as file:
            data = file.read(limit+1)
        stat = Path(path).stat()
        if len(data)>limit or (stat.st_mtime_ns, stat.st_size)!=signature:
            return None
        return data, gzip.compress(data, compresslevel=3, mtime=0)

    async def prepare(self, key, signature):
        async with self.slots:
            value = await asyncio.to_thread(self.read_model, key[0], signature, self.file_bytes)
        if value is not None:
            size = sum(map(len, value))
            if size<=self.cache_bytes:
                # Remove earlier versions of this file as well as oldest entries.
                for old in list(self.cache):
                    if old[0]==key[0]:
                        self.bytes-=sum(map(len, self.cache.pop(old)))
                while self.cache and self.bytes+size>self.cache_bytes:
                    _, evicted = self.cache.popitem(last=False)
                    self.bytes-=sum(map(len, evicted))
                self.cache[key]=value
                self.bytes+=size
        return value

    async def get_response(self, path, scope):
        # StaticFiles remains responsible for traversal/symlink checks, methods,
        # existence, validators and range handling; only small complete GLBs buffer.
        response = await super().get_response(path, scope)
        response.headers['Cache-Control']='no-cache'
        headers = Headers(scope=scope)
        if (not isinstance(response, FileResponse) or not path.lower().endswith('.glb')
                or headers.get('range') or response.stat_result.st_size>self.file_bytes):
            return response
        stat = response.stat_result
        signature = (stat.st_mtime_ns, stat.st_size)
        key = (response.path, *signature)
        value = self.cache.get(key)
        if value is not None:
            self.cache.move_to_end(key)
        else:
            task = self.preparing.get(key)
            if task is None:
                if len(self.preparing)>=8:
                    return response
                task = asyncio.create_task(self.prepare(key, signature))
                self.preparing[key]=task
                def finished(done):
                    self.preparing.pop(key, None)
                    if not done.cancelled():
                        done.exception()
                task.add_done_callback(finished)
            # Disconnecting one client must not cancel another client's shared read.
            value = await asyncio.shield(task)
        if value is None:
            return response
        encoded = accepts_gzip(headers.get('accept-encoding', ''))
        body = value[1 if encoded else 0]
        result_headers = dict(response.headers)
        result_headers.update({'vary':'Accept-Encoding', 'content-length':str(len(body))})
        if encoded:
            result_headers['content-encoding']='gzip'
            result_headers['etag']=response.headers['etag'].rstrip('"')+'-gzip"'
        if self.is_not_modified(Headers(result_headers), headers):
            return NotModifiedResponse(result_headers)
        return Response(content=b'' if scope['method']=='HEAD' else body,
                        headers=result_headers, media_type='model/gltf-binary')
