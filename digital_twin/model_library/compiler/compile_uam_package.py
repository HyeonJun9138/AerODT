"""JSONC UAM package를 dependency-free C++ runtime configuration으로 컴파일한다."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def strip_json_comments(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
        elif char == "/" and next_char == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
        elif char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(text) and text[index : index + 2] != "*/":
                index += 1
            index += 2
        else:
            output.append(char)
            index += 1
    return "".join(output)


def load_jsonc(path: Path) -> dict[str, Any]:
    return json.loads(strip_json_comments(path.read_text(encoding="utf-8")))


def vector(value: str | None) -> tuple[float, float, float]:
    values = tuple(float(item) for item in (value or "0 0 0").split())
    if len(values) != 3 or not all(math.isfinite(item) for item in values):
        raise ValueError(f"invalid Vector3: {value!r}")
    return values  # type: ignore[return-value]


def number(value: float) -> str:
    result = format(float(value), ".17g")
    return result if any(marker in result for marker in ".eE") else result + ".0"


def cpp_vector(value: tuple[float, float, float]) -> str:
    return "{" + ", ".join(number(item) for item in value) + "}"


def cpp_string(value: str) -> str:
    return json.dumps(value)


def quaternion_from_rpy_deg(value: str | None) -> tuple[float, float, float, float]:
    roll, pitch, yaw = (math.radians(item) for item in vector(value))
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return (
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    )


def cpp_quaternion(value: tuple[float, float, float, float]) -> str:
    return "{" + ", ".join(number(item) for item in value) + "}"


def geometry_inertia(inertial: dict[str, Any]) -> tuple[float, float, float]:
    mass = float(inertial.get("mass", 0.0))
    inertia = inertial.get("inertia", {})
    if inertia.get("type") == "matrix":
        return float(inertia["ixx"]), float(inertia["iyy"]), float(inertia["izz"])
    box = inertia.get("geometry", {}).get("box") if inertia.get("type") == "geometry" else None
    if not box:
        return 0.0, 0.0, 0.0
    x, y, z = vector(box["size"])
    return (
        mass * (y * y + z * z) / 12.0,
        mass * (x * x + z * z) / 12.0,
        mass * (x * x + y * y) / 12.0,
    )


def aggregate_inertia(links: list[dict[str, Any]]) -> tuple[float, float, float]:
    result = list(geometry_inertia(links[0]["inertial"]))
    for link in links[1:]:
        inertial = link.get("inertial", {})
        mass = float(inertial.get("mass", 0.0))
        x, y, z = vector(inertial.get("origin", {}).get("xyz"))
        own = geometry_inertia(inertial)
        result[0] += own[0] + mass * (y * y + z * z)
        result[1] += own[1] + mass * (x * x + z * z)
        result[2] += own[2] + mass * (x * x + y * y)
    return tuple(result)  # type: ignore[return-value]


def aerodynamic_cross_section(inertial: dict[str, Any]) -> tuple[float, float, float]:
    aerodynamics = inertial.get("aerodynamics", {})
    if aerodynamics.get("type") == "cross-section-areas":
        return vector(aerodynamics["cross-section-areas-xyz"])
    if aerodynamics.get("type") != "geometry":
        return 0.0, 0.0, 0.0
    geometry = aerodynamics.get("geometry", {})
    if "box" in geometry:
        x, y, z = vector(geometry["box"]["size"])
        return y * z, x * z, x * y
    if "cylinder" in geometry:
        radius = float(geometry["cylinder"]["radius"])
        length = float(geometry["cylinder"]["length"])
        return 2 * radius * length, 2 * radius * length, math.pi * radius * radius
    return 0.0, 0.0, 0.0


def lift_parameters(data: dict[str, Any]) -> str:
    return """{
          .alpha_zero_rad = %s,
          .alpha_stall_rad = %s,
          .lift_slope_per_rad = %s,
          .lift_stall_slope_per_rad = %s,
          .drag_slope_per_rad = %s,
          .drag_stall_slope_per_rad = %s,
          .moment_slope_per_rad = %s,
          .moment_stall_slope_per_rad = %s,
          .area_m2 = %s,
          .control_lift_per_rad = %s,
          .control_drag_per_rad = %s,
          .control_moment_per_rad = %s,
          .center_of_pressure_surface_m = %s,
          .forward_surface = %s,
          .upward_surface = %s,
      }""" % (
        number(data.get("alpha-0", 0.0)),
        number(data.get("alpha-stall", 0.0)),
        number(data.get("c-lift-alpha", 0.0)),
        number(data.get("c-lift-alpha-stall", 0.0)),
        number(data.get("c-drag-alpha", 0.0)),
        number(data.get("c-drag-alpha-stall", 0.0)),
        number(data.get("c-moment-alpha", 0.0)),
        number(data.get("c-moment-alpha-stall", 0.0)),
        number(data.get("area", 0.0)),
        number(data.get("control-surface-cl-per-rad", 0.0)),
        number(data.get("control-surface-cd-per-rad", 0.0)),
        number(data.get("control-surface-cm-per-rad", 0.0)),
        cpp_vector(vector(data.get("center-pressure-xyz"))),
        cpp_vector(vector(data.get("forward-xyz", "1 0 0"))),
        cpp_vector(vector(data.get("upward-xyz", "0 0 -1"))),
    )


# The airframes SimpleFlight allocates controls for, with the actuator
# topology each one requires of a package. Mirrors simulation's Airframe enum.
AIRFRAMES: dict[str, dict[str, Any]] = {
    "vtol-quad-tiltrotor": {"enum": "vtol_quad_tiltrotor", "rotors": 4, "tilts": 4,
                            "lifting_surfaces": True, "fixed_wing_capable": True},
    "quadrotor-x": {"enum": "quadrotor_x", "rotors": 4, "tilts": 0,
                    "lifting_surfaces": False, "fixed_wing_capable": False},
    "hexarotor-x": {"enum": "hexarotor_x", "rotors": 6, "tilts": 0,
                    "lifting_surfaces": False, "fixed_wing_capable": False},
}
DEFAULT_SYMBOL = "LoadAeroDTAirTaxiRuntimeConfig"


def airframe_of(manifest: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    name = manifest.get("airframe")
    airframe = AIRFRAMES.get(name)
    if airframe is None:
        raise ValueError(f"unsupported airframe {name!r}; one of {', '.join(AIRFRAMES)}")
    declared = model.get("controller", {}).get("airframe-setup")
    if declared != name:
        raise ValueError(f"model airframe-setup {declared!r} does not match manifest airframe {name!r}")
    return dict(airframe, name=name)


def check_topology(airframe: dict[str, Any], rotors: list, tilts: list, lift_links: list) -> None:
    if len(rotors) != airframe["rotors"]:
        raise ValueError(f"airframe {airframe['name']} needs {airframe['rotors']} rotors, package has {len(rotors)}")
    if len(tilts) != airframe["tilts"]:
        raise ValueError(f"airframe {airframe['name']} needs {airframe['tilts']} tilt actuators, package has {len(tilts)}")
    if lift_links and not airframe["lifting_surfaces"]:
        raise ValueError(f"airframe {airframe['name']} carries no lifting surfaces")


def compile_package(package: Path, output: Path, symbol: str = DEFAULT_SYMBOL) -> None:
    manifest = load_jsonc(package / "manifest.jsonc")
    model = load_jsonc(package / manifest["model"])
    scene = load_jsonc(package / manifest["scene"])
    sensor_document = load_jsonc(package / manifest["sensors"])
    if manifest["physics"] != "fast-physics" or manifest["controller"] != "simple-flight":
        raise ValueError("AeroDT V1 package must use FastPhysics and SimpleFlight")
    airframe = airframe_of(manifest, model)

    links = model["links"]
    root = links[0]
    root_inertial = root["inertial"]
    mass = float(root_inertial["mass"])
    inertia = aggregate_inertia(links)
    cross_sections = [aerodynamic_cross_section(link.get("inertial", {})) for link in links]
    cross_section = tuple(sum(item[axis] for item in cross_sections) for axis in range(3))
    root_aero = root_inertial["aerodynamics"]
    body_box = vector(root_aero["geometry"]["box"]["size"])
    root_collision_box = root_inertial.get("inertia", {}).get("geometry", {}).get("box")
    if not root_collision_box:
        raise ValueError("AeroDT V1 root link requires a box collision proxy")
    collision_box = vector(root_collision_box["size"])
    body_ground_clearance = collision_box[2] / 2.0
    # Optional body-axis coefficients retain the scalar package default.
    coefficients = root_aero.get("drag-coefficient-body-xyz",
                                 [root_aero["drag-coefficient"]] * 3)
    if (not isinstance(coefficients, list) or len(coefficients) != 3 or
            any(isinstance(x, bool) or not isinstance(x, (int, float)) or
                not math.isfinite(x) or x < 0 for x in coefficients)):
        raise ValueError("drag-coefficient-body-xyz must contain three finite non-negative numbers")
    drag_factors = [float(x) / 2.0 for x in coefficients]
    drag_faces = [
        ((0.0, 0.0, -body_box[2] / 2), (0.0, 0.0, -1.0), cross_section[2]),
        ((0.0, 0.0, body_box[2] / 2), (0.0, 0.0, 1.0), cross_section[2]),
        ((0.0, -body_box[1] / 2, 0.0), (0.0, -1.0, 0.0), cross_section[1]),
        ((0.0, body_box[1] / 2, 0.0), (0.0, 1.0, 0.0), cross_section[1]),
        ((-body_box[0] / 2, 0.0, 0.0), (-1.0, 0.0, 0.0), cross_section[0]),
        ((body_box[0] / 2, 0.0, 0.0), (1.0, 0.0, 0.0), cross_section[0]),
    ]

    actuators = model["actuators"]
    control_by_parent = {
        item["parent-link"]: item
        for item in actuators
        if item["type"] == "lift-drag-control-surface"
    }
    rotors = [item for item in actuators if item["type"] == "rotor" and item.get("enabled", True)]
    tilts = [item for item in actuators if item["type"] == "tilt" and item.get("enabled", True)]
    lift_links = [
        link
        for link in links
        if link.get("inertial", {}).get("aerodynamics", {}).get("type") == "lift-drag"
    ]
    controller = model["controller"]["simple-flight-api-settings"]
    actuator_order = [entry["id"] for entry in controller["actuator-order"]]
    check_topology(airframe, rotors, tilts, lift_links)
    fixed_wing_capable = bool(airframe["fixed_wing_capable"])
    sensors = sensor_document["sensors"]
    if sensor_document.get("version") != 1 or sensor_document.get("mode") != "ideal":
        raise ValueError("AeroDT UAM V1 requires version 1 ideal native sensors")
    sensor_ids = [item["id"] for item in sensors]
    if len(sensor_ids) != len(set(sensor_ids)):
        raise ValueError("native sensor IDs must be unique")
    if any(item.get("parent-link") != "Frame" for item in sensors):
        raise ValueError("AeroDT UAM V1 sensors must be mounted to Frame")
    home = scene["home-geo-point"]

    lines = [
        "// Generated by compile_uam_package.py. Do not edit.",
        '#include "aerodt/digital_twin/runtime/uam_runtime_config.hpp"',
        "",
        "namespace aerodt::digital_twin::runtime {",
        f"UamRuntimeConfig {symbol}() {{",
        "  UamRuntimeConfig config;",
        f"  config.package_id = {cpp_string(manifest['package-id'])};",
        f"  config.package_version = {cpp_string(manifest['version'])};",
        f"  config.entity_id = {cpp_string(scene['actors'][0]['name'])};",
        f"  config.physics_id = {cpp_string(manifest['physics'])};",
        f"  config.controller_id = {cpp_string(manifest['controller'])};",
        f"  config.airframe_id = {cpp_string(manifest['airframe'])};",
        f"  config.airframe = simulation::control::simple_flight::Airframe::{airframe['enum']};",
        f"  config.step = std::chrono::nanoseconds({int(scene['clock']['step-ns'])});",
        f"  config.initial_position_ned_m = {cpp_vector(vector(scene['actors'][0]['origin']['xyz']))};",
        "  config.initial_orientation_body_to_ned = "
        f"{cpp_quaternion(quaternion_from_rpy_deg(scene['actors'][0]['origin'].get('rpy-deg')))};",
        f"  config.body_ground_clearance_m = {number(body_ground_clearance)};",
        f"  config.fast_physics.mass_kg = {number(mass)};",
        "  config.fast_physics.inertia_body_kg_m2 = foundation::math::Matrix3::Diagonal(" +
        ", ".join(number(item) for item in inertia) + ");",
        f"  config.contact.restitution = {number(root.get('collision', {}).get('restitution', 0.0))};",
        f"  config.contact.friction = {number(root.get('collision', {}).get('friction', 0.0))};",
        f"  config.sensors.home_latitude_deg = {number(home['latitude'])};",
        f"  config.sensors.home_longitude_deg = {number(home['longitude'])};",
        f"  config.sensors.home_altitude_m = {number(home['altitude'])};",
        "  config.sensors.gravity_mps2 = config.fast_physics.gravity_ned_mps2.z;",
    ]
    for position, normal, area in drag_faces:
        axis = max(range(3), key=lambda i: abs(normal[i]))
        drag_factor = drag_factors[axis]
        lines.append(
            "  config.fast_physics.drag_faces.push_back({"
            f".position_body_m = {cpp_vector(position)}, "
            f".outward_normal_body = {cpp_vector(normal)}, "
            f".area_m2 = {number(area)}, .drag_factor = {number(drag_factor)}}});"
        )
    for item in rotors:
        settings = item["rotor-settings"]
        direction = (
            "simulation::actuation::RotorTurningDirection::clockwise"
            if settings["turning-direction"] == "clock-wise"
            else "simulation::actuation::RotorTurningDirection::counter_clockwise"
        )
        lines.extend([
            "  config.rotors.push_back({",
            f"      .id = {cpp_string(item['name'])},",
            f"      .visual_link = {cpp_string(item['child-link'])},",
            "      .parameters = {",
            f"          .position_body_m = {cpp_vector(vector(item.get('origin', {}).get('xyz')))},",
            f"          .normal_rotor = {cpp_vector(vector(settings['normal-vector']))},",
            f"          .turning_direction = {direction},",
            f"          .coefficient_of_thrust = {number(settings['coeff-of-thrust'])},",
            f"          .coefficient_of_torque = {number(settings['coeff-of-torque'])},",
            f"          .max_rpm = {number(settings['max-rpm'])},",
            f"          .propeller_diameter_m = {number(settings['propeller-diameter'])},",
            f"          .smoothing_time_constant_s = {number(settings['smoothing-tc'])},",
            "      },",
            "  });",
        ])
    for item in tilts:
        settings = item["tilt-settings"]
        lines.extend([
            "  config.tilts.push_back({",
            f"      .id = {cpp_string(item['name'])},",
            f"      .target_rotor_id = {cpp_string(settings['target'])},",
            f"      .visual_link = {cpp_string(item['child-link'])},",
            "      .parameters = {",
            f"          .angle_min_rad = {number(settings['angle-min'])},",
            f"          .angle_max_rad = {number(settings['angle-max'])},",
            f"          .smoothing_time_constant_s = {number(settings['smoothing-tc'])},",
            f"          .axis = {cpp_vector(vector(settings['axis']))},",
            "      },",
            "  });",
        ])
    for link in lift_links:
        inertial = link["inertial"]
        origin = inertial.get("origin", {})
        data = inertial["aerodynamics"]["lift-drag"]
        control = control_by_parent.get(link["name"])
        if control is None:
            raise ValueError(f"lifting surface {link['name']!r} has no control actuator")
        control_settings = control["lift-drag-control-surface-settings"]
        lines.extend([
            "  config.lifting_surfaces.push_back({",
            f"      .link_id = {cpp_string(link['name'])},",
            f"      .control_actuator_id = {cpp_string(control['name'])},",
            "      .control_parameters = {",
            f"          .rotation_rate_rad_per_unit = {number(control_settings['rotation-rate'])},",
            f"          .smoothing_time_constant_s = {number(control_settings['smoothing-tc'])},",
            "      },",
            "      .surface = {",
            f"          .origin_body_m = {cpp_vector(vector(origin.get('xyz')))},",
            f"          .orientation_surface_to_body = {cpp_quaternion(quaternion_from_rpy_deg(origin.get('rpy-deg')))},",
            f"          .parameters = {lift_parameters(data)},",
            "      },",
            "  });",
        ])
    for actuator_id in actuator_order:
        lines.append(f"  config.actuator_order.push_back({cpp_string(actuator_id)});")
    for item in sensors:
        sensor_type = item["type"]
        common = [
            f"      .id = {cpp_string(item['id'])},",
            f"      .enabled = {'true' if item.get('enabled', True) else 'false'},",
            f"      .sample_interval = std::chrono::nanoseconds({int(item['sample-interval-ns'])}),",
            "      .mount = {",
            f"          .position_body_m = {cpp_vector(vector(item.get('origin', {}).get('xyz')))},",
            "          .orientation_sensor_to_body = "
            f"{cpp_quaternion(quaternion_from_rpy_deg(item.get('origin', {}).get('rpy-deg')))},",
            "      },",
        ]
        if sensor_type == "imu":
            lines.append("  config.sensors.imu.push_back({")
            lines.extend(common)
            lines.append("  });")
        elif sensor_type == "gps":
            lines.append("  config.sensors.gps.push_back({")
            lines.extend(common)
            lines.append("  });")
        elif sensor_type == "camera-state":
            intrinsics = item["intrinsics"]
            lines.append("  config.sensors.cameras.push_back({")
            lines.extend(common)
            lines.extend([
                f"      .width_px = {int(intrinsics['width'])},",
                f"      .height_px = {int(intrinsics['height'])},",
                f"      .horizontal_fov_deg = {number(intrinsics['horizontal-fov-deg'])},",
                "      .enabled_image_types = {" + ", ".join(
                    str(int(value)) for value in intrinsics["enabled-image-types"]
                ) + "},",
                "  });",
            ])
        else:
            raise ValueError(f"unsupported native sensor type: {sensor_type!r}")
    controller_parameters = ", ".join(
        "{" + cpp_string(key) + ", " + number(value) + "}"
        for key, value in sorted(controller.get("parameters", {}).items())
    )
    lines.append(
        "  config.simple_flight = "
        "simulation::control::simple_flight::LoadSimpleFlightParameters("
        "{" + controller_parameters + "}, "
        + ("true" if fixed_wing_capable else "false") + ");"
    )
    lines.extend([
        "  config.mixer.actuator_count = config.actuator_order.size();",
        "  config.mixer.rotor_count = config.rotors.size();",
        "  config.fast_physics.lifting_surfaces.reserve(config.lifting_surfaces.size());",
        "  for (const auto& named_surface : config.lifting_surfaces) {",
        "    config.fast_physics.lifting_surfaces.push_back(named_surface.surface);",
        "  }",
        "  return config;",
        "}",
        "}  // namespace aerodt::digital_twin::runtime",
        "",
    ])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL,
                        help="name of the generated load function (one per package)")
    arguments = parser.parse_args()
    compile_package(arguments.package.resolve(), arguments.output.resolve(), arguments.symbol)


if __name__ == "__main__":
    main()
