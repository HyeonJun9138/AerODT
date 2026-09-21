// Compiles the map's own heavy shaders behind the loading screen.
//
// A program is compiled the first time something drawn with it reaches the
// GPU, and on Chrome's Direct3D backend that wait is 50-1000 ms in the frame
// where it happens: the city footprint shader (with the hybrid mask) measured
// 1.07 s when the first cell arrived during a wheel zoom, the pick pass
// compiled sixteen variants of everything on screen in one 870 ms hover, and
// the first edit of a deck compiled ten translucent variants for 1.5 s. Drawn
// once here, while the loading screen is up, those programs already exist when
// the operator zooms in, places a deck or moves the pointer; the shader cache
// retention keeps them (see shader_retention.js).
//
// Each entry names an appearance factory and, so that the program matches the
// one the real layer asks for, the per-instance attributes and picking that
// layer uses (a batch table attribute or pick colour changes the source). A
// small box is drawn with it a short way ahead of the camera; models are
// loaded and drawn once ready; the camera then visits a few city views with
// the boxes and models carried along (a model near the ground under fog is a
// different program from one in space), each view is picked (which compiles
// the pick variants of everything standing there), the camera is put back,
// and everything is taken away again. Display only, and safe to fail: an
// entry that cannot be built is skipped and reported, a scene that never
// renders settles on a timeout.
export const WARM_UP_FRAMES = 2;
// A model's textures are uploaded and its draw commands built over the frames
// after it is ready; the last stage lasts long enough for that to happen.
export const MODEL_FRAMES = 3;
// Frames behind the loading screen are slow ones (each carries the compiles
// this is for, measured 15 frames in 10 s), so the safety timeout is well
// above the frames the stages need.
const DEFAULT_TIMEOUT_MS = 15000;
const MODEL_TIMEOUT_MS = 8000;

const defaultCanvas = (width, height) => {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
};

// A 2x2 texture so image materials have something to sample.
export function warmUpImage(createCanvas = defaultCanvas) {
  const canvas = createCanvas(2, 2);
  const ctx = canvas.getContext?.('2d');
  if (ctx) {ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 2, 2);}
  return canvas;
}

