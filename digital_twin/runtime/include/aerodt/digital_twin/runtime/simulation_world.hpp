#pragma once

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "aerodt/digital_twin/contracts/state_snapshot.hpp"
#include "aerodt/digital_twin/runtime/simulation_clock.hpp"
#include "aerodt/digital_twin/runtime/trajectory_actor_runtime.hpp"
#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"

namespace aerodt::digital_twin::runtime {

// Every entity of one simulation on one clock: physics vehicles and
// trajectory actors advance together, one step per call, and the world holds
// the current snapshot of each. This is the seat of the Simulation Engine's
// temporal state: what is true now, for every entity, at the same instant.
//
// The world decides nothing about how a vehicle is flown. Each vehicle is
// added with the step the application performs on it (mission goal, contact
// observation); the mission logic stays in user_application and the world
// only calls it in clock order. Trajectory actors need no such step.
class SimulationWorld final {
 public:
  using VehicleStep = std::function<UamTickResult(UamVehicleRuntime&)>;

  explicit SimulationWorld(std::chrono::nanoseconds step);

  // The vehicle's own step must equal the world step: one tick each, in lockstep.
  std::size_t AddVehicle(std::unique_ptr<UamVehicleRuntime> vehicle, VehicleStep step);
  std::size_t AddTrajectoryActor(TrajectoryActorRuntime actor);

  void Reset();
  // One step for the clock and for every entity; the snapshots of that step.
  const std::vector<contracts::StateSnapshot>& Advance();

  [[nodiscard]] const SimulationClock& Clock() const noexcept;
  [[nodiscard]] std::size_t EntityCount() const noexcept;
  // Snapshots in entity order: vehicles first, then trajectory actors, each in
  // the order they were added. Before the first step they are the reset states.
  [[nodiscard]] const std::vector<contracts::StateSnapshot>& Snapshots() const noexcept;
  [[nodiscard]] UamVehicleRuntime& Vehicle(std::size_t index);
  [[nodiscard]] const UamTickResult& LastVehicleTick(std::size_t index) const;
  [[nodiscard]] const TrajectoryActorRuntime& TrajectoryActor(std::size_t index) const;
  [[nodiscard]] std::size_t VehicleCount() const noexcept;
  [[nodiscard]] std::size_t TrajectoryActorCount() const noexcept;

 private:
  struct VehicleEntry {
    std::unique_ptr<UamVehicleRuntime> runtime;
    VehicleStep step;
    UamTickResult last_tick;
  };

  void RequireUniqueEntityId(const std::string& entity_id) const;
  void CollectSnapshots();

  SimulationClock clock_;
  std::vector<VehicleEntry> vehicles_;
  std::vector<TrajectoryActorRuntime> actors_;
  std::vector<contracts::StateSnapshot> snapshots_;
};

}  // namespace aerodt::digital_twin::runtime
