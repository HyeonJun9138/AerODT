#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_mixer.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {
namespace {

std::variant<TiltrotorMixer, MultirotorMixer> MakeMixer(Airframe airframe,
                                                         const MixerParameters& parameters) {
  if (airframe == Airframe::vtol_quad_tiltrotor) return TiltrotorMixer(parameters);
  return MultirotorMixer(airframe, parameters);
}

}  // namespace

SimpleFlightMixer::SimpleFlightMixer(Airframe airframe, MixerParameters parameters)
    : airframe_(airframe), mixer_(MakeMixer(airframe, parameters)) {}

std::vector<double> SimpleFlightMixer::Mix(const ControlAxes& controls) const {
  return std::visit([&controls](const auto& mixer) { return mixer.Mix(controls); }, mixer_);
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
