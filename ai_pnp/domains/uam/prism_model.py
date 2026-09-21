"""PyTorch-only future calculation; the web process may supply a worker adapter."""
import json
from pathlib import Path
import numpy as np


class PrismModel:
    def __init__(self,package_dir):
        import torch
        from digital_twin.model_library.prism_2d.catalog import describe_model
        from digital_twin.model_library.prism_2d.network import PrismPredictor
        root=Path(package_dir)
        if not describe_model(root)['ready']:raise ValueError('PRISM package unavailable')
        manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
        checkpoint=torch.load(root/'model.pt',map_location='cpu',weights_only=True)
        if checkpoint['model_cfg']!=manifest['model_cfg']:raise ValueError('PRISM model config mismatch')
        self.model=PrismPredictor(manifest['model_cfg']).eval()
        self.model.load_state_dict(checkpoint['model'],strict=True)

    def predict_batch(self,samples):
        import torch
        from digital_twin.model_library.prism_2d.constants import POS_SCALE
        x=np.stack([s['x'] for s in samples]).astype(np.float32)
        mask=np.stack([s['agent_mask'] for s in samples]).astype(np.float32)
        if x.shape[1:]!=(10,20,13) or mask.shape!=(len(samples),10) or not np.isfinite(x).all():
            raise ValueError('PRISM input shape or finite contract violated')
        with torch.inference_mode():
            result=self.model(torch.from_numpy(x),torch.from_numpy(mask))
            mu=result['mu'].numpy()*POS_SCALE
            sigma=np.exp(result['log_sigma'].numpy())*POS_SCALE
            rho=result['rho'].numpy()
            weights=torch.softmax(result['mode_logits'],dim=-1).numpy()
            types=torch.softmax(result['type_logits'],dim=-1).numpy()
        cov=np.zeros((*rho.shape,2,2))
        cov[...,0,0]=sigma[...,0]**2;cov[...,1,1]=sigma[...,1]**2
        cov[...,0,1]=cov[...,1,0]=rho*sigma[...,0]*sigma[...,1]
        return [{'mu':mu[i],'covariance':cov[i],'weights':weights[i],
                 'type_probabilities':types[i]} for i in range(len(samples))]
