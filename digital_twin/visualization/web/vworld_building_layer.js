// Footprint fallback. Textured buildings use V-World native 3D Tiles.
import {BUILDING_COLOURS,DEFAULT_OPACITY,profileFor,buildingRange,buildingAltitudeFade,BUILDING_NEAR_HEIGHT,BUILDING_FAR_HEIGHT,COVERAGE_GLSL} from './building_streaming.js';
import {hybridUniformValues,HYBRID_UNIFORM_GLSL,HYBRID_MASK_GLSL} from './hybrid_buildings.js';
import {DEFAULT_TINT,appearanceOf} from './building_appearance.js';

// A shader vec3 from three numbers. Cesium's own constructor is preferred where
// there is one; a plain triple is what the uniform needs and is all a stub has.
const vec3=(C,[x,y,z])=>C.Cartesian3?.fromElements?.(x,y,z) ?? {x,y,z};
export const CELL_DEGREES=.01, NEAR_METRES=BUILDING_NEAR_HEIGHT, FAR_METRES=BUILDING_FAR_HEIGHT;
export const CELLS_IN_VIEW=48, CELLS_KEPT=64, CONCURRENT_LOADS=1;
// Cells being fetched at once. Asking for one is about half a second of waiting
// on the provider and costs this machine nothing, so overlapping them is nearly
// free: measured against the running server, six cold cells asked for together
// arrived in 1.4 s against 5.2 s one after another. Handing finished geometry to
// the GPU is the part that can stutter a moving camera, and that budget stays
// where it was -- the two were one number before, so a view of forty-eight cells
// spent almost half a minute waiting on the network one cell at a time.
export const CONCURRENT_FETCHES=4, MOVING_FETCHES=2;
export const MAX_BUILDINGS=18000, MAX_VERTICES=260000, CELL_BUILDINGS=1800;
export const REQUEST_RETENTION_MS=1200;
export const KOREA={west:124,south:32.8,east:132.2,north:39.2};
export const HEIGHT_COLOURS=BUILDING_COLOURS;
export function colourFor(height){return (HEIGHT_COLOURS.find(([floor])=>height>=floor)??HEIGHT_COLOURS.at(-1))[1];}
export function cellKey(column,row){return `${column},${row}`;}
// The degree box round a ring, and whether a cell's own box meets it.
export function boundsOf(ring){
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const point of ring){
    if(point.longitude<west)west=point.longitude;if(point.longitude>east)east=point.longitude;
    if(point.latitude<south)south=point.latitude;if(point.latitude>north)north=point.latitude;
  }
  return {west,south,east,north};
}
export function cellTouches(cell,bounds){
  const west=cell.column*CELL_DEGREES,east=west+CELL_DEGREES,south=cell.row*CELL_DEGREES,north=south+CELL_DEGREES;
  return !(bounds.east<west||bounds.west>east||bounds.north<south||bounds.south>north);
}
// Near cells retain the small buildings as well as the skyline. The old equal
// quota discarded all but 288 of 1,800 footprints beside a low camera. Allocate
// the same total budget by ordered distance, easing back to equal city detail
// above 6 km. A floor still gives every distant cell skyline coverage.
export function buildingCellQuotas(count,height=0){
  if(!count)return [];
  const total=Math.min(MAX_BUILDINGS*.85,count*CELL_BUILDINGS),floor=Math.min(96,total/count);
  const near=1-Math.max(0,Math.min(1,(height-1500)/4500));
  const weights=Array.from({length:count},(_,i)=>1+near*24/(1+(i/3)**2));
  const quotas=weights.map(()=>floor);let remaining=total-floor*count;
  for(let pass=0;pass<count&&remaining>=1;pass++){
    const weight=weights.reduce((sum,w,i)=>sum+(quotas[i]<CELL_BUILDINGS?w:0),0);
    if(!weight)break;
    let used=0;
    for(let i=0;i<count;i++)if(quotas[i]<CELL_BUILDINGS){
      const add=Math.min(CELL_BUILDINGS-quotas[i],remaining*weights[i]/weight);quotas[i]+=add;used+=add;
    }
    remaining-=used;
  }
  return quotas.map(n=>n>=CELL_BUILDINGS-1e-6?CELL_BUILDINGS:Math.max(64,Math.floor(n/32)*32));
}
const validFocus=p=>Number.isFinite(p?.longitude)&&Number.isFinite(p?.latitude);
export function cellsFor(view,limit=CELLS_IN_VIEW,focus=null,range=8000){
  if(!view&&!validFocus(focus))return [];
  const centre=validFocus(focus)?[focus.longitude,focus.latitude]:[(view.lomin+view.lomax)/2,(view.lamin+view.lamax)/2];
  if(!centre.every(Number.isFinite))return [];
  const cos=Math.max(.2,Math.cos(centre[1]*Math.PI/180));
  // The 3D tile view can cover 40 km; never enumerate thousands of Data API
  // cells to imitate that. This fallback covers a bounded patch at the visible
  // ground focus. The native providers are the city-scale representations.
  range=Math.min(range,8000);
  const boundedDx=range/(111320*cos),boundedDy=range/111320;
  const local={lomin:centre[0]-boundedDx,lomax:centre[0]+boundedDx,lamin:centre[1]-boundedDy,lamax:centre[1]+boundedDy};
  const clip=validFocus(focus)?local:view;
  const west=Math.max(clip.lomin,KOREA.west,local.lomin),east=Math.min(clip.lomax,KOREA.east,local.lomax);
  const south=Math.max(clip.lamin,KOREA.south,local.lamin),north=Math.min(clip.lamax,KOREA.north,local.lamax);
  if(!(west<east&&south<north))return [];
  const cells=[];
  for(let column=Math.floor(west/.01);column<=Math.floor(east/.01);column++)
    for(let row=Math.floor(south/.01);row<=Math.floor(north/.01);row++){
      // Do not request corners outside the circular shader coverage.
      const westM=(column*.01-centre[0])*111320*cos,eastM=westM+1113.2*cos;
      const southM=(row*.01-centre[1])*111320,northM=southM+1113.2;
      const dx=Math.max(westM,0,-eastM),dy=Math.max(southM,0,-northM);
      if(Math.hypot(dx,dy)>range*.98)continue;
      const cell={column,row};if(focus?.accepts&&!focus.accepts(cell))continue;
      const x=((column+.5)*.01-centre[0])*cos,y=(row+.5)*.01-centre[1];
      cells.push({...cell,distance:x*x+y*y});
    }
  cells.sort((a,b)=>a.distance-b.distance||a.column-b.column||a.row-b.row);
  return cells.slice(0,limit).map(({column,row})=>({column,row}));
}
export function centroidOf(ring){
  let points=ring;
  if(ring.length>1&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1])points=ring.slice(0,-1);
  let x=0,y=0;for(const [lon,lat] of points){x+=lon;y+=lat;}
  return {longitude:x/points.length,latitude:y/points.length};
}
const verticesOf=b=>b.rings.reduce((n,r)=>n+r.outer.length+(r.holes??[]).reduce((n,h)=>n+h.length,0),0);
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
// How much of the city a fragment survives to cover is carried by an ordered
// dither rather than by alpha, so the city is drawn in the opaque pass.
//
// A translucent surface in Cesium writes no depth. With alpha the route lines,
// the FATO columns and every label behind a building were drawn straight
// through it: a line in front of a tower and a line behind it looked the same,
// and the city had no front or back at all. Dithered coverage keeps the
// see-through look the opacity asks for - at a quarter, three fragments in four
// are discarded and the city reads as glass - while the fragments that do
// survive write depth, so what is behind a building is partly hidden by it and
// the eye gets the near/far cue back. This is the same device the native
// tileset already uses for its solid mode.
export async function fetchCell(column,row,{signal}={}){
  const timeout=AbortSignal.timeout(25000);
  const response=await fetch(`/api/visualization/vworld/buildings/${column}/${row}`,{signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok){const error=new Error('Building provider unavailable');error.disabled=response.status===404;throw error;}
  return response.json();
}
export class VWorldBuildingLayer{
  constructor({C,scene,load=fetchCell,groundHeights=async points=>points.map(()=>0),onStatus=()=>{},yieldWork=yieldTask}){
    Object.assign(this,{C,scene,load,groundHeights,onStatus,yieldWork});
    this.enabled=false;this.near=false;this.surfaceReady=true;this.inside=true;this.disposed=false;
    // Rings of ground another layer owns, and the test that says a footprint
    // runs into one. Both are given from outside, so this layer keeps no idea
    // of what a vertiport is.
    this.cleared=[];this.overlapsCleared=null;
    this.cells=new Map();this.wanted=new Set();this.loading=0;this.building=0;this.queue=[];this.retryAt=0;
    this.streamingBudget={fetches:CONCURRENT_FETCHES,builds:CONCURRENT_LOADS,retainedCells:CELLS_KEPT};
    this.failureCohort=null;this.networkFailures=0;this.networkSuccesses=0;this.geometryBuilds=0;this.groundSamples=0;
    this.generation=0;this.quality='balanced';this.opacity=DEFAULT_OPACITY;this.distance='auto';this.now=0;
    this.tint=DEFAULT_TINT;this.brightness=1;
    this.uniforms={...hybridUniformValues(C),u_buildingOpacity:this.opacity,u_buildingRange:8000,u_buildingHazeDistance:8000,u_buildingHazeStrength:.58,u_buildingAltitudeFade:1,
      u_buildingTint:vec3(C,[1,1,1]),u_buildingBrightness:1,
      u_buildingFocus:C.Cartesian3?.fromDegrees?.(0,0,0)??{x:0,y:0,z:0},u_buildingEyeGround:C.Cartesian3?.fromDegrees?.(0,0,0)??{x:0,y:0,z:0}};
  }
  status(value){if(this.lastStatus!==value){this.lastStatus=value;this.onStatus(value);}}
  get visible(){return this.enabled&&this.near&&this.surfaceReady&&!this.disposed;}
  setHybridMask(values){Object.assign(this.uniforms,values??hybridUniformValues(this.C));this.scene.requestRender?.();}
  setStreamingBudget({fetches=this.streamingBudget.fetches,builds=this.streamingBudget.builds,
    retainedCells=this.streamingBudget.retainedCells}={}){
    const bounded=(value,fallback,lo,hi)=>Number.isFinite(value)?Math.max(lo,Math.min(hi,Math.round(value))):fallback;
    this.streamingBudget={fetches:bounded(fetches,CONCURRENT_FETCHES,1,8),builds:bounded(builds,CONCURRENT_LOADS,1,4),
      retainedCells:bounded(retainedCells,CELLS_KEPT,32,128)};
    this.evict();this.pump();
  }
  setEnabled(enabled){
    this.enabled=Boolean(enabled);
    if(!this.enabled){this.queue=[];for(const cell of this.cells.values())cell.controller?.abort();}
    this.apply();
  }
  setSurfaceReady(ready){if(this.surfaceReady===Boolean(ready))return;this.surfaceReady=Boolean(ready);this.apply();}
  // Ground another layer has taken over: a vertiport deck built on an existing
  // building. A building whose footprint sits under one is not drawn, because
  // the deck stands where it stands and two buildings in one place read as
  // neither. Nothing is deleted -- the cells keep their data, so taking the
  // vertiport away brings its building back on the next rebuild.
  // `overlaps(rings, outline)` answers whether a building's outline runs into
  // one of those rings at all, corner, edge or enclosure. A point test would
  // only ever catch buildings centred on a deck, leaving a neighbour whose
  // corner crosses it standing through the vertiport.
  setCleared(rings,overlaps){
    const next=Array.isArray(rings)?rings:[];
    this.cleared=next;if(overlaps)this.overlapsCleared=overlaps;
    // Where the ground is, not how many pieces of it there are. A vertiport
    // dragged across the street keeps its shape: the same rings with the same
    // number of points, so counting them said nothing had changed and the
    // building it had just moved off stayed hidden while the one it moved onto
    // went on standing through the new deck. Compared to the millimetre, which
    // is far below anything a deck is placed to.
    const signatureOf=ring=>ring.map(point=>`${point.longitude.toFixed(8)},${point.latitude.toFixed(8)}`).join(';');
    const signatures=next.map(signatureOf);
    const previous=this.clearedRings??null;
    this.clearedRings=next.map((ring,at)=>({signature:signatures[at],bounds:ring.bounds??boundsOf(ring)}));
    if(previous===null){this.rebuild();return;}
    const before=new Set(previous.map(r=>r.signature)),after=new Set(signatures);
    // Only the ground that actually changed hands - a deck that moved, came or
    // went - and only the cells under it. Re-extruding the whole city for one
    // deck took seconds and made every building blink out and back.
    const changed=[...previous.filter(r=>!after.has(r.signature)),...this.clearedRings.filter(r=>!before.has(r.signature))];
    if(!changed.length)return;
    this.rebuildWhere(cell=>changed.some(r=>cellTouches(cell,r.bounds)));
  }
  // Build the named cells again with the data they already hold: their
  // primitives stay on screen until the replacement is ready, and the ground
  // under them was not what changed, so their samples are kept.
  rebuildWhere(predicate){
    let any=false;
    for(const cell of this.cells.values()){
      if(!predicate(cell))continue;
      any=true;
      cell.controller?.abort();
      if(cell.pendingPrimitive){this.scene.primitives.remove(cell.pendingPrimitive);cell.pendingPrimitive=null;cell.pendingCount=0;cell.pendingVertices=0;}
      cell.state='waiting';
    }
    if(any){this.queue=[];this.apply();}
    return any;
  }
  isCleared(outline){
    return Boolean(this.cleared?.length)&&Boolean(this.overlapsCleared?.(this.cleared,outline));
  }
  setAppearance({quality=this.quality,opacity=this.opacity,distance=this.distance,
    tint=this.tint,brightness=this.brightness}={}){
    const look=appearanceOf({tint,brightness,opacity});
    if(quality===this.quality&&distance===this.distance&&look.opacity===this.opacity
      &&look.tint===this.tint&&look.brightness===this.brightness)return;
    this.quality=quality;this.distance=distance;
    this.opacity=look.opacity;this.tint=look.tint;this.brightness=look.brightness;
    // Uniforms only. The ramp is baked into the geometry and still says which
    // building is tall; the tint says what the city is made of. Rebuilding to
    // recolour would re-extrude every footprint in view.
    this.uniforms.u_buildingOpacity=this.opacity;
    this.uniforms.u_buildingTint=vec3(this.C,look.rgb);
    this.uniforms.u_buildingBrightness=this.brightness;
    // Every resident appearance already references these uniforms. Replacing
    // each appearance would needlessly rebuild render state during a slider drag.
    this.scene.requestRender?.();
  }
  apply(){
    let ready=false,pending=false,changed=false,retrying=false;
    for(const cell of this.cells.values()){
      // Hidden primitives still build. Exchange only after GPU readiness.
      if(cell.pendingPrimitive&&cell.pendingPrimitive.ready!==false){
        if(cell.primitive)this.scene.primitives.remove(cell.primitive);
        cell.primitive=cell.pendingPrimitive;cell.pendingPrimitive=null;
        cell.count=cell.pendingCount??0;cell.vertices=cell.pendingVertices??0;
        cell.pendingCount=0;cell.pendingVertices=0;changed=true;
      }
      const show=this.visible&&this.wanted.has(cell.key);
      if(cell.primitive){if(cell.primitive.show!==show){cell.primitive.show=show;changed=true;}ready ||= show;}
      pending ||= show&&Boolean(cell.pendingPrimitive);
      retrying ||= this.wanted.has(cell.key)&&cell.retryAt>this.now;
    }
    this.status(!this.enabled?'off':!this.near?'distant':!this.surfaceReady?'terrain':!this.inside?'outside'
      :this.unavailable?'unavailable':ready?'ready':this.loading||this.building||pending?'loading':retrying||this.retryAt?'error':this.queue.length?'loading':'waiting');
    this.showCredit(ready);
    if(changed||pending)this.scene.requestRender?.();
  }
  showCredit(on){
    const display=this.scene.frameState?.creditDisplay;
    if(!display||!this.C.Credit)return;
    if(on&&!this.credit){this.credit=new this.C.Credit('건물: 국토교통부 브이월드',true);display.addStaticCredit(this.credit);}
    else if(!on&&this.credit){display.removeStaticCredit(this.credit);this.credit=null;}
  }
  rebuild(){
    this.generation++;
    for(const cell of this.cells.values()){
      cell.controller?.abort();if(cell.pendingPrimitive)this.scene.primitives.remove(cell.pendingPrimitive);
      cell.pendingPrimitive=null;cell.pendingCount=0;cell.pendingVertices=0;cell.state='waiting';cell.bases=null;
    }
    this.queue=[];this.apply();
  }
  update(altitude,view,now=performance.now(),focus=null,{moving=false,focusPending=false}={}){
    if(this.disposed)return;
    this.now=now;this.focus=focus;this.moving=moving;this.focusPending=focusPending;
    this.near=Number.isFinite(altitude)&&altitude<(this.near?FAR_METRES:NEAR_METRES);
    const range=Math.min(buildingRange(this.distance,altitude),focus?.range??Infinity);
    const reuse=focus&&focus===this.selectionFocus&&this.quality===this.selectionQuality&&range===this.selectionRange&&this.visible===this.selectionVisible;
    const wanted=reuse?this.selectionCells:this.visible?cellsFor(view,profileFor(this.quality).cells,focus,range):[];
    if(!reuse){this.selectionScans=(this.selectionScans??0)+1;this.selectionFocus=focus;this.selectionQuality=this.quality;
      this.selectionRange=range;this.selectionVisible=this.visible;this.selectionCells=wanted;}
    // Spread the fixed geometry budget over the whole patch, rather than
    // exhausting it in the first ten dense cells and leaving the rest empty.
    const quotas=buildingCellQuotas(wanted.length,altitude);
    const centre=validFocus(focus)?focus:view?{longitude:(view.lomin+view.lomax)/2,latitude:(view.lamin+view.lamax)/2}:null;
    if(centre){
      const cos=Math.cos(centre.latitude*Math.PI/180);
      const extent=Math.max(1800,...wanted.map(c=>Math.hypot(((c.column+.5)*.01-centre.longitude)*cos,(c.row+.5)*.01-centre.latitude)*111320+900));
      const shownRange=focus?Math.min(extent,range):extent;
      Object.assign(this.uniforms,{u_buildingRange:shownRange,u_buildingHazeDistance:shownRange+(focus?.offset??0),u_buildingHazeStrength:focus?.hazeStrength??.58,u_buildingAltitudeFade:buildingAltitudeFade(altitude),
        u_buildingFocus:this.C.Cartesian3.fromDegrees?.(centre.longitude,centre.latitude,0)??this.uniforms.u_buildingFocus,
        u_buildingEyeGround:this.C.Cartesian3.fromDegrees?.(focus?.cameraLongitude??centre.longitude,focus?.cameraLatitude??centre.latitude,0)??this.uniforms.u_buildingEyeGround});
    }
    this.wanted=new Set(wanted.map(c=>cellKey(c.column,c.row)));
    this.inside=!this.visible||wanted.length>0||(!view&&!focus);this.queue=[];
    // A small orbit often leaves and returns to the same cell before its HTTP
    // response arrives. Keep only a short, bounded in-flight grace; never build
    // that offscreen response, and cancel immediately on provider disable.
    for(const cell of this.cells.values())if(!this.wanted.has(cell.key)&&
      (cell.stage!=='fetch'||now-(cell.touched??0)>=REQUEST_RETENTION_MS))cell.controller?.abort();
    // A previous view's queued GPU primitive must not compile in the background.
    for(const cell of this.cells.values())if(!this.wanted.has(cell.key)&&cell.pendingPrimitive){
      this.scene.primitives.remove(cell.pendingPrimitive);cell.pendingPrimitive=null;
      cell.pendingCount=0;cell.pendingVertices=0;cell.state='waiting';
    }
    let occupiedCount=0,occupiedVertices=0;
    for(const cell of this.cells.values()){
      occupiedCount+=Math.max(cell.count??0,cell.pendingCount??0);
      occupiedVertices+=Math.max(cell.vertices??0,cell.pendingVertices??0);
    }
    if(this.visible&&!this.unavailable&&now>=this.retryAt){
      this.retryAt=0;
      for(const [order,{column,row}] of wanted.entries()){
        const quota=quotas[order];
        const key=cellKey(column,row);let cell=this.cells.get(key);
        if(!cell){cell={key,column,row,state:'waiting',count:0,vertices:0,limit:quota};this.cells.set(key,cell);}
        // Downgrade oversized warm cells first; an up-close return may enrich
        // a cell again once its budget grows materially (avoid tiny churn).
        // A rapid orbit can change the footprint quota on every pass. Keep a
        // warm cell intact until idle rather than repeatedly re-extruding it.
        if(!moving&&(cell.limit>quota*1.25||cell.limit<quota*.65)){
          cell.limit=quota;cell.controller?.abort();cell.state='waiting';
          if(cell.pendingPrimitive){this.scene.primitives.remove(cell.pendingPrimitive);cell.pendingPrimitive=null;cell.pendingCount=0;cell.pendingVertices=0;}
        }
        if(!moving&&cell.budgetLimited&&cell.state==='ready'&&!cell.pendingPrimitive&&!cell.controller){
          const target=Math.min(cell.limit,cell.data?.length??0);
          const vertices=cell.vertexCounts.slice(0,target).reduce((sum,n)=>sum+n,0);
          // Early close-up batches may have shared memory with still-visible
          // overview geometry. Once distant replacements free enough room,
          // finish their requested detail once, rather than stranding the
          // partially built cell or rebuilding it every frame under pressure.
          if(occupiedCount-cell.count+target<=MAX_BUILDINGS&&occupiedVertices-cell.vertices+vertices<=MAX_VERTICES)cell.state='waiting';
        }
        cell.touched=now;cell.order=order;
        if(['waiting','queued'].includes(cell.state)&&!cell.controller&&!(cell.retryAt>now)){cell.state='queued';this.queue.push(key);}
      }
    }
    this.evict();this.pump();this.apply();
  }
  pump(){
    if(!this.visible||this.unavailable)return;
    // Resident buildings stay visible while the picked model gets a bounded
    // head start on network and GPU work. The caller releases this handoff.
    if(this.focusPending)return;
    const fetches=this.moving?Math.min(MOVING_FETCHES,this.streamingBudget.fetches):this.streamingBudget.fetches;
    const compiles=this.moving?1:this.streamingBudget.builds;
    this.queue=this.queue.filter(key=>{const cell=this.cells.get(key);return cell?.state==='queued'&&this.wanted.has(key)&&!cell.controller;});
    this.queue.sort((a,b)=>this.cells.get(a).order-this.cells.get(b).order);
    // Reserve from CPU preparation through terrain sampling until GPU ready,
    // not merely after the primitive has arrived in the collection. Otherwise
    // four simultaneous responses all pass a nominal one-build limit.
    let compiling=this.building+[...this.cells.values()].filter(c=>c.pendingPrimitive).length;
    while(compiling<compiles){
      const index=this.queue.findIndex(key=>this.cells.get(key).data);
      if(index<0)break;
      const cell=this.cells.get(this.queue.splice(index,1)[0]);
      cell.state='building';cell.stage='build';this.building++;compiling++;
      const generation=this.generation,controller=new AbortController();cell.controller=controller;
      this.fill(cell,generation,controller.signal).catch(()=>{
        cell.state='waiting';
        if(!this.disposed&&generation===this.generation&&!controller.signal.aborted)cell.retryAt=this.now+5000;
      }).finally(()=>{
        if(cell.controller===controller){cell.controller=null;cell.stage=null;}
        if(!cell.pendingPrimitive){cell.pendingCount=0;cell.pendingVertices=0;}
        this.building--;this.apply();this.pump();
      });
    }
    // Download a small ready-to-build buffer even when compilation is occupied,
    // so the next near cell never waits for a network round trip after GPU work.
    const bufferLimit=Math.max(fetches*2,compiles+fetches);
    let buffered=[...this.cells.values()].filter(c=>c.data&&c.state==='queued').length;
    while(!this.retryAt&&!this.failureCohort&&this.loading<fetches&&buffered+this.loading<bufferLimit){
      const index=this.queue.findIndex(key=>!this.cells.get(key).data);
      if(index<0)break;
      const cell=this.cells.get(this.queue.splice(index,1)[0]);
      cell.state='loading';cell.stage='fetch';this.loading++;
      const generation=this.generation,controller=new AbortController();cell.controller=controller;
      this.readCell(cell,generation,controller.signal).then(()=>{
        if(controller.signal.aborted||this.disposed||generation!==this.generation)return;
        this.networkSuccesses++;cell.retryAt=0;
        if(this.failureCohort)this.failureCohort.successes++;
      }).catch(error=>{
        cell.state='waiting';
        if(this.disposed||generation!==this.generation||controller.signal.aborted)return;
        this.networkFailures++;cell.retryAt=this.now+60000;
        this.unavailable=error?.disabled===true;
        // One broken cell must not freeze a healthy city for a minute. Pause
        // new requests until this in-flight cohort settles; multiple failures
        // with no success mean an outage and retain the shared circuit breaker.
        this.failureCohort??={failures:0,successes:0};this.failureCohort.failures++;
      }).finally(()=>{
        if(cell.controller===controller){cell.controller=null;cell.stage=null;}
        this.loading--;
        if(this.failureCohort&&this.loading===0){
          if(this.failureCohort.failures>1&&!this.failureCohort.successes)this.retryAt=this.now+60000;
          this.failureCohort=null;
        }
        if(cell.state==='queued'&&this.wanted.has(cell.key)&&!this.queue.includes(cell.key))this.queue.push(cell.key);
        this.apply();this.pump();
      });
    }
  }
  async readCell(cell,generation,signal){
    const current=()=>!this.disposed&&!signal.aborted&&generation===this.generation&&this.cells.get(cell.key)===cell;
    const data=await this.load(cell.column,cell.row,{signal});
    if(!current()){cell.state='waiting';return;}
    const seen=new Set();
    cell.data=(data?.buildings??[]).filter(b=>{
      if(!b?.rings?.length||!b.rings.every(r=>r.outer?.length>=4))return false;
      const p=centroidOf(b.rings[0].outer);
      // Intersecting API boxes duplicate boundary buildings. Their centroid
      // owns the entire footprint including holes, avoiding coplanar meshes.
      if(Math.floor(p.longitude/.01)!==cell.column||Math.floor(p.latitude/.01)!==cell.row)return false;
      const id=b.id||JSON.stringify(b.rings);if(seen.has(id))return false;seen.add(id);return true;
    }).sort((a,b)=>b.height_m-a.height_m).slice(0,CELL_BUILDINGS);
    cell.centroids=cell.data.map(b=>centroidOf(b.rings[0].outer));cell.vertexCounts=cell.data.map(verticesOf);
    cell.state=this.wanted.has(cell.key)?'queued':'waiting';
  }
  async fill(cell,generation,signal){
    const current=()=>!this.disposed&&!signal.aborted&&generation===this.generation&&this.cells.get(cell.key)===cell&&this.wanted.has(cell.key);
    if(!current()){cell.state='waiting';return;}
    // Reserve before awaiting terrain: simultaneous fills share one budget.
    let count=0,vertices=0;
    for(const other of this.cells.values())if(other!==cell){count+=Math.max(other.count??0,other.pendingCount??0);vertices+=Math.max(other.vertices??0,other.pendingVertices??0);}
    const buildings=[];let usedVertices=0;
    for(const [index,b] of cell.data.slice(0,cell.limit??CELL_BUILDINGS).entries()){
      const n=cell.vertexCounts[index];if(count+buildings.length>=MAX_BUILDINGS||vertices+usedVertices+n>MAX_VERTICES)break;
      buildings.push(b);usedVertices+=n;
    }
    cell.pendingCount=buildings.length;cell.pendingVertices=usedVertices;
    cell.budgetLimited=buildings.length<Math.min(cell.data.length,cell.limit??CELL_BUILDINGS);
    if(!buildings.length&&cell.data.length){cell.state='waiting';return;}
    // Quota and cleared-ground changes should not repeat thousands of exact
    // terrain samples. Keep this cell's samples until a terrain rebuild.
    const cached=cell.bases??[];
    const missing=buildings.length>cached.length?await this.groundHeights(cell.centroids.slice(cached.length,buildings.length)):[];
    if(!current()){cell.state='waiting';return;}
    if(!missing){cell.state='waiting';return;}
    this.groundSamples+=missing.length;
    const bases=cell.bases=cached.concat(missing);
    const primitive=buildings.length?await this.build(buildings,bases,current):null;
    if(!current()){cell.state='waiting';primitive?.destroy?.();return;}
    cell.state='ready';if(primitive){this.geometryBuilds++;primitive.show=false;cell.pendingPrimitive=primitive;this.scene.primitives.add(primitive);this.scene.requestRender?.();}
    else if(!buildings.length){if(cell.primitive)this.scene.primitives.remove(cell.primitive);cell.primitive=null;cell.count=0;cell.vertices=0;}
  }
  appearance(){
    const appearance=new this.C.PerInstanceColorAppearance({translucent:false,closed:true,fragmentShaderSource:`
in vec3 v_positionEC; in vec3 v_normalEC; in vec4 v_color;
uniform float u_buildingOpacity; uniform float u_buildingRange; uniform float u_buildingHazeDistance; uniform float u_buildingHazeStrength; uniform float u_buildingAltitudeFade;
uniform vec3 u_buildingFocus; uniform vec3 u_buildingEyeGround;
uniform vec3 u_buildingTint; uniform float u_buildingBrightness;
${HYBRID_UNIFORM_GLSL}
${COVERAGE_GLSL}
${HYBRID_MASK_GLSL}
void main() {
    vec3 positionWC = (czm_inverseView * vec4(v_positionEC, 1.0)).xyz;
    if (u_hybridControl.x > 0.5 && hybridPhotoCoverage(positionWC) >= buildingThreshold()) discard;
    float distanceToFocus = length(positionWC - u_buildingFocus);
    float distanceToGround = length(positionWC - u_buildingEyeGround);
    float haze = smoothstep(u_buildingHazeDistance * 0.2, u_buildingHazeDistance, distanceToGround);
    float coverage = u_buildingOpacity * u_buildingAltitudeFade * (1.0 - smoothstep(u_buildingRange * 0.65, u_buildingRange * 0.98, distanceToFocus));
    if (coverage < buildingThreshold()) discard;
    czm_materialInput inputMaterial;
    inputMaterial.normalEC = normalize(v_normalEC);
    inputMaterial.positionToEyeEC = -v_positionEC;
    czm_material material = czm_getDefaultMaterial(inputMaterial);
    // The operator's hue and level, over the baked height ramp. A neutral tint
    // and a level of one leave the layer exactly as it was designed.
    vec3 shaded = clamp(czm_gammaCorrect(v_color).rgb * u_buildingTint * u_buildingBrightness, 0.0, 1.0);
    material.diffuse = mix(shaded, vec3(0.50,0.58,0.63), haze * u_buildingHazeStrength);
    material.specular = 0.0;
    material.alpha = 1.0;
    out_FragColor = czm_phong(normalize(-v_positionEC), material, czm_lightDirectionEC);
}`});
    // Cesium 1.143 Primitive reads Appearance.uniforms dynamically. Camera
    // motion updates numbers, never recompiles shaders or reconstructs meshes.
    appearance.uniforms=this.uniforms;return appearance;
  }
  async build(buildings,bases,current=()=>true){
    const C=this.C,instances=[];let started=performance.now();
    for(let index=0;index<buildings.length;index++){
      if(index>0&&(index%160===0||performance.now()-started>4)){await this.yieldWork();if(!current())return null;started=performance.now();}
      const b=buildings[index],base=Number.isFinite(bases[index])?bases[index]:0;
      // A building whose ground a vertiport has taken is skipped here rather
      // than at load, so it comes back when that vertiport goes.
      if(this.isCleared(b.rings[0].outer))continue;
      for(const ring of b.rings)instances.push(new C.GeometryInstance({
        geometry:new C.PolygonGeometry({polygonHierarchy:new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(ring.outer.flat()),
          (ring.holes??[]).map(h=>new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(h.flat())))),
          height:base-.5,extrudedHeight:base+Math.max(1,b.height_m||0),vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),
        attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(colourFor(b.height_m)))}}));
    }
    return new C.Primitive({geometryInstances:instances,allowPicking:false,asynchronous:true,releaseGeometryInstances:true,
      shadows:C.ShadowMode?.DISABLED,appearance:this.appearance()});
  }
  drop(cell){cell.controller?.abort();for(const p of [cell.primitive,cell.pendingPrimitive])if(p)this.scene.primitives.remove(p);cell.primitive=null;cell.pendingPrimitive=null;}
  evict(){
    const idle=[...this.cells.values()].filter(c=>!this.wanted.has(c.key)&&!c.controller).sort((a,b)=>a.touched-b.touched);
    let count=[...this.cells.values()].reduce((n,c)=>n+c.count,0),vertices=[...this.cells.values()].reduce((n,c)=>n+c.vertices,0);
    for(const cell of idle){
      if(this.cells.size<=this.streamingBudget.retainedCells&&count<MAX_BUILDINGS*.8&&vertices<MAX_VERTICES*.8)break;
      this.drop(cell);this.cells.delete(cell.key);count-=cell.count;vertices-=cell.vertices;
    }
  }
  get stats(){return {cells:this.cells.size,visibleCells:[...this.cells.values()].filter(c=>c.primitive?.show).length,
    buildings:[...this.cells.values()].reduce((n,c)=>n+c.count,0),vertices:[...this.cells.values()].reduce((n,c)=>n+c.vertices,0),loading:this.loading,
    building:this.building,compiling:[...this.cells.values()].filter(c=>c.pendingPrimitive).length,
    buffered:[...this.cells.values()].filter(c=>c.data&&c.state==='queued').length,queued:this.queue.length,
    networkFailures:this.networkFailures,networkSuccesses:this.networkSuccesses,geometryBuilds:this.geometryBuilds,groundSamples:this.groundSamples,
    budget:{...this.streamingBudget}};}
  destroy(){this.disposed=true;this.showCredit(false);for(const cell of this.cells.values())this.drop(cell);this.cells.clear();this.queue=[];}
}
// The appearance every footprint cell is drawn with, over the uniforms a layer
// steers. Exported so the loading screen can compile this shader (with its
// hybrid mask, the most expensive program on the page: 1.07 s measured on
// Chrome's Direct3D backend) before the first cell has to.
export function footprintAppearance(C,uniforms){
  return VWorldBuildingLayer.prototype.appearance.call({C,uniforms});
}
