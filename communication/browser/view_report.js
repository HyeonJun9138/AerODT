// Tells the server which part of the world is on screen, so the aircraft
// provider is asked for that area instead of the whole globe. Display input
// only: the server decides what to request and never treats this as state.
// Reports are rate limited. A sparse refresh also restores the viewport after
// a server restart even when the user leaves the camera still.
const MINIMUM_INTERVAL_MS = 4000;
const MOVED_DEGREES = .02;

export class ViewReporter {
  constructor({send, minimumIntervalMs = MINIMUM_INTERVAL_MS, movedDegrees = MOVED_DEGREES, refreshIntervalMs = 15000,
      now = () => globalThis.performance?.now?.() ?? Date.now()} = {}) {
    Object.assign(this, {send, minimumIntervalMs, movedDegrees, refreshIntervalMs, now});
    this.sentAt = -Infinity; this.sent = null; this.pending = false;
  }
  moved(view) {
    if(!this.sent)return true;
    for(const key of ['lamin','lamax','lomin','lomax'])
      if(Math.abs(view[key] - this.sent[key]) >= this.movedDegrees)return true;
    return false;
  }
  // Returns true when this view was sent. A view is dropped, not queued, when
  // one is already in flight: the next frame carries a newer one anyway.
  report(view) {
    if(!view || !['lamin','lamax','lomin','lomax'].every(key => Number.isFinite(view[key])))return false;
    const now = this.now();
    if(this.pending || now - this.sentAt < this.minimumIntervalMs || (!this.moved(view) && now-this.sentAt<this.refreshIntervalMs))return false;
    this.sentAt = now; this.sent = {...view}; this.pending = true;
    Promise.resolve(this.send(this.sent))
      .catch(() => {this.sent = null;})   // a failed report is retried, not remembered as sent
      .finally(() => {this.pending = false;});
    return true;
  }
}

export function postView(url = '/api/live/view') {
  return async view => {
    const response=await fetch(url, {method: 'POST', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(view),
    signal: AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('화면 범위 전송 실패');
    return response;
  };
}
