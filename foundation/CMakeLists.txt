add_library(aerodt_foundation INTERFACE)
add_library(AeroDT::Foundation ALIAS aerodt_foundation)

target_include_directories(aerodt_foundation INTERFACE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
