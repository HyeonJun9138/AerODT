// Perspective screen projection; all coordinates are display-only ECEF.
export function projectView(p,v,out) {
  const x=p.x-v.x,y=p.y-v.y,z=p.z-v.z;
  const depth=x*v.dx+y*v.dy+z*v.dz;if(depth<=0)return false;
  const nx=(x*v.rx+y*v.ry+z*v.rz)/(depth*v.tanHalf*v.aspect);
  const ny=(x*v.ux+y*v.uy+z*v.uz)/(depth*v.tanHalf);
  // Overscan prevents popping at the edge between LOD scans while dragging.
  if(Math.abs(nx)>1.12 || Math.abs(ny)>1.12)return false;
  out.x=(nx+1)*v.width/2;out.y=(1-ny)*v.height/2;out.depth=depth;
  return true;
}
// Cesium 2D: a north-up orthographic map. Screen position follows from the
// object's projected map coordinates and the frustum extents around the view
// centre; depth is the map width so callers see one scale for every object.
export function projectMap(point,v,out) {
  const nx=(point.x-v.cx)/(v.mapWidth/2),ny=(point.y-v.cy)/(v.mapHeight/2);
  if(!Number.isFinite(nx) || !Number.isFinite(ny) || Math.abs(nx)>1.12 || Math.abs(ny)>1.12)return false;
  out.x=(nx+1)*v.width/2;out.y=(1-ny)*v.height/2;out.depth=v.mapWidth;
  return true;
}
export function categoryRange(kind,height) {
  if(height>2000000)return Infinity;
  // A UAM flies the same few hundred metres over the city an aircraft does, so
  // it is carried out to the same distance rather than to a satellite's.
  return kind==='aircraft'||kind==='uam'?Math.max(180000,height*12):Math.max(3500000,height*16);
}
// Where a kind is drawn as its own shape rather than as a mark.
//
// A glyph says what something is - an aircraft, a satellite, a UAM - and which
// way it is going, and that is worth far more than a coloured dot. But pulled
// right back the sky holds thousands of satellites, and a thousand shapes is a
// wall where a thousand dots is a scatter. So the symbol is given up before
// that: it is a camera height, not an object distance, because it is the view
// that gets crowded, not the object that gets small.
//
// Aircraft and UAM fly the few hundred metres over a city, so they stop being
// shapes when the camera leaves that scale. Satellites are hundreds of
// kilometres up and stay shapes until the camera is far enough out to hold a
// large part of the sky at once.
export const SYMBOL_HEIGHTS = {aircraft: 400000, uam: 400000, satellite: 3000000, drone: 400000, bird: 400000};
export function drawsSymbol(kind, cameraHeight) {
  return Number.isFinite(cameraHeight) && cameraHeight <= (SYMBOL_HEIGHTS[kind] ?? 0);
}
// Which kinds the near label band covers. The band is named for aircraft
// because that is the height it was measured at; anything else flying down
// there belongs to it too.
export const NEAR_LABEL_KINDS={aircraft:['aircraft','uam','drone','bird'],satellite:['satellite']};
export function inLabelBand(kind,band){return Boolean(band) && (NEAR_LABEL_KINDS[band] ?? [band]).includes(kind);}
// Camera altitude above the ellipsoid, not target altitude or orbit distance.
// Retain the last display band within 5% of each boundary to avoid zoom flicker.
export function nearLabelPolicy(height,previous) {
  if(!Number.isFinite(height))return null;
  // Extend the original 150 km band by two 1.5x zoom-out button steps.
  const aircraftHeight=150000*1.5**2;
  const aircraftLimit=aircraftHeight*(previous==='aircraft'?1.05:previous==='satellite'?0.95:1);
  const outerLimit=previous==='satellite'?10500000:previous==='off'?9500000:10000000;
  if(height>outerLimit)return null;
  if(height<=aircraftLimit)return {kind:'aircraft',range:Math.max(25000,height*2.5),max:50};
  return {kind:'satellite',range:Infinity,max:50};
}
// A marker that stands for something really there on the ground is drawn at
// that thing's size, so pulling the camera back shrinks it along with the map
// under it. `metresPerPixel` is how much ground one pixel covers where it
// stands; 0 or unknown means the camera has not answered yet, and the marker is
// drawn as the symbol it is. Clamped at both ends: never larger than that
// symbol close in, never smaller than what can still be seen and pointed at.
export function groundMarkerPixels(metres,metresPerPixel,{min,max}) {
  if(!Number.isFinite(metres) || !Number.isFinite(metresPerPixel) || metresPerPixel<=0)return max;
  return Math.min(max,Math.max(min,metres/metresPerPixel));
}
export function screenCell(x,y,width,cell=5) {
  return Math.floor(y/cell)*(Math.ceil(width*1.12/cell)+4)+Math.floor((x+width*.06)/cell);
}

