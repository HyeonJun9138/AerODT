// Public Cesium tileVisible/extras and application-owned uniform values only.
// A contentless root, a ready tileset, or a bounding sphere is not coverage.
export const HYBRID_REGION_LIMIT=64;
export const HYBRID_MAX_TILE_SPAN=2400;
export const hybridDistance=value=>Number.isFinite(value)?Math.max(500,Math.min(4000,value)):1500;
const names=Array.from({length:HYBRID_REGION_LIMIT},(_,i)=>`u_hybridRegion${i}`);
export function hybridUniformValues(C){
  const vector=(x=0,y=0,z=0,w=0)=>typeof C.Cartesian4==='function'?new C.Cartesian4(x,y,z,w):{x,y,z,w};
  const triple=(x=0,y=0,z=0)=>typeof C.Cartesian3==='function'?new C.Cartesian3(x,y,z):{x,y,z};
  return {u_hybridControl:vector(0,0,1500,0),u_hybridOrigin:triple(),u_hybridEast:triple(1,0,0),u_hybridNorth:triple(0,1,0),
    ...Object.fromEntries(names.map(name=>[name,vector()]))};
}
export function hybridShaderUniforms(C,values){return Object.fromEntries(Object.entries(values).map(([name,value])=>
  [name,{type:name==='u_hybridControl'||names.includes(name)?C.UniformType.VEC4:C.UniformType.VEC3,value}]));}
