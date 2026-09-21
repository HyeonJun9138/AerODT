find_package(Python3 REQUIRED COMPONENTS Interpreter)

set(AERODT_UAM_PACKAGE
  ${PROJECT_SOURCE_DIR}/digital_twin/model_library/packages/vehicles/air/tiltrotor_uam/aerodt_airtaxi
)
set(AERODT_GENERATED_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
set(AERODT_GENERATED_UAM_CONFIG ${AERODT_GENERATED_DIR}/aerodt_airtaxi_runtime_config.cpp)

add_custom_command(
  OUTPUT ${AERODT_GENERATED_UAM_CONFIG}
  COMMAND ${Python3_EXECUTABLE}
          ${PROJECT_SOURCE_DIR}/digital_twin/model_library/compiler/compile_uam_package.py
          --package ${AERODT_UAM_PACKAGE}
          --output ${AERODT_GENERATED_UAM_CONFIG}
  DEPENDS
    ${PROJECT_SOURCE_DIR}/digital_twin/model_library/compiler/compile_uam_package.py
    ${AERODT_UAM_PACKAGE}/manifest.jsonc
    ${AERODT_UAM_PACKAGE}/model.jsonc
    ${AERODT_UAM_PACKAGE}/scene.jsonc
    ${AERODT_UAM_PACKAGE}/sensors.jsonc
  VERBATIM
)

# A second package, compiled the same way: the multirotor demonstration
# quadrotor. Every package gets its own loader symbol.
set(AERODT_QUADROTOR_PACKAGE
  ${PROJECT_SOURCE_DIR}/digital_twin/model_library/packages/vehicles/air/multirotor/aerodt_quadrotor
)
set(AERODT_GENERATED_QUADROTOR_CONFIG ${AERODT_GENERATED_DIR}/aerodt_quadrotor_runtime_config.cpp)
add_custom_command(
  OUTPUT ${AERODT_GENERATED_QUADROTOR_CONFIG}
  COMMAND ${Python3_EXECUTABLE}
          ${PROJECT_SOURCE_DIR}/digital_twin/model_library/compiler/compile_uam_package.py
          --package ${AERODT_QUADROTOR_PACKAGE}
          --output ${AERODT_GENERATED_QUADROTOR_CONFIG}
          --symbol LoadAeroDTQuadrotorRuntimeConfig
  DEPENDS
    ${PROJECT_SOURCE_DIR}/digital_twin/model_library/compiler/compile_uam_package.py
    ${AERODT_QUADROTOR_PACKAGE}/manifest.jsonc
    ${AERODT_QUADROTOR_PACKAGE}/model.jsonc
    ${AERODT_QUADROTOR_PACKAGE}/scene.jsonc
    ${AERODT_QUADROTOR_PACKAGE}/sensors.jsonc
  VERBATIM
)

add_library(aerodt_runtime STATIC
  ${AERODT_GENERATED_UAM_CONFIG}
  ${AERODT_GENERATED_QUADROTOR_CONFIG}
  src/simulation_clock.cpp
  src/simulation_world.cpp
  src/trajectory_actor_runtime.cpp
  src/uam_vehicle_runtime.cpp
)
add_library(AeroDT::Runtime ALIAS aerodt_runtime)
target_include_directories(aerodt_runtime PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(aerodt_runtime PUBLIC AeroDT::Simulation)

if(AERODT_BUILD_TESTS)
  add_executable(aerodt_uam_config_tests tests/uam_runtime_config_test.cpp)
  target_link_libraries(aerodt_uam_config_tests PRIVATE AeroDT::Runtime)
  add_test(NAME aerodt_uam_config_tests COMMAND aerodt_uam_config_tests)

  add_executable(aerodt_uam_runtime_tests tests/uam_vehicle_runtime_test.cpp)
  target_link_libraries(aerodt_uam_runtime_tests PRIVATE AeroDT::Runtime)
  add_test(NAME aerodt_uam_runtime_tests COMMAND aerodt_uam_runtime_tests)

  add_executable(aerodt_simulation_world_tests tests/simulation_world_test.cpp)
  target_link_libraries(aerodt_simulation_world_tests PRIVATE AeroDT::Runtime)
  add_test(NAME aerodt_simulation_world_tests COMMAND aerodt_simulation_world_tests)
endif()
