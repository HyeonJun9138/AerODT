add_library(aerodt_digital_twin_contracts INTERFACE)
add_library(AeroDT::DigitalTwinContracts ALIAS aerodt_digital_twin_contracts)

target_include_directories(aerodt_digital_twin_contracts INTERFACE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(aerodt_digital_twin_contracts INTERFACE AeroDT::Foundation)
