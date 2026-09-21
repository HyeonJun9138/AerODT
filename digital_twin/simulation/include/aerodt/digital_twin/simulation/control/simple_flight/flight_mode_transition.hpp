#pragma once

#include <chrono>
#include <cstddef>

namespace aerodt::digital_twin::simulation::control::simple_flight {

enum class FlightMode { multirotor, fixed_wing };

struct FlightModeTransitionParameters {
  double stall_speed_mps{7.5};
  double speed_transition_mps{2.5};
  std::size_t confirmation_count{10};
  std::chrono::nanoseconds transition_duration{std::chrono::seconds(5)};
};

struct FlightModeTransitionOutput {
  FlightMode mode{FlightMode::multirotor};
  double fixed_wing_blend{};
  std::size_t speed_confirmation_count{};
};

class FlightModeTransition final {
 public:
  explicit FlightModeTransition(FlightModeTransitionParameters parameters);

  void Reset() noexcept;
  [[nodiscard]] FlightModeTransitionOutput Update(
      double horizontal_speed_mps, bool fixed_wing_requested,
      std::chrono::nanoseconds step);
  [[nodiscard]] FlightModeTransitionOutput State() const noexcept;

 private:
  FlightModeTransitionParameters parameters_;
  FlightMode mode_{FlightMode::multirotor};
  double fixed_wing_blend_{};
  std::size_t speed_confirmation_count_{};
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
