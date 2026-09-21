# Feeds the runner a short flight and checks it flew it: states came out at the
# rate that was asked for rather than every tick, the rotors tilted forward on
# the wing-borne leg, and every waypoint was reached -- including the touchdown,
# which the aircraft settles onto rather than closing the last few metres to.
set(PLAN
"step 0.003\nemit 0.2\ncapture 25\ntimeout 400\nwaypoint -30 0 -60 4 0 8\nwaypoint -700 0 -120 40 1 40\nwaypoint -760 0 -60 12 0 20\nwaypoint -760 0 0 3 0 3\nrun\n")
set(INPUT "${CMAKE_CURRENT_BINARY_DIR}/flight_runner_input.txt")
set(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/flight_runner_output.txt")
file(WRITE "${INPUT}" "${PLAN}")
execute_process(
  COMMAND "${RUNNER}"
  INPUT_FILE "${INPUT}"
  OUTPUT_FILE "${OUTPUT}"
  RESULT_VARIABLE STATUS
)
file(READ "${OUTPUT}" REPORT)
if(NOT STATUS EQUAL 0)
  message(FATAL_ERROR "runner exited ${STATUS}:\n${REPORT}")
endif()
if(NOT REPORT MATCHES "\nstate ")
  message(FATAL_ERROR "no states were reported:\n${REPORT}")
endif()
string(REGEX MATCH "done ([0-9]+) ([0-9]+) " REACHED "${REPORT}")
if(NOT CMAKE_MATCH_1 EQUAL CMAKE_MATCH_2)
  message(FATAL_ERROR "only ${CMAKE_MATCH_1} of ${CMAKE_MATCH_2} waypoints were reached")
endif()
# The wing-borne leg must actually tilt the rotors forward.
string(REGEX MATCHALL "state [^\n]*" LINES "${REPORT}")
# Reporting five times a second, not every one of the twenty thousand ticks a
# minute of flight takes: the reader asked for a rate and got it.
list(LENGTH LINES REPORTED)
if(REPORTED GREATER 2000)
  message(FATAL_ERROR "emit was ignored: ${REPORTED} states for a flight of a few hundred")
endif()
set(MAX_TILT 0)
foreach(LINE IN LISTS LINES)
  string(REPLACE " " ";" PARTS "${LINE}")
  list(GET PARTS 11 TILT)
  if(TILT GREATER MAX_TILT)
    set(MAX_TILT ${TILT})
  endif()
endforeach()
if(MAX_TILT LESS 10)
  message(FATAL_ERROR "the rotors never tilted forward (max ${MAX_TILT} degrees)")
endif()
message(STATUS "flight runner: ${CMAKE_MATCH_2} waypoints, ${REPORTED} states, max tilt ${MAX_TILT} degrees")
