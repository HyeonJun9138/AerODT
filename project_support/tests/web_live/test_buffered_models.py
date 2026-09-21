import asyncio
import gzip
import os

import httpx
from starlette.applications import Starlette
from starlette.routing import Mount

from communication.web.visual_static import BufferedModelFiles


def test_model_encodings_revalidation_head_and_changed_file(tmp_path):
    async def run():
        payload=b'glTF'+b'12345678'*10000
        file=tmp_path/'flight.glb'
        file.write_bytes(payload)
        files=BufferedModelFiles(directory=tmp_path)
        app=Starlette(routes=[Mount('/',app=files)])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            response=await client.get('/flight.glb',headers={'Accept-Encoding':'gzip'})
            assert response.content==payload
            assert response.headers['content-encoding']=='gzip'
            assert int(response.headers['content-length'])==len(gzip.compress(payload,compresslevel=3,mtime=0))
            etag=response.headers['etag']
            assert (await client.get('/flight.glb',headers={'If-None-Match':etag})).status_code==304
            plain=await client.get('/flight.glb',headers={'Accept-Encoding':'gzip;q=0, identity'})
            assert plain.content==payload and 'content-encoding' not in plain.headers
            assert plain.headers['etag']!=etag
            head=await client.head('/flight.glb',headers={'Accept-Encoding':'gzip'})
            assert not head.content and head.headers['content-length']==response.headers['content-length']
            file.write_bytes(b'changed'+payload)
            changed=await client.get('/flight.glb',headers={'If-None-Match':etag})
            assert changed.status_code==200 and changed.content==b'changed'+payload
            assert len(files.cache)==1
            assert (await client.get('/%2e%2e/private.glb')).status_code in (404,405)
            assert (await client.post('/flight.glb')).status_code==405
    asyncio.run(run())


def test_model_read_coalesces_and_evicts_under_byte_budget(tmp_path):
    async def run():
        for i in range(3):
            (tmp_path/f'{i}.glb').write_bytes(os.urandom(2048))
        files=BufferedModelFiles(directory=tmp_path,cache_bytes=9000)
        count=0
        original=files.read_model
        def read(*args):
            nonlocal count
            count+=1
            return original(*args)
        files.read_model=read
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=files),base_url='http://test') as client:
            replies=await asyncio.gather(*(client.get('/0.glb') for _ in range(10)))
            assert all(r.status_code==200 for r in replies) and count==1
            for i in (1,2):
                await client.get(f'/{i}.glb')
            assert files.bytes<=9000 and len(files.cache)==2
    asyncio.run(run())


def test_model_range_and_oversized_files_keep_static_response(tmp_path):
    async def run():
        data=b'glTF0123456789'
        (tmp_path/'small.glb').write_bytes(data)
        files=BufferedModelFiles(directory=tmp_path,file_bytes=5)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=files),base_url='http://test') as client:
            response=await client.get('/small.glb',headers={'Accept-Encoding':'identity'})
            assert response.content==data and not files.cache
            files.file_bytes=100
            partial=await client.get('/small.glb',headers={'Range':'bytes=4-7','Accept-Encoding':'gzip'})
            assert partial.status_code==206 and partial.content==data[4:8]
            assert 'content-encoding' not in partial.headers and not files.cache
    asyncio.run(run())
