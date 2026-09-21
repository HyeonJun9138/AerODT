"""회전 부품과 actuator의 연결이 model package 안에서 닫혀 있는지 확인한다."""

from pathlib import Path

from digital_twin.model_library.compiler.compile_uam_package import load_jsonc

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / "digital_twin/model_library/packages/vehicles/air/tiltrotor_uam/aerodt_airtaxi/model.jsonc"


def _model():
    return load_jsonc(PACKAGE)


MODEL = _model()
VISUAL_LINKS = {link["name"] for link in MODEL["links"] if "visual" in link}
ACTUATORS = {item["name"]: item for item in MODEL["actuators"]}


def test_every_rotor_drives_a_link_that_is_actually_drawn():
    rotors = [a for a in MODEL["actuators"] if a["type"] == "rotor"]
    assert len(rotors) == 4
    for rotor in rotors:
        assert rotor["child-link"] in VISUAL_LINKS, rotor["name"]


def test_every_tilt_drives_a_drawn_nacelle_and_names_a_real_rotor():
    tilts = [a for a in MODEL["actuators"] if a["type"] == "tilt"]
    assert len(tilts) == 4
    for tilt in tilts:
        assert tilt["child-link"] in VISUAL_LINKS, tilt["name"]
        target = tilt["tilt-settings"]["target"]
        # A tilt actuator and the rotor it carries must resolve to drawn links.
        assert ACTUATORS[target]["type"] == "rotor"
        assert ACTUATORS[target]["child-link"] in VISUAL_LINKS


def test_rotor_and_nacelle_links_are_distinct_parts():
    rotor_links = {a["child-link"] for a in MODEL["actuators"] if a["type"] == "rotor"}
    tilt_links = {a["child-link"] for a in MODEL["actuators"] if a["type"] == "tilt"}
    assert len(rotor_links) == 4 and len(tilt_links) == 4
    assert not (rotor_links & tilt_links)


def test_the_compiler_carries_the_binding_into_the_runtime_config():
    compiler = (ROOT / "digital_twin/model_library/compiler/compile_uam_package.py").read_text(
        encoding="utf-8")
    # Without these the runtime configuration cannot bind the right propeller.
    assert compiler.count(".visual_link = {cpp_string(item['child-link'])},") == 2
