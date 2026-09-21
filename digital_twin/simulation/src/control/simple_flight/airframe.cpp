#include "aerodt/digital_twin/simulation/control/simple_flight/airframe.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

AirframeTopology TopologyOf(Airframe airframe) noexcept {
  switch (airframe) {
    case Airframe::vtol_quad_tiltrotor:
      return {.rotor_count = 4, .tilt_count = 4, .lifting_surfaces_allowed = true,
              .fixed_wing_capable = true};
    case Airframe::quadrotor_x:
      return {.rotor_count = 4, .tilt_count = 0, .lifting_surfaces_allowed = false,
              .fixed_wing_capable = false};
    case Airframe::hexarotor_x:
      return {.rotor_count = 6, .tilt_count = 0, .lifting_surfaces_allowed = false,
              .fixed_wing_capable = false};
  }
  return {};
}

const char* ToString(Airframe airframe) noexcept {
  switch (airframe) {
    case Airframe::vtol_quad_tiltrotor:
      return "vtol-quad-tiltrotor";
    case Airframe::quadrotor_x:
      return "quadrotor-x";
    case Airframe::hexarotor_x:
      return "hexarotor-x";
  }
  return "unknown";
}

std::optional<Airframe> ParseAirframe(std::string_view name) noexcept {
  if (name == "vtol-quad-tiltrotor") return Airframe::vtol_quad_tiltrotor;
  if (name == "quadrotor-x") return Airframe::quadrotor_x;
  if (name == "hexarotor-x") return Airframe::hexarotor_x;
  return std::nullopt;
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
