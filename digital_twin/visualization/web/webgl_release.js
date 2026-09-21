// Giving a WebGL context back when its widget goes away.
//
// The browser keeps a small number of WebGL contexts alive - Chrome allows
// sixteen per page - and when a new one is asked for past that number, the
// OLDEST one on the page is taken away. On this page the oldest context is the
// map. Cesium's `destroy()` frees a widget's GPU resources but does not release
// the context itself; that only happens when the garbage collector gets to the
// canvas, which can be long after. So a camera that was restarted a dozen times
// (a tab hidden and shown, an aircraft changed, a direction changed), a model
// preview reopened on every selection, or a twinning window reopened a few
// times, was enough: the map's context was evicted, every model on it stopped
// drawing while its labels went on, and the console filled with "object does
// not belong to this context". Nothing on the page recovers from that but a
// reload.
//
// `WEBGL_lose_context.loseContext()` is the documented way to hand a context
// back on purpose. Called after the widget is destroyed, it makes the slot free
// at once instead of eventually.

// Release the context under a Cesium widget that has already been destroyed
// (or is about to be). Returns true when a context was actually released.
export function releaseWidgetContext(widget){
  if(!widget)return false;
  const canvas=widget.canvas??widget.scene?.canvas;
  // Destroyed whether or not a context can be found under it: the release is
  // in addition to the teardown, never instead of it.
  try{if(typeof widget.destroy==='function'&&!widget.isDestroyed?.())widget.destroy();}catch{}
  return canvas?releaseCanvasContext(canvas):false;
}

// A canvas that already has a WebGL context returns that same context from
// `getContext`; a canvas that never had one gets none created here, because
// asking with a context type would create one just to lose it.
export function releaseCanvasContext(canvas){
  if(!canvas||typeof canvas.getContext!=='function')return false;
  let gl=null;
  try{gl=canvas.getContext('webgl2')??canvas.getContext('webgl');}catch{return false;}
  if(!gl)return false;
  try{if(typeof gl.isContextLost==='function'&&gl.isContextLost())return false;}catch{}
  try{
    const extension=gl.getExtension?.('WEBGL_lose_context');
    if(!extension?.loseContext)return false;
    extension.loseContext();
    return true;
  }catch{return false;}
}
