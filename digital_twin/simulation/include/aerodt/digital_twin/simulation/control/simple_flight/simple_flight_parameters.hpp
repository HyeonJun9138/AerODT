#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <string>
#include <unordered_map>

#include "aerodt/digital_twin/simulation/control/simple_flight/pid_controller.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// SimpleFlight uses four logical axes: roll/right, pitch/forward, yaw, and
// throttle/down. The XY swap is intentional and matches ProjectAirSim Axis4.
inline constexpr std::size_t kRollAxis = 0;
inline constexpr std::size_t kPitchAxis = 1;
inline constexpr std::size_t kYawAxis = 2;
inline constexpr std::size_t kThrottleAxis = 3;
inline constexpr std::size_t kControlAxisCount = 4;

struct AxisPidGroup {
  std::array<PidParameters, kControlAxisCount> pid{};
  std::array<double, kControlAxisCount> maximum{};
};

struct CascadeParameters {
  AxisPidGroup angle_rate;
  AxisPidGroup angle_level;
  AxisPidGroup position;
  AxisPidGroup velocity;
  double minimum_throttle{0.3};
};

struct ManualVerticalParameters {
  double velocity_p{};
  double velocity_i{};
  double position_p{};
  double acceleration_limit{};
  double command_acceleration{};
  double climb_speed{};
  double descent_speed{};
};

struct SimpleFlightParameters {
  ManualVerticalParameters manual_vertical;
  CascadeParameters multirotor;
  CascadeParameters fixed_wing;
  double fixed_wing_stall_speed_mps{7.5};
  double fixed_wing_forward_speed_mps{20.0};
  double fixed_wing_minimum_pitch_rad{};
  // Static airframe capability. A flight-mode request is supplied separately
  // on every controller update and must not be stored in the model package.
  bool fixed_wing_capable{};
  // Optional host startup envelope; zero preserves the legacy controller.
  double startup_initial_throttle{};
  std::chrono::nanoseconds startup_ramp{};
  std::chrono::nanoseconds transition_duration{std::chrono::seconds(5)};
  double rotor_assist_maximum_rad{};
  double rotor_assist_rate_radps{};
};

// Applies the legacy Params defaults first and then the JSONC parameter-map
// overrides. The returned value is the sole typed controller configuration
// stored by the native runtime.
[[nodiscard]] SimpleFlightParameters LoadSimpleFlightParameters(
    const std::unordered_map<std::string, double>& source_parameters,
    bool fixed_wing_capable);

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
