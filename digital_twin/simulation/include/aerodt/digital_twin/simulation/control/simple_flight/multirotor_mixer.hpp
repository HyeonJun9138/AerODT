#pragma once

#include <array>
#include <cstddef>
#include <vector>

#include "aerodt/digital_twin/simulation/control/simple_flight/airframe.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// Control allocation for the plain multirotor airframes: the ProjectAirSim
// SimpleFlight QuadX and HexX matrices, ported verbatim. Roll, pitch, yaw and
// throttle map onto the rotors in the package's actuator order; the tilt axis
// is ignored because these airframes have nothing to tilt. Rotor outputs are
// kept inside the same bounds the tiltrotor mixer keeps: lifted together when
// one undershoots the minimum, scaled together when one exceeds the maximum,
// so the commanded ratios survive saturation.
class MultirotorMixer {
 public:
  // `airframe` must be quadrotor_x or hexarotor_x; `parameters.rotor_count`
  // must match the airframe.
  MultirotorMixer(Airframe airframe, MixerParameters parameters = {});

  [[nodiscard]] std::vector<double> Mix(const ControlAxes& controls) const;
  [[nodiscard]] Airframe AirframeKind() const noexcept { return airframe_; }

 private:
  // Roll, pitch, yaw, throttle.
  using MixerRow = std::array<double, 4>;

  Airframe airframe_;
  MixerParameters parameters_;
  std::vector<MixerRow> matrix_;

  static const std::array<MixerRow, 4> kQuadXMatrix;
  static const std::array<MixerRow, 6> kHexXMatrix;
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
