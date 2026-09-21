"""Native regression: operating cruise is physically reachable, not a display scale."""
import math
from pathlib import Path
import shutil

import pytest

from communication.python.manual_runtime import ManualRuntime
from digital_twin.model_library.compiler.compile_uam_package import compile_package, load_jsonc
import json

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / 'digital_twin/model_library/packages/vehicles/air/tiltrotor_uam/aerodt_airtaxi'

def test_full_power_cruise_deceleration_and_return_to_ground():
    runtime = ManualRuntime()
    try:
        assert 'v12' in runtime.lib._name
        for _ in range(100):
            sample = runtime.step(.36)
        for _ in range(900):
            sample = runtime.step(1, pitch=0, wing=True, steps=25)
        assert 78 < math.hypot(sample[4], sample[5]) < 81
        assert abs(sample[6]) < .5
        assert sample[10] > 89
        assert not sample[12]
        for _ in range(250):
            sample = runtime.step(.4, pitch=0, wing=True, steps=25)
        assert 25 < math.hypot(sample[4], sample[5]) < 55
        for _ in range(140):
            sample = runtime.step(.15, steps=25)
        assert sample[10] < 1
        for _ in range(2000):
            sample = runtime.step(0, steps=25)
            if sample[12]:
                break
        assert sample[12] == 1
        assert abs(sample[3]) < .01
    finally:
        runtime.close()

def test_directional_drag_preserves_side_and_vertical_coefficients(tmp_path):
    target = tmp_path/'runtime.cpp'
    compile_package(PACKAGE, target)
    faces = [line for line in target.read_text().splitlines() if 'drag_faces.push_back' in line]
    assert len(faces) == 6
    assert all('.drag_factor = 0.02}' in line for line in faces[:4])
    assert all('.drag_factor = 0.006025' in line for line in faces[4:])

@pytest.mark.parametrize('invalid', [[1,2], [True,.04,.04], [-1,.04,.04], [float('nan'),.04,.04]])
def test_invalid_directional_drag_rejected(tmp_path, invalid):
    package = tmp_path/'package'
    shutil.copytree(PACKAGE, package)
    model = load_jsonc(package/'model.jsonc')
    model['links'][0]['inertial']['aerodynamics']['drag-coefficient-body-xyz'] = invalid
    (package/'model.jsonc').write_text(json.dumps(model))
    with pytest.raises(ValueError, match='drag-coefficient-body-xyz'):
        compile_package(package, tmp_path/'runtime.cpp')

def test_scalar_legacy_package_retains_all_six_faces(tmp_path):
    package = tmp_path/'package'
    shutil.copytree(PACKAGE, package)
    model = load_jsonc(package/'model.jsonc')
    del model['links'][0]['inertial']['aerodynamics']['drag-coefficient-body-xyz']
    (package/'model.jsonc').write_text(json.dumps(model))
    target = tmp_path/'runtime.cpp'
    compile_package(package, target)
    faces = [line for line in target.read_text().splitlines() if 'drag_faces.push_back' in line]
    assert len(faces) == 6
    assert all('.drag_factor = 0.02}' in line for line in faces)
