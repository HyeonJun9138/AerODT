// Camera distances are metres (2D: orthographic width). Motion uses a monotonic
// wall clock, never the paused, accelerated or reversed orbital analysis clock.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const cameraNow = () => globalThis.performance?.now?.() ?? Date.now();
export const cameraEase = t => t * t * (3 - 2 * t);

export class CameraRangeMotion {
  constructor({ now = cameraNow } = {}) {
    this.now = now;
    this.cancel();
  }

  get active() { return this.target !== null; }

  cancel() {
    this.target = null;
    this.direction = 0;
    this.stamp = null;
  }

  moveTo(current, target) {
    if (!(current > 0) || !Number.isFinite(current) || !(target > 0) || !Number.isFinite(target)) return false;
    if (!this.active) this.stamp = this.now();
    this.direction = Math.sign(current - target);
    this.target = target;
    return true;
  }

  wheel(current, delta, { minimum = 1, maximum = Number.MAX_VALUE, focusRange = 0 } = {}) {
    if (!Number.isFinite(delta) || !delta || !(current > 0) || !Number.isFinite(current)) return false;
    // Accumulate same-direction input, but reverse from the displayed distance,
    // not from an unseen goal. A reverse wheel immediately cancels auto-approach.
    const base = this.active && Math.sign(delta) === this.direction ? this.target : current;
    const gain = focusRange > 0
      ? .0015 + clamp(Math.log(base / (focusRange * 5)) * .0009, 0, .006)
      : .0015;
    let target = base * Math.exp(-clamp(delta, -240, 240) * gain);
    if (delta > 0 && focusRange > 0 && base > focusRange * 8 && target <= Math.max(20_000, focusRange * 100)) {
      target = focusRange;
    }
    // Continued input during the approach must not drive through the model.
    if (delta > 0 && focusRange > 0 && current > focusRange * 8 && base <= focusRange) target = focusRange;
    return this.moveTo(current, clamp(target, minimum, maximum));
  }

  advance(current) {
    if (!this.active) return current;
    if (!(current > 0) || !Number.isFinite(current)) { this.cancel(); return current; }
    const now = this.now();
    // Dropped/background frames are not replayed as a single huge camera jump.
    const dt = clamp(now - this.stamp, 0, 50);
    this.stamp = now;
    const error = Math.log(this.target / current);
    if (Math.abs(error) < 1e-5) {
      const target = this.target; this.cancel(); return target;
    }
    const step = clamp(error * -Math.expm1(-dt / 180), -dt * .012, dt * .012);
    return current * Math.exp(step);
  }
}
