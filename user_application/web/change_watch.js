// Several people can have this open at once, and the server is one machine with
// one set of files. A screen does not need to be told what changed, only that
// something did, so it asks for a short revision on a timer and reloads what it
// shows when the answer differs from the one it is holding.
//
// The first answer is only remembered: opening a page never looks like an edit
// somebody else made. A poll that fails is a missed beat, not an error worth
// putting in front of the operator; the next one carries on.
//
// A page nobody is looking at does not ask. Every tab left open behind the
// one being flown was polling the server on its own timer, and each answer
// cost the server's interpreter time that the day's tick and the pilot's
// control step were waiting for. A hidden tab keeps its timer but skips the
// read, and asks the moment it is shown again, so it is never further behind
// than a tab that was open all along.
export const INTERVAL_MS = 5000;

export class ChangeWatch {
  constructor({read, onChange = () => {}, intervalMs = INTERVAL_MS,
    setTimer = globalThis.setTimeout?.bind(globalThis), clearTimer = globalThis.clearTimeout?.bind(globalThis),
    document = globalThis.document ?? null} = {}) {
    Object.assign(this, {read, onChange, intervalMs, setTimer, clearTimer, document});
    this.revision = null; this.timer = null; this.running = false; this.checking = false;
    this.onVisible = () => {if (this.running && !this.hidden()) void this.check();};
  }
  hidden() {return Boolean(this.document?.hidden);}
  // Answers whether the stored data had moved since the last look.
  async check() {
    if (!this.running || this.checking) return false;
    if (this.hidden()) {this.schedule(); return false;}
    this.checking = true;
    let moved = false;
    try {
      const answer = await this.read();
      const revision = answer?.revision ?? null;
      if (revision !== null) {
        moved = this.revision !== null && revision !== this.revision;
        this.revision = revision;
        if (moved) await this.onChange(answer);
      }
    } catch {/* a missed poll: the next one carries on */}
    this.checking = false;
    this.schedule();
    return moved;
  }
  schedule() {
    if (this.timer !== null) {this.clearTimer?.(this.timer); this.timer = null;}
    if (!this.running) return;
    this.timer = this.setTimer?.(() => {this.timer = null; void this.check();}, this.intervalMs) ?? null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.document?.addEventListener?.('visibilitychange', this.onVisible);
    void this.check();
  }
  stop() {
    this.running = false;
    this.document?.removeEventListener?.('visibilitychange', this.onVisible);
    if (this.timer !== null) {this.clearTimer?.(this.timer); this.timer = null;}
  }
}
