// Bounds how much 3D Tiles content is finished on the main thread per frame.
//
// Cesium 1.143 finishes every tile in a tileset's processing queue in the
// same frame (`processTiles` in Cesium3DTileset: a plain loop over the queue,
// no time slice). Finishing a tile is the expensive part of loading it: the
// vertex and index buffers go to the GPU, the batch texture is written, the
// draw commands and the program are built, and the style is evaluated for
// every feature. A city tile of Cesium OSM Buildings is thousands of
// features, so one arrival is tens of milliseconds, and a flight across a
// city fetches several at once - which is a frame of a hundred milliseconds
// or more whenever a batch lands. The terrain and imagery queue has had a
// time slice for years (`_loadQueueTimeSlice`); tilesets have none.
//
// This gives them one. `Cesium3DTile.prototype.process` is what the loop
// calls per tile, so it is wrapped: within one frame, once the wrapped calls
// have used the allowance, the remaining tiles are left in the queue for the
// next frame. A tile that is still waiting for its bytes costs a few
// microseconds, so the loop still walks past all of those; what the allowance
// bounds is how many tiles that have arrived are finished per frame - one,
// as a rule, since finishing one already spends it. The first call of a frame
// is always made, whatever the allowance, so a single tile can never wait
// forever because it costs more than the budget on its own.
//
// Display only: every tile is still loaded, in the same order, at the same
// detail; only the frame it is finished in moves.
export const DEFAULT_TILE_PROCESS_BUDGET_MS = 3;

export function budgetTileProcessing(C, {budgetMs = DEFAULT_TILE_PROCESS_BUDGET_MS, clock = () => performance.now()} = {}) {
  const proto = C?.Cesium3DTile?.prototype;
  if (!proto || typeof proto.process !== 'function') return null;
  if (proto.aerodtTileBudget) return proto.aerodtTileBudget;
  const original = proto.process;
  const allowance = Math.max(0, Number(budgetMs) || 0);
  const frame = {key: undefined, spent: 0, calls: 0};
  const stats = {processed: 0, deferred: 0, frames: 0};
  proto.process = function (tileset, frameState) {
    // Two scenes (the map and the airframe camera) count frames separately,
    // so a change of key is a new frame for whichever scene is asking.
    const key = frameState?.frameNumber ?? frameState;
    if (key !== frame.key) {frame.key = key; frame.spent = 0; frame.calls = 0; stats.frames++;}
    if (frame.calls > 0 && frame.spent >= allowance) {stats.deferred++; return undefined;}
    const started = clock();
    try {
      return original.call(this, tileset, frameState);
    } finally {
      frame.spent += Math.max(0, clock() - started);
      frame.calls++;
      stats.processed++;
    }
  };
  const budget = {
    budgetMs: allowance,
    stats() {return {...stats};},
    // Back to Cesium's own loop; nothing that was deferred is lost, it is
    // simply finished the next time the queue is walked.
    release() {
      if (proto.process !== original) proto.process = original;
      delete proto.aerodtTileBudget;
    },
  };
  proto.aerodtTileBudget = budget;
  return budget;
}
