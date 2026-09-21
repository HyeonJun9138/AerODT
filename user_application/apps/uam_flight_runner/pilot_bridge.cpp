// Versioned C ABI for incremental, independent flight execution. Runtime owns
// physical state; RoutePilot owns intent. No Python or transport in either.
#include "surface_telemetry.hpp"
#include <algorithm>
#include <cmath>
#include <memory>
#include <numeric>
#include <string>
#include <type_traits>
#include "aerodt/user_application/uam_mission/route_pilot.hpp"
#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"
#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"

#ifdef _WIN32
#define API extern "C" __declspec(dllexport)
#else
#define API extern "C" __attribute__((visibility("default")))
#endif
namespace {
using namespace aerodt::user_application::uam_mission;
using namespace aerodt::digital_twin::runtime;
using namespace aerodt::digital_twin::simulation::control::simple_flight;
using aerodt::digital_twin::simulation::environment::FlatGroundContactModel;
using aerodt::foundation::math::Vector3;
constexpr double step = 0.004;
constexpr double pi = 3.14159265358979323846;
thread_local std::string error;

// The guidance numbers, as a flat array so the ABI can grow without a new
// signature every time one is added. Order is the contract: a caller that knows
// only the first six passes six, and the rest keep the values the pilot was
// written with. Anything non-finite is refused rather than flown.
[[nodiscard]] RoutePilotTuning ReadTuning(const double* values, int size) {
  RoutePilotTuning tuning{};
  if (!values || size <= 0) return tuning;
  if (size > 17) throw std::invalid_argument("tuning array longer than this ABI knows");
  double* const fields[] = {
      &tuning.approach_brake_mps2, &tuning.approach_gain, &tuning.reverse_speed_mps,
      &tuning.reverse_transition_s, &tuning.reverse_margin_m, nullptr,
      &tuning.climb_rate_mps, &tuning.descent_rate_mps, &tuning.landing_rate_mps,
      &tuning.hover_capture_m, &tuning.hover_settle_s, &tuning.descent_settle_s,
      &tuning.hold_speed_mps, &tuning.wing_stall_mps, &tuning.wing_recover_mps,
      &tuning.approach_horizontal_speed_mps, &tuning.wing_altitude_gain};
  for (int i = 0; i < size; ++i) {
    if (!std::isfinite(values[i])) throw std::invalid_argument("non-finite tuning value");
    if (i == 5) { tuning.reverse_brake_span = values[i] != 0.0; continue; }
    // A settle time is the one kind of field allowed to be nothing at all:
    // zero means "do not stop here", which is a real choice an operator makes.
    const bool settle = i == 10 || i == 11;
    if (values[i] < 0.0 || (!settle && values[i] <= 0.0))
      throw std::invalid_argument("tuning values must be positive");
    *fields[i] = values[i];
  }
  return tuning;
}

struct Flight {
  SurfaceTelemetry surfaces;
  std::unique_ptr<UamVehicleRuntime> runtime;
  std::unique_ptr<RoutePilot> pilot;
  Vector3 origin;
  Vector3 destination;
  std::size_t count{};
  double blend{}, tilt{}, maximum_tilt{}, rotor{}, remainder{};
  bool failed{};

  Flight(const double* points, int size, double yaw, double arrival_yaw,
         const double* tuning = nullptr, int tuning_size = 0) {
    if (!points || size < 1 || size > 4096 || !std::isfinite(yaw) || !std::isfinite(arrival_yaw))
      throw std::invalid_argument("invalid flight profile");
    auto config = LoadAeroDTAirTaxiRuntimeConfig();
    config.step = std::chrono::milliseconds(4);
    config.simple_flight.transition_duration = std::chrono::seconds(12);
    config.initial_position_ned_m.z = -config.body_ground_clearance_m;
    config.simple_flight.startup_initial_throttle = 0.08;
    config.simple_flight.startup_ramp = std::chrono::seconds(4);
    config.initial_orientation_body_to_ned = {.w=std::cos(yaw*pi/360), .x=0, .y=0, .z=std::sin(yaw*pi/360)};
    runtime = std::make_unique<UamVehicleRuntime>(std::move(config));
    origin = runtime->State().position_ned_m;
    std::vector<RouteWaypoint> waypoints;
    for (int i=0; i<size; ++i) {
      const auto* p = points + i*6;
      for (int j=0;j<6;++j) if (!std::isfinite(p[j])) throw std::invalid_argument("non-finite waypoint");
      if (p[3] <= 0 || p[3] > 60 || p[5] <= 0) throw std::invalid_argument("invalid waypoint speed/capture");
      waypoints.push_back({.position_ned_m=Vector3{p[0],p[1],p[2]}+origin,
                           .speed_mps=p[3], .fixed_wing=p[4]!=0, .capture_m=p[5]});
    }
    destination = waypoints.back().position_ned_m;
    count = waypoints.size();
    pilot = std::make_unique<RoutePilot>(RoutePilotProfile{.waypoints=std::move(waypoints),
      .origin_ned_m=origin, .step_seconds=step, .initial_yaw_deg=yaw, .smooth_flight=true,
      .landing_yaw_deg=arrival_yaw, .terminal_landing=true,
      .tuning=ReadTuning(tuning, tuning_size)});
  }

