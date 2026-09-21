"""Acquire pinned weights and export ONNX using a restricted checkpoint loader.

Run only in the dedicated camera_detection environment described by the package.
No remote Python source is imported, and unknown pickle globals fail closed.
"""
import hashlib
import importlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'digital_twin/model_library/detection_models/flying_objects_v1'
REVISION = '07d22a0c022c349323ded7f8f5806e59cf420683'
SOURCE_HASH = 'd878939944007db445fdffe8283ad9ed4d9e6feba2ccb45ecc10f1142dac39a2'
SOURCE_URL = f'https://huggingface.co/Javvanny/yolov8m_flying_objects_detection/resolve/{REVISION}/yolov8m/weights/best.pt'
# Fixed audited classes from official installed torch/ultralytics wheels only.
# None implements a remote custom deserializer; nn.Module restores plain state.
SAFE_GLOBALS = (
    'torch.nn.modules.activation.SiLU', 'torch.nn.modules.batchnorm.BatchNorm2d',
    'torch.nn.modules.container.ModuleList', 'torch.nn.modules.container.Sequential',
    'torch.nn.modules.conv.Conv2d', 'torch.nn.modules.loss.BCEWithLogitsLoss',
    'torch.nn.modules.pooling.MaxPool2d', 'torch.nn.modules.upsampling.Upsample',
    'ultralytics.nn.modules.block.Bottleneck', 'ultralytics.nn.modules.block.C2f',
    'ultralytics.nn.modules.block.DFL', 'ultralytics.nn.modules.block.SPPF',
    'ultralytics.nn.modules.conv.Concat', 'ultralytics.nn.modules.conv.Conv',
    'ultralytics.nn.modules.head.Detect', 'ultralytics.nn.tasks.DetectionModel',
    'ultralytics.utils.IterableSimpleNamespace', 'ultralytics.utils.loss.BboxLoss',
    'ultralytics.utils.loss.v8DetectionLoss', 'ultralytics.utils.tal.TaskAlignedAssigner',
)


def main():
    import torch
    import ultralytics
    import onnx
    if tuple(map(int, torch.__version__.split('+')[0].split('.')[:2])) < (2, 6):
        raise RuntimeError('Restricted checkpoint conversion requires torch >= 2.6')
    if ultralytics.__version__ != '8.3.203': raise RuntimeError('Reviewed ultralytics 8.3.203 required')
    PACKAGE.mkdir(parents=True, exist_ok=True)
    source = PACKAGE / 'source.pt'
    if not source.is_file():
        temporary = source.with_suffix('.download')
        with urllib.request.urlopen(SOURCE_URL, timeout=90) as response, temporary.open('wb') as out:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 60 * 1024 * 1024: raise RuntimeError('Checkpoint download exceeds limit')
                out.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != SOURCE_HASH: raise RuntimeError('Source hash mismatch')
        temporary.replace(source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_HASH: raise RuntimeError('Source hash mismatch')
    unknown = set(torch.serialization.get_unsafe_globals_in_checkpoint(source)) - set(SAFE_GLOBALS)
    if unknown: raise RuntimeError(f'Unreviewed globals: {sorted(unknown)}')
    allowed = [getattr(importlib.import_module(name.rsplit('.', 1)[0]), name.rsplit('.', 1)[1]) for name in SAFE_GLOBALS]
    with torch.serialization.safe_globals(allowed):
        checkpoint = torch.load(source, map_location='cpu', weights_only=True)
    model = checkpoint['model'].float().eval()
    classes = [model.names[i] for i in range(len(model.names))]
    if classes != ['БПЛА коптер', 'самолет', 'вертолет', 'птица', 'БПЛА самелет']:
        raise RuntimeError(f'Unexpected class mapping: {classes}')
    from ultralytics.nn.modules.head import Detect
    for module in model.modules():
        if isinstance(module, Detect):
            module.export, module.format, module.dynamic = True, 'onnx', False
    torch.set_num_threads(2)
    artifact = PACKAGE / 'model.onnx'
    with torch.no_grad():
        torch.onnx.export(model, torch.zeros(1, 3, 640, 640), str(artifact),
            input_names=['images'], output_names=['detections'], opset_version=17,
            do_constant_folding=True, dynamo=False)
    onnx.checker.check_model(str(artifact))
    manifest = dict(schema_version=1, model_id='flying_objects_v1', source_repository='Javvanny/yolov8m_flying_objects_detection',
        revision=REVISION, source_url=SOURCE_URL, source_sha256=SOURCE_HASH,
        artifact='model.onnx', sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
        format='onnx', input_shape=[1, 3, 640, 640], source_classes=classes,
        classes=['Drone', 'Airplane', 'Helicopter', 'Bird', 'Fixed-wing drone'],
        class_mapping_note='Actual checkpoint has five foreground classes and no Background; model card is not the class index contract.',
        card_license='MIT (publisher claim)', dependency_license='Ultralytics AGPL-3.0 or Enterprise; not relicensed by the model card',
        license_review_required=True, license_url='https://www.ultralytics.com/license',
        conversion=dict(torch=torch.__version__, ultralytics=ultralytics.__version__, onnx=onnx.__version__,
            loader='torch.load(weights_only=True), fixed reviewed globals', safe_globals=list(SAFE_GLOBALS)),
        limitations=['No verified UAM-specific training', 'Ground-view training may not generalize to onboard synthetic imagery',
                    'No measured operational accuracy; no simulator ground-truth boxes'])
    (PACKAGE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'artifact': str(artifact), 'classes': classes, 'sha256': manifest['sha256']}))


if __name__ == '__main__': main()
