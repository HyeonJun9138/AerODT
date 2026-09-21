add_executable(aerodt_uam_native_demo main.cpp)
target_link_libraries(aerodt_uam_native_demo PRIVATE
  AeroDT::Data
  AeroDT::Runtime
  AeroDT::UamMission
)

if(AERODT_BUILD_TESTS)
  add_test(
    NAME aerodt_uam_native_demo_test
    COMMAND aerodt_uam_native_demo
            --short
            --timeout-seconds 180
            --workspace ${CMAKE_CURRENT_BINARY_DIR}/test_workspace
  )
  set_tests_properties(aerodt_uam_native_demo_test PROPERTIES TIMEOUT 30)
endif()
