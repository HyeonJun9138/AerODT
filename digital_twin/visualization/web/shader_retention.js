// Keeps compiled WebGL programs alive across primitive churn.
//
// Cesium's ShaderCache hands a program back to the GPU the frame after its
// last primitive goes away (`destroyReleasedShaderPrograms`, called at the top
// of every render). Chrome on ANGLE/Direct3D compiles a program the first time
// its link status is read, and one such wait on this machine is 50-1000 ms:
// measured with the interaction probe, 3.9 s of them during a map load, 3 s
// during one wheel zoom into the city, 1.9 s during a vertiport edit and 3.6 s
// when two UAM models appeared. Nearly all were programs the page had already
// compiled once and thrown away - the city footprint shader after its last
// cell was evicted, the deck material after the deck was rebuilt, the pick
// variants after the picked primitive changed - so keeping them resident turns
// every repeat into a cache hit. A program is small; hundreds of them are a few
// megabytes, and the bound below keeps a long session from collecting forever.
//
// Display only: what is drawn never changes, only when it is compiled.
export const DEFAULT_RETAINED_PROGRAMS = 512;

// Patches the scene's shader cache in place and answers a handle with
// `stats()`; null when the scene has no cache to patch (a stub, a destroyed
// viewer). Patching twice answers the same handle.
export function retainShaderPrograms(scene, {limit = DEFAULT_RETAINED_PROGRAMS} = {}) {
  const context = scene?.context ?? scene?._context;
  const cache = context?.shaderCache ?? context?._shaderCache;
  if (!cache || typeof cache.destroyReleasedShaderPrograms !== 'function') return null;
  if (cache.aerodtRetention) return cache.aerodtRetention;
  const original = cache.destroyReleasedShaderPrograms;
  const bound = Math.max(0, Number(limit) || 0);
  // Released programs, oldest release first. Cesium keeps the entry itself in
  // `_shaders`, so asking for the same source finds it and counts it in use
  // again; only what is still unused when the line is longer than the bound is
  // handed to Cesium's own destroy path.
  const retained = new Map();
  cache.destroyReleasedShaderPrograms = function () {
    const pending = this._shadersToRelease;
    if (pending) {
      for (const keyword in pending) {
        if (!Object.hasOwn(pending, keyword)) continue;
        retained.delete(keyword);
        retained.set(keyword, pending[keyword]);
      }
      this._shadersToRelease = {};
    }
    for (const [keyword, shader] of retained) if (shader.count > 0) retained.delete(keyword);
    if (retained.size <= bound) return;
    const excess = {};
    let over = retained.size - bound;
    for (const [keyword, shader] of retained) {
      if (over-- <= 0) break;
      excess[keyword] = shader;
      retained.delete(keyword);
    }
    const kept = this._shadersToRelease;
    this._shadersToRelease = excess;
    try {original.call(this);} finally {this._shadersToRelease = kept ?? {};}
  };
  const retention = {
    stats() {
      let count = 0;
      for (const shader of retained.values()) if (!(shader.count > 0)) count++;
      return {retained: count, limit: bound};
    },
    // Back to Cesium's own behaviour; what is retained goes on the next frame.
    release() {
      if (cache.destroyReleasedShaderPrograms !== original) cache.destroyReleasedShaderPrograms = original;
      const pending = cache._shadersToRelease ?? {};
      for (const [keyword, shader] of retained) if (!(shader.count > 0)) pending[keyword] = shader;
      cache._shadersToRelease = pending;
      retained.clear();
      delete cache.aerodtRetention;
    },
  };
  cache.aerodtRetention = retention;
  return retention;
}
