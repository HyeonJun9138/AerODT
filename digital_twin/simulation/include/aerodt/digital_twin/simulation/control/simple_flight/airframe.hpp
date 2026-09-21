#pragma once

#include <cstddef>
#include <optional>
#include <string_view>

namespace aerodt::digital_twin::simulation::control::simple_flight {

// The airframes SimpleFlight can allocate controls for. Each one is a fixed
// arrangement of rotors and, for the tiltrotor, tilts and control surfaces;
// the model package names one and the compiler checks the package's actuators
// against it. Mirrors ProjectAirSim's `airframe-setup` values that the native
// port carries (the tailsitter is not ported: it has no validated baseline).
enum class Airframe {
  vtol_quad_tiltrotor,
  quadrotor_x,
  hexarotor_x,
};

struct AirframeTopology {
  std::size_t rotor_count{};
  std::size_t tilt_count{};
  bool lifting_surfaces_allowed{};
  bool fixed_wing_capable{};
};

[[nodiscard]] AirframeTopology TopologyOf(Airframe airframe) noexcept;
[[nodiscard]] const char* ToString(Airframe airframe) noexcept;
// The package spelling (`vtol-quad-tiltrotor`, `quadrotor-x`, `hexarotor-x`).
[[nodiscard]] std::optional<Airframe> ParseAirframe(std::string_view name) noexcept;

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
