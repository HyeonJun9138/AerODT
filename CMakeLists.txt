cmake_minimum_required(VERSION 3.24)

project(AeroDT VERSION 0.1.0 LANGUAGES CXX)

option(AERODT_BUILD_TESTS "Build AeroDT unit tests" ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(AERODT_BUILD_TESTS)
  enable_testing()
endif()

add_subdirectory(foundation)
add_subdirectory(digital_twin/contracts)
add_subdirectory(digital_twin/simulation)
add_subdirectory(digital_twin/runtime)
add_subdirectory(data)
add_subdirectory(user_application/uam_mission)
add_subdirectory(user_application/apps/uam_native_demo)
add_subdirectory(user_application/apps/uam_flight_runner)
