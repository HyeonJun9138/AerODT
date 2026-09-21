#pragma once

#include <chrono>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/flight_mode_transition.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_cascade_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_goal.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_fixed_wing_controller.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

struct TiltrotorCascadeOutput {
  ControlAxes controls;
  MultirotorCascadeOutput multirotor;
  TiltrotorFixedWingOutput fixed_wing;
  FlightModeTransitionOutput transition;
};

// Runs both controller branches before updating the speed-gated transition,
// then linearly blends their four control axes. This preserves the ordering of
// ProjectAirSim VTRCascadeController while keeping the mode request external
// to the static vehicle model.
class TiltrotorCascadeController final {
 public:
  explicit TiltrotorCascadeController(SimpleFlightParameters parameters);

  // Reset/explicit runtime control-path changes revoke all controller intent,
  // including assist. Its slew applies within the velocity controller only;
  // a direct or position command retains authority to replace that path.
  void Reset();
  [[nodiscard]] TiltrotorCascadeOutput Update(
      const VelocityYawRateGoalNed& goal, bool fixed_wing_requested,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] TiltrotorCascadeOutput Update(
      const VelocityYawAngleGoalNed& goal, bool fixed_wing_requested,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] FlightModeTransitionOutput TransitionState() const noexcept;

 private:
  [[nodiscard]] TiltrotorCascadeOutput Blend(
      MultirotorCascadeOutput multirotor,
      TiltrotorFixedWingOutput fixed_wing,
      bool fixed_wing_requested,
      double assist_target_rad,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);

  std::chrono::nanoseconds startup_elapsed_{};
  double assist_command_rad_{};
  SimpleFlightParameters parameters_;
  MultirotorCascadeController multirotor_;
  TiltrotorFixedWingController fixed_wing_;
  FlightModeTransition transition_;
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