// `views` are camera poses ({longitude, latitude, height, heading, pitch}).
// `models` are {url, color, scale} glTF files drawn once they are ready.
// `collections` are {name, collection({edge})} factories for point, billboard
// and label collections: a collection's program is chosen by what its members
// use (translucency by distance, a display distance, a rotation), so each is
// built the way the entity layers keep theirs, and placed like the boxes.
export function warmUpShaders({C, scene, appearances = [], views = [], models = [], collections = [], createCanvas = defaultCanvas, size = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, modelTimeoutMs = MODEL_TIMEOUT_MS, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  now = () => performance.now()} = {}) {
  const result = {primitives: 0, collections: 0, models: 0, picked: false, picks: 0, pickWindow: null, frames: 0, views: 0, failed: [], ms: 0};
  if (!C?.Primitive || !C.GeometryInstance || !C.BoxGeometry || !scene || scene.isDestroyed?.() || !scene.primitives) return Promise.resolve(result);
  const started = now();
  const camera = scene.camera;
  const canSweep = views.length > 0 && typeof camera?.setView === 'function' && typeof C.Cartesian3?.fromDegrees === 'function' && camera.positionWC && camera.directionWC && camera.upWC;
  const sweep = canSweep ? views.map(view => ({
    destination: C.Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
    orientation: {heading: (view.heading ?? 0) * Math.PI / 180, pitch: (view.pitch ?? -90) * Math.PI / 180, roll: 0},
  })) : [];
  const resting = canSweep ? {
    destination: C.Cartesian3.clone(camera.positionWC),
    orientation: {direction: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC)},
  } : null;
  // A short way ahead of the camera, whatever it looks at: inside every
  // frustum, and sized so it is a real draw call rather than a sub-pixel one.
  const aheadOf = () => {
    const height = Number(camera?.positionCartographic?.height);
    const ahead = Math.max(200, Number.isFinite(height) ? height * .02 : 0);
    const p = camera?.positionWC, d = camera?.directionWC;
    return p && d ? {ahead, translation: new C.Cartesian3(p.x + d.x * ahead, p.y + d.y * ahead, p.z + d.z * ahead)} : {ahead, translation: new C.Cartesian3(0, 0, 0)};
  };
  const first = aheadOf();
  const edge = size ?? first.ahead * .05;
  const matrixAt = translation => C.Matrix4?.fromTranslation ? C.Matrix4.fromTranslation(translation) : undefined;
  let modelMatrix = matrixAt(first.translation);
  const objects = [];
  // A pick draws only what lies inside its window, so the window is the whole
  // screen: every pick variant of everything in view is compiled, not just
  // the one under the centre pixel (measured: fourteen of them, 600 ms, on
  // the first hover after the arrival when only the centre had been picked).
  const pick = () => {
    try {
      const canvas = scene.canvas;
      const width = Math.max(4, canvas?.clientWidth ?? 4), height = Math.max(4, canvas?.clientHeight ?? 4);
      scene.pick(new C.Cartesian2(width / 2, height / 2), width, height);
      result.picks++;
      result.pickWindow = {width, height};
    } catch {/* a pick that cannot run compiles nothing, and that is all it was for */}
  };
  // Everything drawn is carried along to sit ahead of wherever the camera is:
  // every geometry is built around the origin and placed by the primitive's
  // own matrix. The matrix must be the primitive's, not the instance's: in a
  // scene that is not 3D-only Cesium bakes an instance matrix into world
  // positions, and a primitive matrix set afterwards would move the baked
  // positions again, off the planet (measured: every box culled from every
  // pick while the models beside them were picked).
  const place = () => {
    modelMatrix = matrixAt(aheadOf().translation);
    if (!modelMatrix) return;
    for (const object of objects) {try {object.modelMatrix = modelMatrix;} catch {/* an object without a matrix stays put */}}
  };
  for (const entry of appearances) {
    try {
      const appearance = entry.appearance();
      // The vertex format decides the attributes in the program: a textured
      // material wants texture coordinates, a flat colour wants positions
      // only (a normal would make it a different program from the layer's).
      const vertexFormat = entry.textured
        ? C.MaterialAppearance?.MaterialSupport?.TEXTURED?.vertexFormat
        : appearance?.flat === true && C.PerInstanceColorAppearance?.FLAT_VERTEX_FORMAT
          ? C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT
          : C.PerInstanceColorAppearance?.VERTEX_FORMAT;
      const dimensions = new C.Cartesian3(edge, edge, edge);
      const geometry = typeof entry.geometry === 'function' ? entry.geometry({position: new C.Cartesian3(0, 0, 0), edge})
        : entry.outline ? C.BoxOutlineGeometry.fromDimensions({dimensions})
        : C.BoxGeometry.fromDimensions({vertexFormat, dimensions});
      const attributes = typeof entry.attributes === 'function' ? entry.attributes()
        : entry.textured ? undefined : {color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.WHITE)};
      const primitive = new C.Primitive({geometryInstances: new C.GeometryInstance({geometry, attributes}), modelMatrix,
        appearance, asynchronous: false, allowPicking: entry.allowPicking ?? true});
      scene.primitives.add(primitive);
      objects.push(primitive);
    } catch {result.failed.push(entry.name ?? 'appearance');}
  }
  result.primitives = objects.length;
  for (const entry of collections) {
    try {
      const collection = entry.collection({edge});
      if (!collection) throw new Error('no collection');
      if (modelMatrix) collection.modelMatrix = modelMatrix;
      scene.primitives.add(collection);
      objects.push(collection);
      result.collections++;
    } catch {result.failed.push(entry.name ?? 'collection');}
  }
  const pending = new Set();
  if (models.length && typeof C.Model?.fromGltfAsync === 'function') for (const entry of models) {
    const token = {};
    pending.add(token);
    // The same environment-map setting as the layers' own models: it is part
    // of the program (a model lit by a rendered cube map is one shader, a
    // model lit by the procedural sky is another), and the facilities and
    // aircraft draw without one (see vertiport_facilities.js).
    Promise.resolve().then(() => C.Model.fromGltfAsync({url: entry.url, modelMatrix, scale: entry.scale ?? 1, color: entry.color, show: true,
      ...(entry.flight?{forwardAxis:C.Axis?.X,upAxis:C.Axis?.Y}:{}),
      environmentMapOptions: entry.environmentMapOptions ?? {enabled: false}}))
      .then(model => {
        if (!pending.has(token)) {model.destroy?.(); return;}
        try {scene.primitives.add(model); objects.push(model); result.models++;} catch {pending.delete(token); result.failed.push(entry.name ?? entry.url); return;}
        const settle = () => {pending.delete(token);};
        if (model.ready === true) settle();
        else if (model.readyEvent?.addEventListener) {model.readyEvent.addEventListener(settle); model.errorEvent?.addEventListener?.(settle);}
        else settle();
      })
      .catch(() => {pending.delete(token); result.failed.push(entry.name ?? entry.url);});
  }
  const lookAt = index => {
    try {camera.setView(sweep[index]); result.views = index + 1;} catch {/* a view the camera refuses is skipped */}
    place();
  };
  const restore = () => {if (resting) try {camera.setView(resting);} catch {/* nothing to put back */} place();};
  return new Promise(resolve => {
    let done = false, remove = null, timer = null, modelTimer = null, stage = 'load', stageFrames = 0, index = 0;
    const finish = () => {
      if (done) return;
      done = true;
      remove?.();
      if (timer !== null) clearTimer(timer);
      if (modelTimer !== null) clearTimer(modelTimer);
      if (stage === 'sweep') restore();
      pending.clear();
      for (const object of objects) {try {scene.primitives.remove(object);} catch {/* already gone */}}
      result.picked = result.picks > 0;
      result.ms = now() - started;
      resolve(result);
    };
    remove = scene.postRender?.addEventListener?.(() => {
      result.frames++;
      stageFrames++;
      if (stage === 'load') {
        if (stageFrames < WARM_UP_FRAMES) return;
        if (pending.size) {
          if (modelTimer === null) modelTimer = setTimer(() => {pending.clear();}, modelTimeoutMs);
          return;
        }
        stageFrames = 0;
        if (sweep.length) {stage = 'sweep'; index = 0; lookAt(0);} else stage = 'final';
        return;
      }
      if (stage === 'sweep') {
        if (stageFrames < WARM_UP_FRAMES) return;
        pick();
        stageFrames = 0;
        index++;
        if (index < sweep.length) {lookAt(index); return;}
        restore();
        stage = 'final';
        return;
      }
      if (stageFrames < (result.models ? MODEL_FRAMES : WARM_UP_FRAMES)) return;
      pick();
      finish();
    }) ?? null;
    if (!remove) {finish(); return;}
    scene.requestRender?.();
    timer = setTimer(finish, timeoutMs + (models.length ? modelTimeoutMs : 0));
  });
}
