#pragma once

#include <variant>
#include <vector>

#include "aerodt/digital_twin/simulation/control/simple_flight/airframe.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_mixer.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// The one SimpleFlight control allocation, chosen by airframe: the blended
// tiltrotor matrices for the VTOL quad tiltrotor, the fixed multirotor matrix
// for quadrotor-x and hexarotor-x. This is the legacy firmware's mixer switch;
// it holds no state beyond the matrix it was built with.
class SimpleFlightMixer {
 public:
  SimpleFlightMixer(Airframe airframe, MixerParameters parameters = {});

  [[nodiscard]] std::vector<double> Mix(const ControlAxes& controls) const;
  [[nodiscard]] Airframe AirframeKind() const noexcept { return airframe_; }

 private:
  Airframe airframe_;
  std::variant<TiltrotorMixer, MultirotorMixer> mixer_;
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