  void Advance(double seconds, const double* hold) {
    if (failed) throw std::runtime_error("flight previously failed; reset required");
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 2) throw std::invalid_argument("advance outside 0..2 seconds");
    pilot->SetHold(hold ? std::optional<Vector3>(Vector3{hold[0],hold[1],hold[2]}+origin) : std::nullopt);
    remainder += seconds;
    while (remainder + 1e-10 >= step && !pilot->IsComplete()) {
      const auto command = pilot->Update(runtime->State(), runtime->IsGrounded(), blend, maximum_tilt);
      if (std::holds_alternative<std::monostate>(command.goal)) continue;
      const auto& state = runtime->State();
      // Only a real departure/arrival column has contact. A raised destination
      // must never become an infinite horizontal obstacle under the cruise.
      const bool departure = pilot->WaypointIndex()==0;
      const bool arrival = pilot->WaypointIndex()+1==count &&
          std::hypot(state.position_ned_m.x-destination.x,state.position_ned_m.y-destination.y)<20;
      aerodt::digital_twin::contracts::ContactObservation contact{};
      if (departure || arrival) {
        FlatGroundContactModel ground({.ground_plane_down_m=arrival ? destination.z-origin.z : 0.0,
                                       .body_ground_clearance_m=runtime->Config().body_ground_clearance_m});
        contact=ground.Observe(state);
      }
      auto tick = std::visit([&](const auto& goal)->UamTickResult {
        using T=std::decay_t<decltype(goal)>;
        if constexpr(std::is_same_v<T,GroundThrottleGoal>) return runtime->Advance({.throttle=goal.throttle},contact);
        else if constexpr(std::is_same_v<T,PositionYawRateGoalNed>) return runtime->AdvancePositionGoal(goal,contact);
        else if constexpr(std::is_same_v<T,VelocityYawAngleGoalNed>) return runtime->AdvanceVelocityGoal(goal,command.fixed_wing_requested,contact);
        else throw std::logic_error("not a physics command");
      },command.goal);
      remainder -= step;
      const auto& v=tick.state.vehicle.linear_velocity_ned_mps;
      if (!tick.state.vehicle.position_ned_m.IsFinite() || !v.IsFinite() || std::hypot(v.x,v.y,v.z)>150) {
        failed=true;
        throw std::runtime_error("flight diverged beyond guidance envelope");
      }
      blend=tick.transition.fixed_wing_blend;
      surfaces.Capture(tick);
      tilt=0; maximum_tilt=0; rotor=0;
      for (const auto& x:tick.tilts) {
        tilt+=x.value.angle_rad;
        maximum_tilt=std::max(maximum_tilt, std::abs(x.value.angle_rad)*180/pi);
      }
      if (!tick.tilts.empty()) tilt=tilt/tick.tilts.size()*180/pi;
      for (const auto& x:tick.rotors) rotor+=x.value.rotating_speed_radps;
      if (!tick.rotors.empty()) rotor/=tick.rotors.size();
    }
  }

