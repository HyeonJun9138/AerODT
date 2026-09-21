// Read-only rendering geometry. Never alters an observed asset's altitude.
export function pickGround(camera,scene,screen,result) {
  const ray=camera.getPickRay(screen);
  return (ray && scene.globe.pick(ray,scene,result)) || camera.pickEllipsoid(screen,scene.globe.ellipsoid,result);
}
export function clearanceHeight(height,groundHeight,clearance=20) {
  return Math.max(height,(Number.isFinite(groundHeight)?groundHeight:0)+clearance);
}
export class SurfaceReadiness {
  constructor(){this.anchor=null;this.radius=0;}
  update(providerReady,tilesLoaded,position,height) {
    if(!providerReady || !position || height>25000){this.anchor=null;return false;}
    if(tilesLoaded){
      this.anchor={x:position.x,y:position.y,z:position.z};this.radius=Math.max(20000,height*10);return true;
    }
    // Keep a loaded local surface while the camera stays in the same region.
    // Following an object pans every frame, so the frame in which every tile
    // has finished may not come for a while; a 2 km radius dropped the
    // buildings a few seconds into every pursuit. A distant jump must still
    // await its own terrain, not reuse the previous region.
    return !!this.anchor && Math.hypot(position.x-this.anchor.x,position.y-this.anchor.y,position.z-this.anchor.z)<this.radius;
  }
}
