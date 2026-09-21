#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <vector>

namespace aerodt::digital_twin::simulation::control::simple_flight {

struct ControlAxes {
  double roll{};
  double pitch{};
  double yaw{};
  double throttle{};
  double tilt{};
  // Empty preserves the legacy allocation blend == nacelle command. A
  // rotor-assist command may tilt nacelles without selecting wing allocation.
  std::optional<double> allocation_blend;
  // Synchronous nacelles during assisted approach; yaw still uses the rotor
  // torque pairs in the multirotor matrix, not extra differential nacelle tilt.
  bool collective_tilt_only{false};
};

struct MixerParameters {
  std::size_t actuator_count{11};
  std::size_t rotor_count{4};
  double minimum_rotor_output{};
  double maximum_rotor_output{1.0};
  double minimum_control_output{-1.0};
  double maximum_control_output{1.0};
};

class TiltrotorMixer {
 public:
  explicit TiltrotorMixer(MixerParameters parameters = {});

  // Output order follows the AirTaxi package: four rotors, four tilts,
  // left/right ailerons, elevator, and optionally rudder.
  [[nodiscard]] std::vector<double> Mix(const ControlAxes& controls) const;

 private:
  using MixerRow = std::array<double, 5>;
  using MixerMatrix = std::array<MixerRow, 12>;

  MixerParameters parameters_;
  static const MixerMatrix kMultirotorMatrix;
  static const MixerMatrix kFixedWingMatrix;
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
