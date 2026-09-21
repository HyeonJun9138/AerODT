"""PRISM model-only JSONL worker. No World, history or flight execution here."""
import argparse
import json
import sys
import numpy as np


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--package',required=True);args=parser.parse_args()
    from ai_pnp.domains.uam.prism_model import PrismModel
    import torch
    torch.set_num_threads(2)
    model=PrismModel(args.package)
    for line in sys.stdin:
        try:
            request=json.loads(line)
            if request.get('schema_version')!=1:raise ValueError('unsupported protocol')
            rows=request['samples']
            if not isinstance(rows,list) or not 1<=len(rows)<=16:raise ValueError('batch size')
            samples=[]
            for row in rows:
                x=np.asarray(row['x'],dtype=np.float32);mask=np.asarray(row['agent_mask'],dtype=np.float32)
                if x.ndim!=3 or x.shape[1:]!=(20,13) or x.shape[0]>32 or mask.shape!=(x.shape[0],):raise ValueError('shape')
                if not np.isfinite(x).all() or not np.isfinite(mask).all():raise ValueError('non-finite')
                samples.append({'x':x,'agent_mask':mask})
            values=model.predict_batch(samples)
            reply={'result':[{key:(value.tolist() if hasattr(value,'tolist') else value) for key,value in row.items()} for row in values]}
        except Exception:reply={'error':'invalid_input_or_inference'}
        print(json.dumps(reply,allow_nan=False,separators=(',',':')),flush=True)

if __name__=='__main__':main()
