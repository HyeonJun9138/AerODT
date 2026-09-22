// The one aircraft of the running day that a person asked to fly.
//
// There is nothing to press. The choosing was done with the plan, in its own
// step, and once the day is running the flight that was asked for either has
// come round or has not. So this has no controls and no place on the console:
// it watches, and when a matching flight is standing there ready, it takes it
// and puts the operator in the cockpit.
//
// A console with nothing to offer should carry nothing -- not an empty box
// under the transport, which is what this replaced.

const seatsOf = request => (request?.seats ? `${request.seats}인` : '아무 기체');

export class ManualAssignmentPanel {
  constructor({api, onAssigned = () => {}, onReleased = () => {}, notify = () => {}} = {}) {
    Object.assign(this, {api, onAssigned, onReleased, notify});
    this.offers = {models: [], flights: []};
    this.assignment = null;
    this.request = {want: false};
  }

  // What the plan asked for. Nothing was assigned there: the flights did not
  // exist yet, so this is a description to match against once they do.
  setRequest(request) {
    this.request = request?.want ? {...request} : {want: false};
    this.last = null;
    this.refused = null;
    this.waiting = false;
    if (!this.request.want) {this.assignment = null; this.offers = {models: [], flights: []};}
    return this.request;
  }

  matching() {
    return (this.offers.flights ?? []).filter(row =>
      (!this.request.seats || Number(row.seats) === Number(this.request.seats)) &&
      (!this.request.vertiport || row.origin === this.request.vertiport));
  }

  // Driven from the day console's own poll. The offers are re-read on a slower
  // beat than the clock: flights become due as the day runs, so a list read
  // once when the console opened is wrong a minute later -- and a request per
  // second for a list that changes every few minutes is waste.
  tick(status, now = Date.now()) {
    if (!this.request?.want) return;
    const ready = Boolean(status?.loaded && status.control_open);
    if (this.ready !== ready) {
      this.ready = ready;
      if (!ready) {this.assignment = null; this.offers = {models: [], flights: []}; return;}
      this.last = null;
    }
    if (!ready) return;
    // The day is the truth about who is flying what: one handed back elsewhere
    // is handed back here too.
    // paint() can replay the pre-assignment status while onReady minimises the
    // console. Only a server-confirmed lease may later be cleared by status.
    if(this.assignment&&status.manual_aircraft===this.assignment.aircraft_id)this.assignmentConfirmed=true;
    if (!status.manual_aircraft && this.assignment && this.assignmentConfirmed) {
      this.assignment = null; this.assignmentConfirmed=false; this.last = null;
    }
    if (this.assignment || this.busy || (this.last != null && now - this.last < 5000)) return;
    this.last = now;
    void this.poll();
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.offers = await this.api.offers();
      // Standing there, ready, and matching what was asked for. Nothing else
      // needs to happen for the operator to be flying it.
      if (!this.assignment && this.matching().length) {
        this.waiting = false;
        await this.assign();
      } else if (!this.assignment && this.request.want && !this.waiting) {
        this.waiting = true;
        this.notify('warning', `수동 배정 대기 · ${this.describe()} 조건의 출발 예정편이 없습니다. 기체·출발지를 확인하거나 시간이 진행될 때까지 기다려 주세요.`);
      }
    } catch (error) {
      const reason=error?.message||'수동 배정 후보를 읽지 못했습니다';
      if(this.refused!==reason){this.refused=reason;this.notify('warning',`수동 배정 확인 실패 · ${reason}`);}
      this.offers = {models: [], flights: []};
    } finally {
      this.busy = false;
    }
  }

  async assign() {
    const next = this.matching()[0];
    if (!next) return null;
    try {
      const answer = await this.api.assign({seats: this.request.seats || null,
        vertiport: this.request.vertiport || null, flight_id: next.flight_id});
      this.assignment = answer;
      this.assignmentConfirmed = false;
      this.refused = null;
      const flight = answer.flight ?? {};
      // Dropping the day to real time is done for the operator rather than
      // asked about, so it is at least said out loud.
      this.notify('ready', `수동 비행 배정 · ${answer.aircraft_id} · ${flight.origin ?? '—'} → ${flight.destination ?? '—'}`
        + (answer.restored_speed ? ` · 배속 ×1 (종료 시 ×${answer.restored_speed} 복구)` : ''));
      await this.onAssigned(answer);
      return answer;
    } catch (error) {
      // Said once. The next beat will try again, and a message a second is not
      // information, it is noise.
      const reason = error.message || '배정하지 못했습니다';
      if (this.refused !== reason) {this.refused = reason; this.notify('warning', `수동 비행 배정 실패 · ${reason}`);}
      return null;
    }
  }

  async release() {
    const held = this.assignment;
    if (!held) return;
    this.assignment = null;
    this.last = null;
    try {await this.api.release({aircraft_id: held.aircraft_id});} catch {}
    this.onReleased(held);
  }

  // The day handed it back some other way -- the flight ended, the console was
  // closed. This follows rather than holding a stale assignment.
  forget() {this.assignment = null; this.last = null;}
  describe() {return this.request?.want ? `${seatsOf(this.request)} · ${this.request.vertiport ?? '아무 출발지'}` : '';}
  destroy() {this.assignment = null;}
}
