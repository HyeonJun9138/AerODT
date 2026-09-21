import {airspaceBoundaryOf} from './airspace_layer.js';

export const UAM_PICK_RADIUS_PX = 25;
const MODEL_PICK_WIDTH = UAM_PICK_RADIUS_PX * 2 + 1;
const MAX_CENTRE_PROBES = 3;

function deckBackground(picked) {
  const id=typeof picked?.id==='string'?picked.id:picked?.id?.id;
  return typeof id==='string' && /^vertiport:[^:]+:(deck|platform|base)$/.test(id);
}

// CSS/window coordinates match Cesium mouse events, regardless of render scale.
// Only visible UAMs gain slack. Do not create invisible pick geometry or drill
// through buildings: a centre/edge must still win a real depth-tested GPU pick.
export function pickNearbyUam(C, scene, pointer, picked, entityScene, flightLayer) {
  if(picked && !deckBackground(picked))return picked;
  const project=C.SceneTransforms?.worldToWindowCoordinates;
  const canvas=scene.canvas,width=canvas?.clientWidth,height=canvas?.clientHeight;
  if(!project || !(width>0&&height>0))return picked;
  const bufferWidth=scene.drawingBufferWidth??width,bufferHeight=scene.drawingBufferHeight??height;
  const nearby=[];
  function rasterPick(p,size,throughDeck=false) {
    const w=Math.max(1,Math.ceil(size*bufferWidth/width)),h=Math.max(1,Math.ceil(size*bufferHeight/height));
    const hit=scene.pick(p,w,h);
    const background=hit=>airspaceBoundaryOf(hit)||(throughDeck&&deckBackground(hit));
    if(!background(hit))return hit;
    // Only skip these known map overlays. Any other geometry stops the search.
    return scene.drillPick(p,4,w,h).find(hit=>!background(hit));
  }
  function consider(position,model,matches) {
    if(!position)return;
    const p=project(scene,position);
    if(!p || !Number.isFinite(p.x+p.y) || p.x<0||p.y<0||p.x>width||p.y>height)return;
    const distance=Math.hypot(p.x-pointer.x,p.y-pointer.y);
    let edge=false;
    if(model?.show && model.ready!==false && model.boundingSphere){
      const sphere=model.boundingSphere,centre=project(scene,sphere.center);
      const metres=scene.camera.getPixelSize(sphere,bufferWidth,bufferHeight);
      if(centre && metres>0 && Math.hypot(centre.x-pointer.x,centre.y-pointer.y)<=sphere.radius/metres+MODEL_PICK_WIDTH)
        edge=true;
    }
    if(distance<=UAM_PICK_RADIUS_PX||edge)nearby.push({p,distance,matches,edge});
  }
  if(entityScene?.layers?.uam?.visible){
    for(const item of entityScene.frameItems ?? []){
      if(item.entity.kind!=='uam'||item.lod==='hidden'||!(item.point?.show||item.billboard?.show||item.model?.show))continue;
      consider(item.position,item.model,hit=>hit?.id===item.entity.entity_id&&Boolean(hit.primitive)&&
        [item.model,item.point,item.billboard].includes(hit.primitive));
    }
  }
  if(flightLayer?.plan&&flightLayer.visible&&flightLayer.display?.aircraft!==false&&flightLayer.sample?.position){
    const at=flightLayer.sample.position;
    consider(C.Cartesian3.fromDegrees(at.longitude,at.latitude,at.altitude_m),flightLayer.model,hit=>Boolean(flightLayer.pick(hit))&&
      Boolean(hit.primitive)&&(hit.primitive===flightLayer.model||(C.PointPrimitive&&hit.primitive instanceof C.PointPrimitive)));
  }
  nearby.sort((a,b)=>a.distance-b.distance);
  const edges=[];
  for(const candidate of nearby.slice(0,MAX_CENTRE_PROBES)){
    const hit=rasterPick(candidate.p,3);
    if(!candidate.matches(hit))continue;
    if(candidate.distance<=UAM_PICK_RADIUS_PX)return hit;
    if(candidate.edge)edges.push(candidate.matches);
  }
  if(edges.length){
    // Bounds only avoid unnecessary GPU reads. They are never a hit area:
    // the expanded raster pick must actually touch a visible part of the model.
    const hit=rasterPick(pointer,MODEL_PICK_WIDTH,true);
    if(edges.some(matches=>matches(hit)))return hit;
  }
  return picked;
}
