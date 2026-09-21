#include "surface_telemetry.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/manual_vertical_controller.hpp"
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>
#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"
#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"
#ifdef _WIN32
#define API extern "C" __declspec(dllexport)
#else
#define API extern "C" __attribute__((visibility("default")))
#endif
using namespace aerodt::digital_twin;
namespace {
constexpr double pi=3.141592653589793,dt=.004;
thread_local std::string failure;
struct Manual {
 struct Deck { double down; std::vector<std::pair<double,double>> points;
  bool contains(double n,double e) const {bool inside=false;for(size_t i=0,j=points.size()-1;i<points.size();j=i++){
   const auto [x,y]=points[i];const auto [a,b]=points[j];
   if((y>e)!=(b>e)&&n<(a-x)*(e-y)/(b-y)+x)inside=!inside;}return inside;}
 };
 std::vector<Deck> decks;double terrain_down{};
 std::unique_ptr<runtime::UamVehicleRuntime> vehicle;
 SurfaceTelemetry surfaces;
 simulation::control::simple_flight::ManualVerticalController vertical_controller;
 // Manual cruise convenience: capture altitude only with a centred pitch
 // stick. The controller commands elevator/attitude, never edits motion.
 double hold_down{}, cruise_trim{};bool altitude_hold{};
 bool guided{};double guidance_heading{},guidance_down{},guidance_speed{},speed_integral{};
 double cruise_pitch(double raw_pitch,double down,double down_speed,double speed,bool wing){
  const bool eligible=wing&&actual_tilt>85&&speed>25;
  // Cubic outer-stick authority: retain centre sensitivity, reach 20 degrees
  // in multirotor flight, and fade the addition with actual rotor tilt.
  if(!eligible){altitude_hold=false;cruise_trim*=std::exp(-dt);return stick_pitch*.10+(!wing ? .25*std::pow(stick_pitch,3)*(1-actual_tilt/90.) : 0.)+cruise_trim;}
  const bool neutral=guided||(std::abs(raw_pitch)<.025&&std::abs(stick_pitch)<.035);
  if(!neutral){altitude_hold=false;return std::clamp(cruise_trim+stick_pitch*.10,-.14,.14);}
  if(!altitude_hold){hold_down=down;altitude_hold=true;}
  if(guided)hold_down=guidance_down;
  const double desired_down_speed=std::clamp((hold_down-down)*.35,-2.,2.);
  const double error=down_speed-desired_down_speed;
  const double candidate=cruise_trim+error*.004*dt;
  const double pitch_goal=candidate+error*.018;
  // Conditional integration avoids accumulating trim beyond pitch authority.
  if((pitch_goal<.12||error<0)&&(pitch_goal>-.12||error>0))
   cruise_trim=std::clamp(candidate,-.09,.09);
  return std::clamp(cruise_trim+error*.018,-.12,.12);
 }
 double origin{},tilt{},actual_tilt{},rotor{},collective{},stick_roll{},stick_pitch{},stick_yaw{},hover_collective{};bool failed{};
 Manual(double yaw){auto c=runtime::LoadAeroDTAirTaxiRuntimeConfig();c.step=std::chrono::milliseconds(4);c.initial_position_ned_m.z=-c.body_ground_clearance_m;c.initial_orientation_body_to_ned={.w=std::cos(yaw*pi/360),.x=0,.y=0,.z=std::sin(yaw*pi/360)};
  // Read the compiled model, not a second copy of aircraft thrust or mass.
  double vertical_thrust=0;
  for(const auto&r:c.rotors)vertical_thrust+=simulation::actuation::RotorActuator(r.parameters).MaxThrustN()*std::max(0.,-r.parameters.normal_rotor.z);
  if(vertical_thrust>0)hover_collective=c.fast_physics.mass_kg*c.fast_physics.gravity_ned_mps2.Norm()/vertical_thrust;
  vehicle=std::make_unique<runtime::UamVehicleRuntime>(std::move(c));origin=vehicle->State().position_ned_m.z;}
 void advance(const double* input,int steps){
  if(failed)throw std::runtime_error("reset required");
  for(int n=0;n<steps;n++){
   const auto&s=vehicle->State();const auto&q=s.orientation_body_to_ned;
   const double roll=std::atan2(2*(q.w*q.x+q.y*q.z),1-2*(q.x*q.x+q.y*q.y));
   const double pitch=std::asin(std::clamp(2*(q.w*q.y-q.z*q.x),-1.,1.));
   const auto&v=s.linear_velocity_ned_mps;const auto&w=s.angular_velocity_body_radps;
   // Attitude-assisted manual input, not a second physics model.
   const bool requested=input[3]>0.5&&!vehicle->IsGrounded()&&origin-s.position_ned_m.z>15;
   const double target=requested?(std::hypot(v.x,v.y)>15?1.:.6):0.;
   tilt+=std::clamp(target-tilt,-dt/5,dt/12);
   simulation::control::simple_flight::ControlAxes controls;
   // Input shaping is controller state, not duplicated vehicle state.
   double thrust=input[0];
   if(guided){
    const double error=guidance_speed-std::hypot(v.x,v.y);
    const double candidate=speed_integral+error*.004*dt;
    const double unconstrained=std::pow(guidance_speed/80.,2)+error*.018+candidate;
    if((unconstrained<1||error<0)&&(unconstrained>0||error>0))speed_integral=std::clamp(candidate,-.5,.5);
    thrust=std::clamp(std::pow(guidance_speed/80.,2)+error*.018+speed_integral,0.,1.);
   }
   const auto& cfg=vehicle->Config();
   const auto& vertical=cfg.simple_flight.manual_vertical;
   auto smooth=[](double t){t=std::clamp(t,0.,1.);return t*t*(3-2*t);};
   // Lever policy: 10% neutral (+/-0.2% noise band); 7..13% fine speed.
   // Outside that band fade back to direct collective, preserving cutoff and
   // high power. On the ground neutral/below stays idle, never auto-launches.
   const double authority=guided||vertical.velocity_p<=0||
       ((vehicle->IsGrounded()||s.time.elapsed.count()==0)&&input[0]<=.102) ? 0. :
       smooth((input[0]-.04)/.03)*(1-smooth((input[0]-.13)/.07))*
       (1-smooth(actual_tilt/30.));
   if(authority>0){
    const double offset=input[0]-.10;
    const bool neutral=std::abs(offset)<=.002+1e-12;
    const double demand=std::clamp((std::abs(offset)-.002)/.028,0.,1.);
    const double desired_down=neutral?0.:(offset>0?-vertical.climb_speed:vertical.descent_speed)*demand;
    const double assisted=vertical_controller.Update(desired_down,neutral,
        s.position_ned_m.z,v.z,std::cos(roll)*std::cos(pitch)*std::cos(actual_tilt*pi/180),
        hover_collective,cfg.fast_physics.gravity_ned_mps2.Norm(),dt,vertical);
    thrust=thrust*(1-authority)+assisted*authority;
   }else vertical_controller.Reset();
   collective+=std::clamp(thrust-collective,-dt*.15,dt*.15);
   const double alpha=1-std::exp(-dt/.45);
   stick_roll+=(input[1]-stick_roll)*alpha;stick_pitch+=(input[2]-stick_pitch)*alpha;stick_yaw+=(input[4]-stick_yaw)*alpha;
   controls.throttle=collective;controls.roll=std::clamp((stick_roll*.12-roll)*.7-w.x*.2,-.25,.25);
   const double pitch_goal=cruise_pitch(input[2],s.position_ned_m.z,v.z,std::hypot(v.x,v.y),requested);
   controls.pitch=std::clamp((pitch_goal-pitch)*.7-w.y*.2,-.35,.35);
   controls.yaw=std::clamp((stick_yaw*.21-w.z)*.2,-.12,.12);controls.tilt=tilt;controls.allocation_blend=std::max(0.,(tilt-.6)/.4);
   if(guided){
    const double yaw=std::atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z));
    const double desired_rate=std::clamp(std::remainder(guidance_heading-yaw,2*pi)*.7,-.21,.21);
    controls.yaw=std::clamp((desired_rate-w.z)*.2,-.12,.12);
   }
   double plane=terrain_down;
   const double feet=s.position_ned_m.z-origin;
   for(const auto& deck:decks){
    // Top-surface contact only: do not teleport an aircraft flying underneath.
    if(deck.contains(s.position_ned_m.x,s.position_ned_m.y)&&
       feet<=deck.down+std::max(.2,std::max(0.,v.z)*dt+.02))plane=std::min(plane,deck.down);
   }
   simulation::environment::FlatGroundContactModel ground({.ground_plane_down_m=plane,.body_ground_clearance_m=vehicle->Config().body_ground_clearance_m});
   const bool taxi=authority==0&&std::abs(feet-plane)<.15&&v.z>=-.2&&collective<=.10;
   if(taxi){tilt=0;stick_roll=0;stick_pitch=0;}
   // Ground movement is an explicit slow training assist, never a free-flight teleport.
   auto tick=taxi?vehicle->AdvanceGroundAssist(-input[2]*3.0,input[1]*3.0,input[4]*.21,origin+plane,collective):vehicle->Advance(controls,ground.Observe(s));rotor=0;
   surfaces.Capture(tick);
   for(const auto&r:tick.rotors)rotor+=r.value.rotating_speed_radps;
   if(!tick.rotors.empty())rotor/=tick.rotors.size(); actual_tilt=0;for(const auto&t:tick.tilts)actual_tilt+=t.value.angle_rad*180/pi;if(!tick.tilts.empty())actual_tilt/=tick.tilts.size();
   const auto&next=vehicle->State();if(!next.position_ned_m.IsFinite()||!next.linear_velocity_ned_mps.IsFinite()||next.linear_velocity_ned_mps.Norm()>150){failed=true;throw std::runtime_error("manual flight outside simulation envelope");}
  }
 }
 void snapshot(double*out){const auto&s=vehicle->State();const auto&p=s.position_ned_m;const auto&v=s.linear_velocity_ned_mps;const auto&q=s.orientation_body_to_ned;
 const double values[]={std::chrono::duration<double>(s.time.elapsed).count(),p.x,p.y,p.z-origin,v.x,v.y,v.z,std::atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))*180/pi,std::asin(std::clamp(2*(q.w*q.y-q.z*q.x),-1.,1.))*180/pi,std::atan2(2*(q.w*q.x+q.y*q.z),1-2*(q.x*q.x+q.y*q.y))*180/pi,actual_tilt,rotor,vehicle->IsGrounded()?1.:0.};std::copy(std::begin(values),std::end(values),out);}
};
}
API const char* aerodt_manual_error(){return failure.c_str();}
API void* aerodt_manual_create(double yaw){try{if(!std::isfinite(yaw))throw std::invalid_argument("yaw");return new Manual(yaw);}catch(const std::exception&e){failure=e.what();return nullptr;}}
API int aerodt_manual_step_v2(void*h,const double*in,int steps,double*out){try{if(!h||!in||!out||steps<0||steps>25)throw std::invalid_argument("invalid step");for(int i=0;i<5;i++)if(!std::isfinite(in[i]))throw std::invalid_argument("nonfinite input");if(in[0]<0||in[0]>1||std::abs(in[1])>1||std::abs(in[2])>1||(in[3]!=0&&in[3]!=1)||std::abs(in[4])>1)throw std::invalid_argument("input range");auto&m=*static_cast<Manual*>(h);m.advance(in,steps);m.snapshot(out);return 1;}catch(const std::exception&e){failure=e.what();return 0;}}
API int aerodt_manual_surface(void*h,double down){try{
 if(!h||!std::isfinite(down)||std::abs(down)>20000)throw std::invalid_argument("surface");
 static_cast<Manual*>(h)->terrain_down=down;return 1;
 }catch(const std::exception&e){failure=e.what();return 0;}}
