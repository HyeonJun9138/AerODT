"""AeroDT V1의 물리적 폴더 경계와 UAM package를 검증한다."""

from __future__ import annotations

import json
from pathlib import Path

import commentjson


ROOT = Path(__file__).resolve().parents[3]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    required_layers = (
        "foundation",
        "communication",
        "data",
        "digital_twin",
        "ai_eng",
        "ai_pnp",
        "user_application",
    )
    for layer in required_layers:
        require((ROOT / layer).is_dir(), f"missing layer: {layer}")

    require((ROOT / "project_support").is_dir(), "missing project support container")
    forbidden_root_clutter = (
        ".venv",
        "build",
        "cmake",
        "configs",
        "docs",
        "examples",
        "ref",
        "tests",
        "tools",
        "workspace",
    )
    for name in forbidden_root_clutter:
        require(not (ROOT / name).exists(), f"root clutter is not allowed: {name}")

    stale_legacy = ROOT / "legacy"
    require(
        not stale_legacy.exists()
        or not any(path.is_file() for path in stale_legacy.rglob("*")),
        "files remain in the retired root legacy directory",
    )

    forbidden_legacy_roots = ("core_sim", "physics", "simserver", "vehicle_apis", "unreal")
    for name in forbidden_legacy_roots:
        require(not (ROOT / name).exists(), f"legacy folder leaked into root: {name}")

    require(
        not (ROOT / "project_support" / "reference").exists(),
        "external reference trees must not be vendored in the source repository",
    )

    package = (
        ROOT
        / "digital_twin"
        / "model_library"
        / "packages"
        / "vehicles"
        / "air"
        / "tiltrotor_uam"
        / "aerodt_airtaxi"
    )
    manifest = json.loads((package / "manifest.jsonc").read_text(encoding="utf-8"))
    require(manifest["physics"] == "fast-physics", "UAM physics must be FastPhysics")
    require(manifest["controller"] == "simple-flight", "UAM controller must be SimpleFlight")
    require(manifest["airframe"] == "vtol-quad-tiltrotor", "wrong UAM airframe")
    require(manifest["version"] == "0.2.2", "wrong UAM package version")
    require(manifest["sensors"] == "sensors.jsonc", "native sensor package is missing")

    model_text = (package / "model.jsonc").read_text(encoding="utf-8")
    require('"physics-type": "fast-physics"' in model_text, "model lost FastPhysics")
    require('"airframe-setup": "vtol-quad-tiltrotor"' in model_text, "model lost tiltrotor")
    require('"type": "simple-flight-api"' in model_text, "model lost SimpleFlight")

    model = commentjson.loads(model_text)
    require(
        "sensors" not in model,
        "legacy ProjectAirSim sensor backend is still declared in the host model",
    )
    rotors = [item for item in model["actuators"] if item["type"] == "rotor"]
    tilts = [item for item in model["actuators"] if item["type"] == "tilt"]
    require(len(rotors) == 4, "UAM model must contain four rotors")
    require(len(tilts) == 4, "UAM model must contain four tilt actuators")
    require(
        all(item["rotor-settings"]["smoothing-tc"] == 0.005 for item in rotors),
        "UAM rotor filter changed",
    )
    require(
        all(item["tilt-settings"]["angle-max"] == 1.57 for item in tilts),
        "UAM tilt range changed",
    )
    rotor_names = {item["name"] for item in rotors}
    require(
        all(item["tilt-settings"]["target"] in rotor_names for item in tilts),
        "tilt actuator target is invalid",
    )
    sensor_document = commentjson.loads(
        (package / manifest["sensors"]).read_text(encoding="utf-8")
    )
    sensor_ids = {item["id"] for item in sensor_document["sensors"] if item["enabled"]}
    require(
        sensor_document["mode"] == "ideal"
        and sensor_ids == {"IMU1", "GPS", "Chase", "DownCamera"},
        "native UAM sensor set is incomplete",
    )

    native_files = (
        ROOT
        / "digital_twin"
        / "simulation"
        / "include"
        / "aerodt"
        / "digital_twin"
        / "simulation"
    )
    require(
        (native_files / "fast_physics" / "fast_physics_engine.hpp").is_file(),
        "native FastPhysics engine is missing",
    )
    require(
        (native_files / "actuation" / "rotor_actuator.hpp").is_file(),
        "native rotor actuator is missing",
    )
    require(
        (native_files / "actuation" / "tilt_actuator.hpp").is_file(),
        "native tilt actuator is missing",
    )
    require(
        (native_files / "actuation" / "control_surface_actuator.hpp").is_file(),
        "native control-surface actuator is missing",
    )
    require(
        (native_files / "aerodynamics" / "aerodynamic_model.hpp").is_file(),
        "native aerodynamic model is missing",
    )
    require(
        (native_files / "contact" / "contact_response.hpp").is_file(),
        "native contact response is missing",
    )
    require(
        (native_files / "environment" / "flat_ground_contact_model.hpp").is_file(),
        "native flat-ground contact model is missing",
    )
    require(
        (native_files / "sensors" / "native_sensor_suite.hpp").is_file(),
        "native sensor suite is missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "pid_controller.hpp").is_file(),
        "native SimpleFlight PID is missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "tiltrotor_mixer.hpp").is_file(),
        "native SimpleFlight tiltrotor mixer is missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "flight_mode_transition.hpp").is_file(),
        "native SimpleFlight flight-mode transition is missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "simple_flight_parameters.hpp").is_file(),
        "typed SimpleFlight parameters are missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "ground_truth_state_estimator.hpp").is_file(),
        "native SimpleFlight ground-truth estimator is missing",
    )
    require(
        (native_files / "control" / "simple_flight" / "multirotor_cascade_controller.hpp").is_file(),
        "native SimpleFlight multirotor cascade is missing",
    )
    require(
        (ROOT / "digital_twin" / "model_library" / "compiler" / "compile_uam_package.py").is_file(),
        "UAM model package compiler is missing",
    )
    require(
        (
            ROOT
            / "digital_twin"
            / "runtime"
            / "include"
            / "aerodt"
            / "digital_twin"
            / "runtime"
            / "uam_vehicle_runtime.hpp"
        ).is_file(),
        "native UAM vehicle runtime is missing",
    )
    require(
        (
            ROOT
            / "user_application"
            / "uam_mission"
            / "include"
            / "aerodt"
            / "user_application"
            / "uam_mission"
            / "uam_mission_sequencer.hpp"
        ).is_file(),
        "native UAM mission sequencer is missing",
    )
    require(
        (
            ROOT
            / "user_application"
            / "apps"
            / "uam_native_demo"
            / "main.cpp"
        ).is_file(),
        "native UAM execution entry point is missing",
    )
    require(
        (
            ROOT
            / "data"
            / "include"
            / "aerodt"
            / "data"
            / "run_recorder.hpp"
        ).is_file(),
        "native Data Layer run recorder is missing",
    )
    require(
        (
            ROOT
            / "data"
            / "include"
            / "aerodt"
            / "data"
            / "sensor_telemetry_writer.hpp"
        ).is_file(),
        "native Data Layer sensor telemetry writer is missing",
    )
    require(
        (ROOT / "digital_twin" / "visualization" / "web").is_dir(),
        "CesiumJS visualization implementation is missing",
    )
    require(
        not (ROOT / "digital_twin" / "visualization" / "unreal").exists(),
        "retired Unreal host remains in the active visualization tree",
    )
    require(
        not (ROOT / "user_application" / "apps" / "uam_demo").exists(),
        "legacy Python UAM demo leaked into the active application tree",
    )
    require(
        not (
            ROOT
            / "digital_twin"
            / "runtime"
            / "python"
            / "aerodt"
            / "digital_twin"
            / "runtime"
            / "uam_mission.py"
        ).exists(),
        "duplicate Python mission implementation is still active",
    )
    print("AERODT_ARCHITECTURE=PASS")


if __name__ == "__main__":
    main()
