add_library(aerodt_simulation STATIC
  src/actuation/control_surface_actuator.cpp
  src/actuation/rotor_actuator.cpp
  src/actuation/tilt_actuator.cpp
  src/aerodynamics/aerodynamic_model.cpp
  src/contact/contact_response.cpp
  src/control/simple_flight/airframe.cpp
  src/control/simple_flight/flight_mode_transition.cpp
  src/control/simple_flight/ground_truth_state_estimator.cpp
  src/control/simple_flight/multirotor_cascade_controller.cpp
  src/control/simple_flight/multirotor_mixer.cpp
  src/control/simple_flight/pid_controller.cpp
  src/control/simple_flight/simple_flight_mixer.cpp
  src/control/simple_flight/simple_flight_parameters.cpp
  src/control/simple_flight/tiltrotor_cascade_controller.cpp
  src/control/simple_flight/tiltrotor_fixed_wing_controller.cpp
  src/control/simple_flight/tiltrotor_mixer.cpp
  src/environment/flat_ground_contact_model.cpp
  src/physics/fast_physics/fast_physics_engine.cpp
  src/sensors/native_sensor_suite.cpp
  src/trajectory/kinematic_trajectory.cpp
)
add_library(AeroDT::Simulation ALIAS aerodt_simulation)

target_include_directories(aerodt_simulation PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(aerodt_simulation PUBLIC AeroDT::DigitalTwinContracts)

if(AERODT_BUILD_TESTS)
  add_executable(aerodt_fast_physics_tests tests/fast_physics_engine_test.cpp)
  target_link_libraries(aerodt_fast_physics_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_fast_physics_tests COMMAND aerodt_fast_physics_tests)

  add_executable(aerodt_actuator_tests tests/actuator_test.cpp)
  target_link_libraries(aerodt_actuator_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_actuator_tests COMMAND aerodt_actuator_tests)

  add_executable(aerodt_aerodynamics_tests tests/aerodynamic_model_test.cpp)
  target_link_libraries(aerodt_aerodynamics_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_aerodynamics_tests COMMAND aerodt_aerodynamics_tests)

  add_executable(aerodt_contact_tests tests/contact_response_test.cpp)
  target_link_libraries(aerodt_contact_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_contact_tests COMMAND aerodt_contact_tests)

  add_executable(aerodt_flat_ground_contact_tests
    tests/flat_ground_contact_model_test.cpp
  )
  target_link_libraries(aerodt_flat_ground_contact_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_flat_ground_contact_tests COMMAND aerodt_flat_ground_contact_tests)

  add_executable(aerodt_simple_flight_tests tests/simple_flight_test.cpp)
  target_link_libraries(aerodt_simple_flight_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_simple_flight_tests COMMAND aerodt_simple_flight_tests)

  add_executable(aerodt_native_sensor_tests tests/native_sensor_suite_test.cpp)
  target_link_libraries(aerodt_native_sensor_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_native_sensor_tests COMMAND aerodt_native_sensor_tests)

  add_executable(aerodt_airframe_mixer_tests tests/airframe_mixer_test.cpp)
  target_link_libraries(aerodt_airframe_mixer_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_airframe_mixer_tests COMMAND aerodt_airframe_mixer_tests)

  add_executable(aerodt_kinematic_trajectory_tests tests/kinematic_trajectory_test.cpp)
  target_link_libraries(aerodt_kinematic_trajectory_tests PRIVATE AeroDT::Simulation)
  add_test(NAME aerodt_kinematic_trajectory_tests COMMAND aerodt_kinematic_trajectory_tests)
endif()