API int aerodt_manual_deck(void*h,const double*xy,int count,double down){try{
 if(!h||!xy||count<3||count>256||!std::isfinite(down)||std::abs(down)>20000)throw std::invalid_argument("deck");
 auto&m=*static_cast<Manual*>(h);if(m.decks.size()>=128)throw std::invalid_argument("deck limit");
 Manual::Deck d{down,{}};for(int i=0;i<count;i++){
  if(!std::isfinite(xy[2*i])||!std::isfinite(xy[2*i+1])||std::abs(xy[2*i])>1e6||std::abs(xy[2*i+1])>1e6)throw std::invalid_argument("deck position");
  d.points.emplace_back(xy[2*i],xy[2*i+1]);}m.decks.push_back(std::move(d));return 1;
 }catch(const std::exception&e){failure=e.what();return 0;}}
API int aerodt_manual_control_surfaces(void*h,double*out,int count){if(!h||!out||count<4)return 0;const auto&s=static_cast<Manual*>(h)->surfaces;if(!s.valid)return 0;std::copy(s.degrees.begin(),s.degrees.end(),out);return 1;}
API void aerodt_manual_destroy(void*h){delete static_cast<Manual*>(h);}

// Additive intent API: retain the same runtime and physical state on AP changes.
API int aerodt_manual_guidance(void*h,int enabled,double heading_deg,double down,double speed){try{
 if(!h||(enabled!=0&&enabled!=1)||!std::isfinite(heading_deg)||!std::isfinite(down)||std::abs(down)>20000||!std::isfinite(speed)||(enabled&&(speed<25||speed>80)))
  throw std::invalid_argument("invalid manual guidance");
 auto&m=*static_cast<Manual*>(h);if(m.guided!=(enabled!=0)){m.altitude_hold=false;m.speed_integral=0;}
 m.guided=enabled!=0;m.guidance_heading=heading_deg*pi/180;m.guidance_down=m.origin+down;m.guidance_speed=speed;return 1;
 }catch(const std::exception&e){failure=e.what();return 0;}}

API double aerodt_manual_collective(void*h){return h?static_cast<Manual*>(h)->collective:0;}
