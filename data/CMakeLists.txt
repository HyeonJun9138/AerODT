add_library(aerodt_data STATIC
  src/jsonl_run_logger.cpp
  src/run_recorder.cpp
  src/sensor_telemetry_writer.cpp
)
add_library(AeroDT::Data ALIAS aerodt_data)

target_include_directories(aerodt_data PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(aerodt_data PUBLIC
  AeroDT::Foundation
  AeroDT::DigitalTwinContracts
)

if(AERODT_BUILD_TESTS)
  add_executable(aerodt_data_tests
    tests/jsonl_run_logger_test.cpp
    tests/run_recorder_test.cpp
    tests/sensor_telemetry_writer_test.cpp
  )
  target_link_libraries(aerodt_data_tests PRIVATE AeroDT::Data)
  add_test(NAME aerodt_data_tests COMMAND aerodt_data_tests)
endif()
