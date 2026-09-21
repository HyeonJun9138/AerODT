"""Publish verified browser flight portraits without changing source models."""
import hashlib,json,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
IDS=['projectairsim_airtaxi','kp2a','joby_s4','amvlab_evtol','x_57']

def main():
    prepared=[]
    for identifier in IDS:
        directory=ROOT/'digital_twin/model_library/visual_assets/aircraft/civilian'/identifier
        report=json.loads((ROOT/f'data/workspace/visual_assets/browser/{identifier}_flight.json').read_text(encoding='utf-8'))
        meta=json.loads((directory/'asset.json').read_text(encoding='utf-8'))
        visual=meta.get('flight_visual',meta['model'])
        assert report['status']=='passed' and report['variant']=='flight'
        assert report['sha256']==visual['sha256']==hashlib.sha256((directory/visual['path']).read_bytes()).hexdigest(),identifier+' stale capture'
        source=ROOT/f'data/workspace/visual_assets/browser/{identifier}_flight.jpg'
        image=source.read_bytes();assert image.startswith(b'\xff\xd8')
        sha=hashlib.sha256(image).hexdigest();filename='thumbnail_flight_'+sha[:12]+'.jpg'
        prepared.append((directory,meta,source,filename,sha,visual['sha256']))
    for directory,meta,source,filename,sha,model_sha in prepared:
        shutil.copyfile(source,directory/filename)
        meta['thumbnail']={'path':filename,'bytes':source.stat().st_size,'sha256':sha,
            'source_model_sha256':model_sha,'variant':'flight','width':960,'height':640,
            'view':'neutral VTOL front three-quarter, model-specific framing, grey studio background'}
        (directory/'asset.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(meta['asset_id'],filename)
if __name__=='__main__':main()
