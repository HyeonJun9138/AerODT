#pragma once

namespace aerodt::digital_twin::simulation::control::simple_flight {

struct PidParameters {
  double proportional_gain{0.01};
  double integral_gain{};
  double derivative_gain{};
  double minimum_output{-1.0};
  double maximum_output{1.0};
  double output_bias{};
  double integral_discount{1.0};
  double minimum_step_seconds{1e-6};
  bool enabled{true};
  bool conditional_integration{false};
};

class PidController {
 public:
  explicit PidController(PidParameters parameters = {});

  void Reset(double goal = 0.0, double measured = 0.0);
  void ClearIntegral() noexcept;
  [[nodiscard]] double Update(double goal, double measured, double step_seconds);
  [[nodiscard]] double Output() const noexcept;
  [[nodiscard]] double IntegralTerm() const noexcept;

 private:
  PidParameters parameters_;
  double integral_term_{};
  double last_error_{};
  double output_{};
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
