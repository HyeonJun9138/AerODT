// Resume one terrain CPU slice after a paint opportunity, not all completed
// downloads in the same microtask checkpoint. Shared by local DEM providers.
const waiting = [];
let scheduled = false;
function schedule() {
  if (scheduled || !waiting.length) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    waiting.shift()();
    schedule();
  };
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    setTimeout(run, 0);
    return;
  }
  let frame;
  const fallback = setTimeout(() => {
    globalThis.cancelAnimationFrame?.(frame);
    run();
  }, 100);
  frame = globalThis.requestAnimationFrame(() => {
    clearTimeout(fallback);
    setTimeout(run, 0);
  });
}
export function yieldTerrainWork() {
  return new Promise(resolve => {waiting.push(resolve); schedule();});
}
