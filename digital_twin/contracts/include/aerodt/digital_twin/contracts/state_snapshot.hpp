#pragma once

#include <string>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"

namespace aerodt::digital_twin::contracts {

struct StateSnapshot {
  std::string entity_id;
  VehicleState vehicle;
  bool is_grounded{};
};

}  // namespace aerodt::digital_twin::contracts
