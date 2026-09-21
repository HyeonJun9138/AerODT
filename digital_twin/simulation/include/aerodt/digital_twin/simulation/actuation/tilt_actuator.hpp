#pragma once

#include <chrono>

#include "aerodt/foundation/math/quaternion.hpp"

namespace aerodt::digital_twin::simulation::actuation {

struct TiltParameters {
  double angle_min_rad{};
  double angle_max_rad{3.14159265358979323846};
  double smoothing_time_constant_s{};
  foundation::math::Vector3 axis{0.0, 1.0, 0.0};
};

struct TiltOutput {
  double mapped_control{};
  double filtered_control{};
  double angle_rad{};
  foundation::math::Quaternion rotation{};
};

class TiltActuator final {
 public:
  explicit TiltActuator(TiltParameters parameters);
  void Reset(double initial_control = 0.0);
  [[nodiscard]] TiltOutput Update(double mapped_control, std::chrono::nanoseconds step);

 private:
  TiltParameters parameters_;
  double filtered_control_{};
};

}  // namespace aerodt::digital_twin::simulation::actuation
