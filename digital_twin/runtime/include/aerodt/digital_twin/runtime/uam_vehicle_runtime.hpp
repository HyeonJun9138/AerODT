#pragma once

#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

#include "aerodt/digital_twin/contracts/state_snapshot.hpp"
#include "aerodt/digital_twin/runtime/uam_runtime_config.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_cascade_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_mixer.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_cascade_controller.hpp"

namespace aerodt::digital_twin::runtime {

struct NamedRotorOutput {
  std::string id;
  simulation::actuation::RotorOutput value;
};

struct NamedTiltOutput {
  std::string id;
  simulation::actuation::TiltOutput value;
};

struct NamedControlSurfaceOutput {
  std::string id;
  simulation::actuation::ControlSurfaceOutput value;
};

struct UamTickResult {
  contracts::StateSnapshot state;
  contracts::SensorFrame sensors;
  simulation::control::simple_flight::ControlAxes controller_output;
  simulation::control::simple_flight::FlightModeTransitionOutput transition;
  std::vector<double> actuator_commands;
  std::vector<NamedRotorOutput> rotors;
  std::vector<NamedTiltOutput> tilts;
  std::vector<NamedControlSurfaceOutput> control_surfaces;
  contracts::Wrench next_step_wrench;
};

// Owns one native UAM state and preserves the ProjectAirSim discrete tick order:
// integrate the previous wrench first, then mix controls and update actuators for
// the next physics step.
class UamVehicleRuntime final {
 public:
  explicit UamVehicleRuntime(UamRuntimeConfig config);

  [[nodiscard]] UamTickResult AdvanceGroundAssist(double forward_mps, double right_mps,
      double yaw_rate_radps, double body_down_m, double collective = 0.0);
  void Reset();
  void Reset(const contracts::VehicleState& state);
  [[nodiscard]] UamTickResult Advance(
      const simulation::control::simple_flight::ControlAxes& controls,
      const contracts::ContactObservation& contact_observation = {});
  [[nodiscard]] UamTickResult AdvancePositionGoal(
      const simulation::control::simple_flight::PositionYawRateGoalNed& goal,
      const contracts::ContactObservation& contact_observation = {});
  [[nodiscard]] UamTickResult AdvanceVelocityGoal(
      const simulation::control::simple_flight::VelocityYawRateGoalNed& goal,
      bool fixed_wing_requested,
      const contracts::ContactObservation& contact_observation = {});
  [[nodiscard]] UamTickResult AdvanceVelocityGoal(
      const simulation::control::simple_flight::VelocityYawAngleGoalNed& goal,
      bool fixed_wing_requested,
      const contracts::ContactObservation& contact_observation = {});

  [[nodiscard]] const UamRuntimeConfig& Config() const noexcept;
  [[nodiscard]] const contracts::VehicleState& State() const noexcept;
  [[nodiscard]] const contracts::Wrench& PendingWrench() const noexcept;
  [[nodiscard]] bool IsGrounded() const noexcept;

 private:
  enum class ControllerPath { none, direct, position, velocity };

  [[nodiscard]] std::size_t CommandIndex(const std::string& actuator_id) const;
  [[nodiscard]] UamTickResult FinishTick(
      const simulation::control::simple_flight::ControlAxes& controls,
      const simulation::control::simple_flight::FlightModeTransitionOutput& transition,
      const contracts::VehicleState& state,
      contracts::SensorFrame sensors);
  [[nodiscard]] bool FixedWingAllowed(bool fixed_wing_requested) const noexcept;
  void PrepareControllerPath(ControllerPath path);
  void ValidateAndIndexTopology();

  UamRuntimeConfig config_;
  simulation::fast_physics::FastPhysicsEngine physics_;
  simulation::control::simple_flight::SimpleFlightMixer mixer_;
  simulation::control::simple_flight::MultirotorCascadeController
      multirotor_controller_;
  simulation::control::simple_flight::TiltrotorCascadeController
      tiltrotor_controller_;
  simulation::sensors::NativeSensorSuite sensors_;
  std::vector<simulation::actuation::RotorActuator> rotors_;
  std::vector<simulation::actuation::TiltActuator> tilts_;
  std::vector<simulation::actuation::ControlSurfaceActuator> control_surfaces_;
  std::unordered_map<std::string, std::size_t> command_index_by_id_;
  std::unordered_map<std::string, std::size_t> rotor_index_by_id_;
  contracts::Wrench pending_wrench_{};
  ControllerPath controller_path_{ControllerPath::none};
};

}  // namespace aerodt::digital_twin::runtime