  void Snapshot(double* out) const {
    const auto& s=runtime->State();const auto p=s.position_ned_m-origin;
    const auto& v=s.linear_velocity_ned_mps;const auto& q=s.orientation_body_to_ned;
    const double values[]={std::chrono::duration<double>(s.time.elapsed).count(),p.x,p.y,p.z,v.x,v.y,v.z,
      std::atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))*180/pi,
      std::asin(std::clamp(2*(q.w*q.y-q.z*q.x),-1.0,1.0))*180/pi,
      std::atan2(2*(q.w*q.x+q.y*q.z),1-2*(q.x*q.x+q.y*q.y))*180/pi,
      tilt,blend,std::hypot(v.x,v.y,v.z),runtime->IsGrounded()?1.0:0.0,
      static_cast<double>(pilot->WaypointIndex()),rotor,pilot->IsComplete()?1.0:0.0};
    std::copy(std::begin(values),std::end(values),out);
  }
};
}
// 2 adds aerodt_pilot_create_tuned. A caller that only knows 1 still works:
// the untuned entry point flies the values the pilot was written with.
// 3 appends approach horizontal speed and wing altitude gain; shorter prefixes still work.
// 5 adds intent-only landing yaw updates and read-only guidance diagnostics.
// The original 17-double state output and all prior functions are unchanged.
API int aerodt_pilot_abi() { return 7; }
API int aerodt_pilot_control_surfaces(void*h,double*out,int count){if(!h||!out||count<4)return 0;const auto&s=static_cast<Flight*>(h)->surfaces;if(!s.valid)return 0;std::copy(s.degrees.begin(),s.degrees.end(),out);return 1;}
API int aerodt_pilot_replace_arrival(void* handle, int expected_index, int first,
                                    const double* points, int size, double yaw) {
  try {
    if (!handle || !points || expected_index < 0 || first < 1 || size < 2 || size > 4096)
      throw std::invalid_argument("invalid arrival update");
    auto& flight = *static_cast<Flight*>(handle);
    if (flight.failed) return 0;
    std::vector<RouteWaypoint> suffix;
    for (int i=0; i<size; ++i) {
      const auto* p = points+i*6;
      for (int j=0; j<6; ++j) if (!std::isfinite(p[j])) throw std::invalid_argument("non-finite waypoint");
      suffix.push_back({.position_ned_m=Vector3{p[0],p[1],p[2]}+flight.origin,
                       .speed_mps=p[3],.fixed_wing=p[4]!=0,.capture_m=p[5]});
    }
    const auto destination = suffix.back().position_ned_m;
    if (!flight.pilot->ReplaceArrival(expected_index,first,std::move(suffix),yaw)) return 0;
    flight.destination = destination;
    flight.count = static_cast<std::size_t>(first+size);
    return 1;
  } catch (const std::exception& e) { error=e.what(); return -1; }
  catch (...) { error="unknown native error"; return -1; }
}
API int aerodt_pilot_set_landing_yaw(void* handle, double degrees) {
  try {
    if (!handle) throw std::invalid_argument("null flight");
    return static_cast<Flight*>(handle)->pilot->SetLandingYaw(degrees) ? 1 : 0;
  } catch (const std::exception& e) { error=e.what(); return -1; }
  catch (...) { error="unknown native error"; return -1; }
}
API const char* aerodt_pilot_guidance_status(void* handle, int* waypoint, int* mutable_yaw) {
  if (!handle || !waypoint || !mutable_yaw) { error="null guidance output"; return nullptr; }
  const auto& pilot=*static_cast<Flight*>(handle)->pilot;
  *waypoint=static_cast<int>(pilot.WaypointIndex());
  *mutable_yaw=pilot.LandingYawMutable() ? 1 : 0;
  return pilot.GuidanceReason();
}
API int aerodt_pilot_traffic(void* handle, double right_m, double speed_factor) {
  try {
    if (!handle || !std::isfinite(right_m) || !std::isfinite(speed_factor) ||
        right_m < 0 || right_m > 80 || speed_factor < .75 || speed_factor > 1)
      throw std::invalid_argument("invalid traffic intent");
    static_cast<Flight*>(handle)->pilot->SetTraffic(right_m, speed_factor);
    return 0;
  } catch (const std::exception& e) {error=e.what();return -1;}
  catch (...) {error="unknown native error";return -1;}
}
API const char* aerodt_pilot_error() { return error.c_str(); }
API void* aerodt_pilot_create(const double* points,int count,double yaw,double arrival_yaw) {
  try { error.clear();return new Flight(points,count,yaw,arrival_yaw); }
  catch(const std::exception& e) {error=e.what();return nullptr;}
  catch(...) {error="unknown native error";return nullptr;}
}
API void* aerodt_pilot_create_tuned(const double* points,int count,double yaw,double arrival_yaw,
                                    const double* tuning,int tuning_count) {
  try { error.clear();return new Flight(points,count,yaw,arrival_yaw,tuning,tuning_count); }
  catch(const std::exception& e) {error=e.what();return nullptr;}
  catch(...) {error="unknown native error";return nullptr;}
}
API int aerodt_pilot_step(void* handle,double seconds,const double* hold,double* out) {
  try {
    if(!handle || !out) throw std::invalid_argument("null flight or output");
    auto& flight=*static_cast<Flight*>(handle);flight.Advance(seconds,hold);flight.Snapshot(out);return 0;
  } catch(const std::exception& e) {error=e.what();return -1;}
  catch(...) {error="unknown native error";return -1;}
}
API void aerodt_pilot_destroy(void* handle) { delete static_cast<Flight*>(handle); }
