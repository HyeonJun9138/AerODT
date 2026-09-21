#pragma once

#include <chrono>
#include <string>
#include <vector>

#include "aerodt/digital_twin/simulation/actuation/control_surface_actuator.hpp"
#include "aerodt/digital_twin/simulation/actuation/rotor_actuator.hpp"
#include "aerodt/digital_twin/simulation/actuation/tilt_actuator.hpp"
#include "aerodt/digital_twin/simulation/contact/contact_response.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/airframe.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"
#include "aerodt/digital_twin/simulation/fast_physics/fast_physics_engine.hpp"
#include "aerodt/digital_twin/simulation/sensors/native_sensor_suite.hpp"

namespace aerodt::digital_twin::runtime {

struct NamedRotor {
  std::string id;
  // Model package link this actuator drives, so the visual host can turn the
  // right propeller without inventing a naming convention.
  std::string visual_link;
  simulation::actuation::RotorParameters parameters;
};

struct NamedTilt {
  std::string id;
  std::string target_rotor_id;
  std::string visual_link;
  simulation::actuation::TiltParameters parameters;
};

struct NamedLiftingSurface {
  std::string link_id;
  std::string control_actuator_id;
  simulation::actuation::ControlSurfaceParameters control_parameters;
  simulation::aerodynamics::LiftingSurface surface;
};

struct UamRuntimeConfig {
  std::string package_id;
  std::string package_version;
  std::string entity_id;
  std::string physics_id;
  std::string controller_id;
  std::string airframe_id;
  // The same airframe as `airframe_id`, resolved at compile time so the
  // runtime picks its mixer and checks its topology without parsing a name.
  simulation::control::simple_flight::Airframe airframe{};
  std::chrono::nanoseconds step{};
  foundation::math::Vector3 initial_position_ned_m{};
  foundation::math::Quaternion initial_orientation_body_to_ned{};
  // Positive body-center distance to the lowest point of the V1 collision box.
  // Used only by headless flat-ground geometry; Unreal supplies actual hits.
  double body_ground_clearance_m{};
  simulation::fast_physics::FastPhysicsParameters fast_physics;
  simulation::contact::ContactParameters contact;
  simulation::control::simple_flight::SimpleFlightParameters simple_flight;
  simulation::control::simple_flight::MixerParameters mixer;
  simulation::sensors::NativeSensorSuiteParameters sensors;
  std::vector<NamedRotor> rotors;
  std::vector<NamedTilt> tilts;
  std::vector<NamedLiftingSurface> lifting_surfaces;
  std::vector<std::string> actuator_order;
};

// Generated from the model packages during the build, one loader per package.
[[nodiscard]] UamRuntimeConfig LoadAeroDTAirTaxiRuntimeConfig();
[[nodiscard]] UamRuntimeConfig LoadAeroDTQuadrotorRuntimeConfig();

}  // namespace aerodt::digital_twin::runtime
