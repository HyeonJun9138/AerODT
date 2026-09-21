#pragma once

#include "aerodt/digital_twin/contracts/contact_observation.hpp"
#include "aerodt/digital_twin/contracts/vehicle_state.hpp"

namespace aerodt::digital_twin::simulation::environment {

struct FlatGroundParameters {
  // NED coordinate of the ground plane. Sea-level flat ground is zero.
  double ground_plane_down_m{};
  // Positive distance from the body origin toward NED down to its lowest point.
  double body_ground_clearance_m{};
};

// Minimal deterministic geometry provider for headless UAM validation. It is
// not used when Unreal supplies scene collision sweeps.
class FlatGroundContactModel final {
 public:
  explicit FlatGroundContactModel(FlatGroundParameters parameters);

  [[nodiscard]] contracts::ContactObservation Observe(
      const contracts::VehicleState& state) const;

 private:
  FlatGroundParameters parameters_;
};

}  // namespace aerodt::digital_twin::simulation::environment
