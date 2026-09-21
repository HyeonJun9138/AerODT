// Normalized GLBs stay inside the existing layout envelope. No facilities or
// clearances are created here; the server owns their locations and dimensions.
export function facilityGraphic(C,kind,size,fade=1,far=3000){
 if(!Array.isArray(size)||size.length!==3||!size.every(n=>Number.isFinite(n)&&n>0))return null;
 return {uri:`/visual-assets/procedural/vertiport_facilities/${kind==='charger'?'charging_station':'boarding_pavilion'}.glb?v=20260917-realism`,
  nodeTransformations:{Facility:{scale:new C.Cartesian3(size[0],size[2],size[1])}},
  minimumPixelSize:0,runAnimations:false,shadows:C.ShadowMode?.ENABLED,
  // A cabinet on a deck needs no reflection of its surroundings: the dynamic
  // environment map Cesium would render for it compiles a convolution program
  // that measured 0.9 s the first time such a model came into view.
  environmentMapOptions:{enabled:false},
  color:C.Color.fromCssColorString('#ffffff').withAlpha(fade),
  distanceDisplayCondition:new C.DistanceDisplayCondition(0,far)};
}
