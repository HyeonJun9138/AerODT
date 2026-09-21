add_library(aerodt_uam_mission STATIC src/uam_mission_sequencer.cpp src/route_pilot.cpp)
add_library(AeroDT::UamMission ALIAS aerodt_uam_mission)

target_include_directories(aerodt_uam_mission PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(aerodt_uam_mission PUBLIC AeroDT::Simulation)

if(AERODT_BUILD_TESTS)
  add_executable(aerodt_route_pilot_tests tests/route_pilot_test.cpp)
  target_link_libraries(aerodt_route_pilot_tests PRIVATE AeroDT::UamMission)
  add_test(NAME aerodt_route_pilot_tests COMMAND aerodt_route_pilot_tests)
  add_executable(aerodt_uam_mission_tests tests/uam_mission_sequencer_test.cpp)
  target_link_libraries(aerodt_uam_mission_tests PRIVATE AeroDT::UamMission)
  add_test(NAME aerodt_uam_mission_tests COMMAND aerodt_uam_mission_tests)
endif()
