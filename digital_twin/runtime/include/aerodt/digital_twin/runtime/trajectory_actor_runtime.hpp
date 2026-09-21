#pragma once

#include <string>

#include "aerodt/digital_twin/contracts/state_snapshot.hpp"
#include "aerodt/digital_twin/simulation/trajectory/kinematic_trajectory.hpp"

namespace aerodt::digital_twin::runtime {

// One entity whose state comes from a trajectory table instead of physics:
// a scheduled flight replayed, background traffic, anything scripted. It
// owns that entity's current state the way UamVehicleRuntime owns a
// vehicle's, and is never grounded by contact: the table says where it is.
class TrajectoryActorRuntime final {
 public:
  TrajectoryActorRuntime(std::string entity_id,
                         simulation::trajectory::KinematicTrajectory trajectory);

  void Reset();
  const contracts::StateSnapshot& Advance(foundation::time::SimulationTime now);

  [[nodiscard]] const std::string& EntityId() const noexcept;
  [[nodiscard]] const contracts::StateSnapshot& Snapshot() const noexcept;
  [[nodiscard]] const simulation::trajectory::KinematicTrajectory& Trajectory() const noexcept;
  [[nodiscard]] bool HasEnded(foundation::time::SimulationTime now) const noexcept;

 private:
  std::string entity_id_;
  simulation::trajectory::KinematicTrajectory trajectory_;
  contracts::StateSnapshot snapshot_;
};

}  // namespace aerodt::digital_twin::runtime