export const HYBRID_UNIFORM_GLSL=`uniform vec4 u_hybridControl;
uniform vec3 u_hybridOrigin; uniform vec3 u_hybridEast; uniform vec3 u_hybridNorth;
${names.map(name=>`uniform vec4 ${name};`).join('\n')}`;
// Every footprint and native fragment uses the same horizontal coordinates and
// ordered threshold. One representation owns each sample at the near boundary;
// feathering never draws two coincident surfaces or leaves an empty sample.
export const HYBRID_MASK_GLSL=`
bool hybridInRegion(vec2 p, vec4 r) { return p.x >= r.x && p.y >= r.y && p.x <= r.z && p.y <= r.w; }
float hybridPhotoCoverage(vec3 world) {
    if (u_hybridControl.x < 0.5 || u_hybridControl.y < 0.5) return 0.0;
    vec3 delta = world - u_hybridOrigin;
    vec2 p = vec2(dot(delta, u_hybridEast), dot(delta, u_hybridNorth));
    float amount = 1.0 - smoothstep(u_hybridControl.z * 0.8, u_hybridControl.z, length(p));
    if (amount <= 0.0) return 0.0;
    ${names.map((name,i)=>`if (u_hybridControl.y < ${i}.5) return 0.0;\n    if (hybridInRegion(p, ${name})) return amount;`).join('\n    ')}
    return 0.0;
}`;
const validView=view=>view&&Number.isFinite(view.longitude)&&Number.isFinite(view.latitude)&&Math.abs(view.latitude)<=90;
export function validCoverageRegion(region){
  if(!Array.isArray(region)||region.length<4||!region.slice(0,4).every(Number.isFinite))return false;
  const [west,south,east,north]=region;
  if(west>=east||south>=north||Math.abs(west)>Math.PI||Math.abs(east)>Math.PI||Math.abs(south)>Math.PI/2||Math.abs(north)>Math.PI/2)return false;
  const width=(east-west)*6378137*Math.cos((south+north)/2),height=(north-south)*6378137;
  return width>0&&height>0&&width<=HYBRID_MAX_TILE_SPAN&&height<=HYBRID_MAX_TILE_SPAN;
}
function hasGeometry(content){
  if(!content)return false;
  if(Number.isFinite(content.geometryByteLength)&&content.geometryByteLength>0)return true;
  return Array.isArray(content.innerContents)&&content.innerContents.slice(0,16).some(hasGeometry);
}
export class HybridBuildingCoordinator{
  constructor({C,scene,footprints}){
    Object.assign(this,{C,scene,footprints});this.enabled=false;this.distance=1500;this.values=hybridUniformValues(C);
    this.cache=new WeakMap();this.removers=[];this.frameSeen=new Set();this.frameRejected=0;this.frameOverflow=0;this.revision=0;
    this.scratchPoint=typeof C.Cartesian3==='function'?new C.Cartesian3():{x:0,y:0,z:0};
    footprints.setHybridMask(this.values);
    this.removePreRender=scene.preRender.addEventListener(()=>this.beginFrame());
  }
  attach(focus){
    if(this.focus===focus)return;
    for(const remove of this.removers)remove();this.removers=[];
    if(this.focus){this.focus.rangeOverride=null;this.focus.setHybridMask(null);}
    this.focus=focus;this.values.u_hybridControl.y=0;this.cache=new WeakMap();
    if(!focus)return;
    focus.setHybridMask(this.values);focus.rangeOverride=this.enabled&&validView(this.view)?this.distance:null;
    this.removers.push(focus.tileset.tileVisible.addEventListener(tile=>this.visibleTile(tile)));
  }
  setEnabled(enabled){
    this.enabled=Boolean(enabled);this.values.u_hybridControl.x=this.enabled?1:0;this.values.u_hybridControl.y=0;
    if(this.focus)this.focus.rangeOverride=this.enabled&&validView(this.view)?this.distance:null;
    this.scene.requestRender?.();
  }
  update({view,distance=this.distance}={}){
    const radius=hybridDistance(distance),changed=!this.view||!view||this.view.longitude!==view.longitude||this.view.latitude!==view.latitude;
    this.distance=radius;this.view=view;this.values.u_hybridControl.z=radius;
    if(!validView(view)){this.values.u_hybridControl.y=0;if(this.focus)this.focus.rangeOverride=null;return;}
    if(changed){
      const lon=view.longitude*Math.PI/180,lat=view.latitude*Math.PI/180;
      Object.assign(this.values.u_hybridOrigin,this.C.Cartesian3.fromDegrees(view.longitude,view.latitude,0));
      Object.assign(this.values.u_hybridEast,{x:-Math.sin(lon),y:Math.cos(lon),z:0});
      Object.assign(this.values.u_hybridNorth,{x:-Math.sin(lat)*Math.cos(lon),y:-Math.sin(lat)*Math.sin(lon),z:Math.cos(lat)});
      this.revision++;
    }
    if(this.focus)this.focus.rangeOverride=this.enabled?radius:null;
  }
  beginFrame(){
    // These vectors are application data bound to both shaders at construction.
    // Clear before traversal, then tileVisible only updates their components:
    // no primitive/entity mutation during a Cesium traversal event. Uniforms
    // are read at draw time, so unloaded/failed/offscreen tiles never leave a
    // stale mask, including the very first frame after a camera teleport.
    this.values.u_hybridControl.y=0;this.frameSeen.clear();this.frameRejected=0;this.frameOverflow=0;
  }
  visibleTile(tile){
    if(!this.enabled||!validView(this.view)||!this.focus?.tileset.show||this.frameSeen.has(tile))return;
    this.frameSeen.add(tile);
    const region=tile.extras?.aerodtCoverageRegion;
    if(!hasGeometry(tile.content)||!validCoverageRegion(region)){this.frameRejected++;return;}
    let cached=this.cache.get(tile);
    if(!cached||cached.revision!==this.revision){
      const origin=this.values.u_hybridOrigin,eastAxis=this.values.u_hybridEast,northAxis=this.values.u_hybridNorth;
      let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
      for(let corner=0;corner<4;corner++){
        const point=this.C.Cartesian3.fromRadians(region[corner&1?2:0],region[corner&2?3:1],0,undefined,this.scratchPoint);
        const x=point.x-origin.x,y=point.y-origin.y,z=point.z-origin.z;
        const east=x*eastAxis.x+y*eastAxis.y+z*eastAxis.z,north=x*northAxis.x+y*northAxis.y+z*northAxis.z;
        left=Math.min(left,east);right=Math.max(right,east);bottom=Math.min(bottom,north);top=Math.max(top,north);
      }
      cached??={};cached.revision=this.revision;cached.x=left;cached.y=bottom;cached.z=right;cached.w=top;this.cache.set(tile,cached);
    }
    const radius=this.distance;
    if(cached.x>radius||cached.y>radius||cached.z< -radius||cached.w< -radius)return;
    const control=this.values.u_hybridControl,index=control.y;
    if(index>=HYBRID_REGION_LIMIT){this.frameOverflow++;return;}
    const target=this.values[names[index]];target.x=cached.x;target.y=cached.y;target.z=cached.z;target.w=cached.w;control.y=index+1;
  }
  get stats(){return {enabled:this.enabled,distance:this.distance,visibleRegions:this.values.u_hybridControl.y,
    visibleTiles:this.frameSeen.size,rejectedRegions:this.frameRejected,overflowRegions:this.frameOverflow,regionLimit:HYBRID_REGION_LIMIT};}
  destroy(){
    this.setEnabled(false);for(const remove of this.removers)remove();this.removers=[];this.removePreRender?.();
    if(this.focus){this.focus.rangeOverride=null;this.focus.setHybridMask(null);}this.footprints.setHybridMask(null);
    this.frameSeen.clear();this.cache=new WeakMap();this.focus=null;
  }
}
