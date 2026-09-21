// Scene mode helpers. The 2D map is Cesium's north-up orthographic view, where
// the map width plays the part camera distance plays over the globe: Camera
// lookAt centres the map on the target and takes the offset length as width,
// and the instant morph hands a top-down view a map exactly as wide as the
// camera was high. Display only; no Live Twin state is read or changed here.

export function mapOffset(width,result={}) {
  result.x=0;result.y=0;result.z=Math.max(20,width);
  return result;
}

// Width that shows an object at about the size a 3D approach range would.
export function mapWidthForRange(range) {
  return Math.max(40,range*2);
}

// Resolves when the morph Cesium is running settles, whether it finished or a
// later request completed it early; the listener never outlives the morph.
export function morphPromise(scene,start) {
  return new Promise(resolve=>{
    const remove=scene.morphComplete.addEventListener(()=>{remove();resolve();});
    start();
  });
}

// A map is read north-up; rotation, tilt and free look only make sense on the globe.
export function lockMapControls(controller,map) {
  controller.enableRotate=!map;controller.enableTilt=!map;controller.enableLook=!map;
}
