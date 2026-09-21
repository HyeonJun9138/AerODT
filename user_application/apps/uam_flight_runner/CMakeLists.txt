add_executable(aerodt_uam_flight_runner main.cpp)
target_link_libraries(aerodt_uam_flight_runner PRIVATE
  AeroDT::Runtime
  AeroDT::UamMission
)
# The simulation engine in digital_twin starts this process, so it has to be
# able to find it without knowing which layer's source tree it was built from.
# A build puts it in one place, named after what it is.
set_target_properties(aerodt_uam_flight_runner PROPERTIES
  OUTPUT_NAME "aerodt_uam_flight_runner_v2"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

add_library(aerodt_uam_pilot SHARED pilot_bridge.cpp)
target_link_libraries(aerodt_uam_pilot PRIVATE AeroDT::Runtime AeroDT::UamMission)
set_target_properties(aerodt_uam_pilot PROPERTIES
  OUTPUT_NAME "aerodt_uam_pilot_v9"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

if(AERODT_BUILD_TESTS)
  # A short square: lift off, fly a leg wing-borne, come back down. Enough to
  # prove the runner parses its input, flies waypoints and reports states.
  add_test(
    NAME aerodt_uam_flight_runner_test
    COMMAND ${CMAKE_COMMAND}
            -DRUNNER=$<TARGET_FILE:aerodt_uam_flight_runner>
            -P ${CMAKE_CURRENT_SOURCE_DIR}/run_test.cmake
  )
  set_tests_properties(aerodt_uam_flight_runner_test PROPERTIES TIMEOUT 120)
endif()

add_library(aerodt_uam_manual SHARED manual_bridge.cpp)
target_link_libraries(aerodt_uam_manual PRIVATE AeroDT::Runtime)
set_target_properties(aerodt_uam_manual PROPERTIES OUTPUT_NAME "aerodt_uam_manual_v12" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin" LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
