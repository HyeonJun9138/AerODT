#pragma once

#include <chrono>

namespace aerodt::digital_twin::simulation::actuation {

struct ControlSurfaceParameters {
  double rotation_rate_rad_per_unit{};
  double smoothing_time_constant_s{};
};

struct ControlSurfaceOutput {
  double filtered_control{};
  double angle_rad{};
};

class ControlSurfaceActuator final {
 public:
  explicit ControlSurfaceActuator(ControlSurfaceParameters parameters);

  void Reset(double initial_control = 0.0);
  [[nodiscard]] ControlSurfaceOutput Update(
      double control, std::chrono::nanoseconds step);

 private:
  ControlSurfaceParameters parameters_;
  double filtered_control_{};
};

}  // namespace aerodt::digital_twin::simulation::actuation
