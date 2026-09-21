export function validateSnapshot(value) {
  return value?.schema_version === 1 && Number.isInteger(value.sequence) && Number.isFinite(value.state_time) && Array.isArray(value.entities) && Array.isArray(value.sources);
}
// Epoch identifies an intentional clock rebase (live -> simulation/reset).
// Timestamps are ordered only inside that epoch; delayed older epochs stay out.
export function snapshotAfter(snapshot,previous) {
  const epoch=snapshot.epoch??0,prior=previous.epoch??0;
  if(epoch!==prior)return epoch>prior;
  const time=previous.state_time??previous.stateTime??-Infinity;
  return snapshot.state_time>=time && (snapshot.state_time>time || snapshot.sequence>(previous.sequence??-1));
}
export class TrackingClient {
  constructor({url, onSnapshot, onStatus = () => {}, onReset = () => {}, WebSocketClass = globalThis.WebSocket,
    setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis)}) {
    Object.assign(this, {url, onSnapshot, onStatus, onReset, WebSocketClass, setTimer, clearTimer});
    this.epoch = 0; this.sequence = -1; this.stateTime = -Infinity; this.running = false; this.attempt = 0; this.timer = null;
  }
  accept(snapshot) {
    if (!validateSnapshot(snapshot)) { this.onStatus('error', '잘못된 snapshot'); return; }
    if (!snapshotAfter(snapshot,this)) return;
    this.epoch = snapshot.epoch??0; this.sequence = snapshot.sequence; this.stateTime = snapshot.state_time; this.onSnapshot(snapshot);
  }
  start() { if (this.running) return; this.running = true; this.connect(); }
  connect() {
    if (!this.running) return;
    this.timer = null; this.onStatus('connecting', '실시간 연결 중');
    const socket = this.socket = new this.WebSocketClass(this.url);
    let first=true;
    socket.onopen = () => { if(this.socket!==socket || !this.running)return;this.attempt = 0; this.onStatus('ready', '실시간 연결'); };
    socket.onmessage = event => {
      if(this.socket!==socket || !this.running)return;
      try {
        const snapshot=JSON.parse(event.data);
        if(validateSnapshot(snapshot)){
          // A freshly connected server may have restarted TwinWorld at epoch 0.
          // Its first frame is the server's CURRENT snapshot, not a replay.
          // Sequence may already exceed the former server's after a long outage.
          // Later frames and callbacks from replaced sockets cannot reset it.
          if(first && (snapshot.epoch??0)<this.epoch){
            this.epoch=0;this.sequence=-1;this.stateTime=-Infinity;this.onReset();
          }
          first=false;
        }
        this.accept(snapshot);
      } catch { this.onStatus('error', '수신 메시지 오류'); }
    };
    socket.onerror = () => {if(this.socket===socket && this.running)this.onStatus('error', '연결 오류');};
    socket.onclose = () => {
      if (this.socket!==socket || !this.running || this.timer !== null) return;
      this.onStatus('stale', '연결 끊김 · 재연결 중');
      this.timer = this.setTimer(() => this.connect(), Math.min(30000, 1000 * 2 ** this.attempt++));
    };
  }
  stop() { this.running = false; if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.socket?.close(); }
}
