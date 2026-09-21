import {COMPARISON_KIND,checkedComparison,UamPredictionComparison} from './uam_prediction_comparison.js';

// Draws the path the Live Twin computed for the selected object. This layer
// never propagates orbits or extrapolates velocity itself: it fetches, checks
// and renders. One selected object, with bounded points and refresh rate.
// Learned UAM comparisons use their separate fixed-coordinate renderer below;
// legacy single paths keep the display-following behavior described here.
//
// Two kinds of path, drawn so they cannot be mistaken for each other: a
// satellite's propagated orbit is a solid line, and an aircraft's predicted
// next seconds is a dashed amber one.
//
// A prediction is also the only path that has to move. An orbit stands still
// for minutes; fifteen seconds of aircraft path is overtaken while it is being
// looked at, so between fetches the drawn window slides along the served points
// with the aircraft, anchored on where the aircraft is actually drawn. The
// points and their times all come from the twin - the display chooses which
// stretch of them to show, and never computes a position of its own beyond
// interpolating between two of them.
const PATH_COLOR='#7bddff';
const PREDICTION_COLOR='#ffb457';
const REFRESH_MS=180000;
const PREDICTION_REFRESH_MS=4000;
const UAM_REFRESH_MS=200;
const BLEND_MS=300;

// The phases in which a UAM's predicted path is not drawn: on the ground, on
// the pad, and straight up off it.
export const UAM_UNPREDICTED_PHASES=new Set(['parked','charge','gate_out','takeoff','gate_in','landed','complete']);

export class TrajectoryLayer {
  constructor(C,viewer,{load,onSummary=()=>{},onWarning=()=>{},maximumPoints=1200,
      // Only objects the Live Twin can propagate have a path; nothing is
      // requested for kinds it does not serve one for.
      supports=entity=>entity?.kind==='satellite',
      // Where and when the object is being drawn right now: {time, position}
      // in the same state clock the served points carry. Without one a path is
      // drawn as served and stands still until the next fetch.
      anchor=()=>null,
      now=()=>globalThis.performance?.now?.() ?? Date.now()}={}) {
    Object.assign(this,{C,viewer,load,onSummary,onWarning,maximumPoints,supports,anchor,now});
    this.polylines=viewer.scene.primitives.add(new C.PolylineCollection());
    this.comparison=new UamPredictionComparison(C,viewer,this.polylines,points=>this.positions(points));
    this.line=null;this.entityId=null;this.entityKind=null;this.token=0;this.fetchedAt=-Infinity;this.refreshMs=REFRESH_MS;
    // The served path, kept so the window can slide between fetches.
    this.path=null;this.shownFrom=null;this.pending=null;this.previous=null;this.disposed=false;
    this.retryAt=0;this.failures=0;this.retryContext=null;
  }
  // The position at a state time, between the two served points around it.
  static at(points,moment) {
    if(moment<=points[0][0])return points[0].slice(1);
    for(let i=0;i<points.length-1;i++) {
      const earlier=points[i],later=points[i+1];
      if(moment<=later[0]) {
        const span=later[0]-earlier[0],share=span>0?(moment-earlier[0])/span:0;
        return [earlier[1]+(later[1]-earlier[1])*share,earlier[2]+(later[2]-earlier[2])*share,
          earlier[3]+(later[3]-earlier[3])*share];
      }
    }
    return points[points.length-1].slice(1);
  }
  // The stretch of a served path between two state times, ends included, as
  // [t,x,y,z] rows. Empty when the window has run past what was served.
  static window(points,from,to) {
    if(!Array.isArray(points) || points.length<2 || !(to>from))return [];
    if(from>=points[points.length-1][0])return [];
    const start=Math.max(from,points[0][0]),end=Math.min(to,points[points.length-1][0]);
    if(!(end>start))return [];
    const rows=[[start,...TrajectoryLayer.at(points,start)]];
    for(const point of points)if(point[0]>start && point[0]<end)rows.push(point);
    rows.push([end,...TrajectoryLayer.at(points,end)]);
    return rows;
  }
  // How long a drawn path stays good enough to leave alone. An orbit stands
  // still for minutes; anything predicted from a current state is overtaken
  // while it is being looked at, whether an aircraft or a UAM is flying it.
  refreshFor(kind) {return kind==='satellite'?REFRESH_MS:kind==='uam'?UAM_REFRESH_MS:PREDICTION_REFRESH_MS;}
  // Whether what is drawn is a prediction that has to keep up with the object.
  // The twin serves every prediction as kind 'aircraft', so this asks the path
  // rather than the entity: a UAM flies an aircraft's prediction.
  get predicting() {return this.path?.kind==='aircraft' || this.path?.kind===COMPARISON_KIND;}
  setComparisonVisibility(settings) {
    this.comparison.setVisibility(settings);
    if(this.path?.kind===COMPARISON_KIND){
      this.comparison.update(this.path,this.now(),this.anchor(this.entityId)?.time);this.reportComparison();
    }
  }
  reportComparison(force=false) {
    const now=this.now(),at=this.anchor(this.entityId);
    const age=Number.isFinite(at?.time)?Math.max(0,at.time-this.path.generated_at):null;
    const rate=Number.isFinite(at?.clockRate)?Math.max(1,at.clockRate):1;
    const delayed=Boolean(this.warned || this.refreshUnavailable ||
      (this.pending && now-this.fetchedAt>1000) || (age!==null && age>rate));
    const key=JSON.stringify([this.path.generated_at,delayed,
      this.path.predictions.map(p=>[p.model_id,p.status,p.reason,p.visible,p.expired,p.available_history_seconds])]);
    const freshness=JSON.stringify([age===null?null:Math.floor(age*10)/10,this.responseMs]);
    // Geometry follows each frame. Only the selected details panel gets this
    // slower readout; an unchanged/paused result does not keep repainting it.
    if(force || key!==this.comparisonSummaryKey ||
      (freshness!==this.comparisonFreshnessKey && now-this.comparisonSummaryAt>=250)){
      this.path.display={age_seconds:age,response_ms:this.responseMs??null,delayed};
      this.comparisonSummaryKey=key;this.comparisonFreshnessKey=freshness;this.comparisonSummaryAt=now;
      this.onSummary(this.path);
    }
  }
  // hidden: the copy that shows through whatever is in front of it, so it is
  // faint enough not to be mistaken for the line itself.
  material(kind,hidden=false) {
    const C=this.C;
    if(kind==='aircraft') {
      const color=C.Color.fromCssColorString(PREDICTION_COLOR);
      return C.Material.fromType('PolylineDash',{color:color.withAlpha(hidden?.3:.95),
        gapColor:C.Color.TRANSPARENT ?? color.withAlpha(0),dashLength:14});
    }
    const color=C.Color.fromCssColorString(PATH_COLOR);
    return C.Material.fromType('PolylineOutline',{color:color.withAlpha(hidden?.28:.85),
      outlineColor:C.Color.BLACK.withAlpha(hidden?.18:.55),outlineWidth:1.5});
  }
  positions(points) {
    if(!Array.isArray(points) || points.length<2)return null;
    if(!points.every(point=>Array.isArray(point) && point.length===4 && point.every(Number.isFinite)))return null;
    if(points.some((point,i)=>i>0 && point[0]<=points[i-1][0]))return null;
    const count=Math.min(points.length,Math.max(2,this.maximumPoints));
    const result=[];
    for(let i=0;i<count;i++) {
      const index=Math.round(i*(points.length-1)/(count-1));
      const point=points[index];
      if(!Array.isArray(point) || point.length!==4 || !point.every(Number.isFinite))return null;
      result.push(this.C.Cartesian3.fromArray(point.slice(1)));
    }
    return result.length>=2?result:null;
  }
  draw(path) {
    const positions=this.positions(this.drawnPoints(path));
    if(!positions)return false;
    const width=path?.kind==='aircraft'?4:3;
    if(this.line && this.lineKind===path?.kind){
      this.line.positions=positions;this.ghost.positions=positions;
      return true;
    }
    this.remove();this.lineKind=path?.kind;
    // The faint one first, so the solid line sits on top of it where both are
    // drawn. Behind a building only the faint one is left, which says the path
    // is there and behind something rather than hiding it or pretending it is
    // in front. Cesium's own credits call this a depth-fail material; a
    // PolylineCollection has no such option, so it is a second line.
    this.ghost=this.polylines.add({positions,width,material:this.material(path?.kind,true),
      disableDepthTestDistance:Number.POSITIVE_INFINITY});
    this.line=this.polylines.add({positions,width,material:this.material(path?.kind)});
    return true;
  }
  // What is drawn of a served path: an orbit whole, a prediction the window
  // that starts where the aircraft is now and runs the span it was asked for.
  drawnPoints(path) {
    const at=this.anchor(this.entityId ?? path?.entity_id);
    const rows=this.anchoredPoints(path,at);
    if(!this.previous || !rows?.length)return rows;
    const alpha=Math.min(1,Math.max(0,(this.now()-this.blendAt)/BLEND_MS));
    if(alpha>=1){this.previous=null;return rows;}
    const old=this.anchoredPoints(this.previous,at);
    if(!old?.length)return rows;
    const mix=alpha*alpha*(3-2*alpha);
    // Same display time in both predictions; only blend where both have coverage.
    let j=0;
    return rows.map(point=>{
      if(point[0]<old[0][0] || point[0]>old.at(-1)[0])return point;
      while(j<old.length-2 && old[j+1][0]<point[0])j++;
      const a=old[j],b=old[j+1],f=(point[0]-a[0])/(b[0]-a[0]);
      return [point[0],...point.slice(1).map((v,k)=>(a[k+1]+(b[k+1]-a[k+1])*f)*(1-mix)+v*mix)];
    });
  }
  anchoredPoints(path,at) {
    if(path?.kind!=='aircraft' || !Array.isArray(path.points) || path.points.length<2)return path?.points;
    const span=Number(path.summary?.seconds);
    const from=Number.isFinite(at?.time)?at.time:path.points[0][0];
    this.shownFrom=from;
    // A fresh forecast can start just ahead of the buffered display. Translate
    // its time origin together, instead of stretching one short first segment.
    const shift=Math.min(0,from-path.points[0][0]);
    const points=shift?path.points.map(p=>[p[0]+shift,...p.slice(1)]):path.points;
    const rows=TrajectoryLayer.window(points,from,from+(Number.isFinite(span)?span:0));
    if(rows.length<2)return null;
    // The line starts on the aircraft itself rather than a hair off it: the
    // display's own interpolation and the twin's samples are the same motion,
    // but they are read at slightly different instants.
    if(Array.isArray(at?.position) && at.position.length===3 && at.position.every(Number.isFinite)) {
      const offset=at.position.map((v,k)=>v-rows[0][k+1]);
      const display=at.displayPosition?.every(Number.isFinite)?at.displayPosition:at.position;
      const lift=display.map((v,k)=>v-at.position[k]);
      for(let i=0;i<rows.length;i++){
        const u=Math.min(1,Math.max(0,(rows[i][0]-from-2)/6));
        const weight=1-u*u*(3-2*u);
        rows[i]=[rows[i][0],...rows[i].slice(1).map((v,k)=>v+offset[k]*weight+lift[k])];
      }
    }
    return rows;
  }
  // Between fetches the window slides, so the path keeps up with the aircraft
  // instead of standing still and jumping when the next one arrives. Returns
  // true when something changed on screen.
  follow() {
    if(!this.predicting)return false;
    const at=this.anchor(this.entityId);
    if(this.contextChanged(this.path,at)){
      this.token++;this.pending=null;this.path=this.previous=null;this.fetchedAt=-Infinity;
      this.remove();this.onSummary(null);return true;
    }
    if(this.path?.kind===COMPARISON_KIND){
      const changed=this.comparison.update(this.path,this.now(),at?.time,at);this.reportComparison();return changed;
    }
    if(!Number.isFinite(at?.time) || (at.time===this.shownFrom && !this.previous &&
      JSON.stringify(at.displayPosition ?? at.position)===this.shownPosition))return false;
    this.shownPosition=JSON.stringify(at.displayPosition ?? at.position);
    if(this.draw(this.path))return true;
    // Nothing of the served path is ahead of the aircraft any more.
    this.remove();this.path=this.previous=null;this.onSummary(null);
    return true;
  }
  contextChanged(path,at) {
    return Boolean(path && at && ((path.epoch!==undefined && at.epoch!==undefined && path.epoch!==at.epoch) ||
      (path.continuity_id!==undefined && (path.continuity_id??0)!==(at.continuity_id??0)) ||
      (path.flight_phase && at.phase && path.flight_phase!==at.phase)));
  }
  // A UAM on the ground, or standing straight up off the pad, has no predicted
  // path worth drawing: it is taxiing a painted line or climbing a vertical.
  // The path is asked for from the climb-out on. The phase is read from the
  // anchor - the twin's own clock - and from the entity when there is none.
  grounded(entity) {
    if(entity?.kind!=='uam')return false;
    const phase=this.anchor?.(entity.entity_id)?.phase ?? entity.flight_phase;
    return UAM_UNPREDICTED_PHASES.has(phase);
  }
  requestContext() {
    const at=this.anchor(this.entityId);
    return JSON.stringify([at?.epoch,at?.continuity_id,at?.phase]);
  }
  deferRetry() {
    // Missing input/retired entities are not a reason to hammer HTTP at 5 Hz.
    // Wall time, not accelerated simulation time; recovery is still retried.
    this.failures=Math.min(5,this.failures+1);
    this.retryAt=this.now()+Math.min(15000,1000*2**(this.failures-1));
    this.retryContext=this.requestContext();
  }
  async show(entity) {
    if(this.disposed)return;
    const id=entity?.entity_id ?? null;
    if(id===null || !this.supports(entity)){this.clear();return;}
    if(id===this.entityId && this.pending)return;
    if(id!==this.entityId){this.remove();this.path=this.previous=null;this.shownFrom=null;this.responseMs=null;this.warned=false;this.refreshUnavailable=false;
      this.retryAt=0;this.failures=0;this.retryContext=null;}
    this.entityId=id;this.entityKind=entity.kind;this.refreshMs=this.refreshFor(entity.kind);
    if(this.grounded(entity)){
      // Kept selected and polled on the usual schedule, so the path appears
      // the moment the aircraft leaves the vertical; nothing is asked for now.
      if(this.line || this.path){this.remove();this.path=this.previous=null;this.shownFrom=null;this.onSummary(null);}
      this.fetchedAt=this.now();return;
    }
    const token=++this.token;this.fetchedAt=this.now();
    let path=null;
    try {this.pending=Promise.resolve(this.load(id));path=await this.pending;}
    catch {
      if(token===this.token && this.entityId===id) {
        this.deferRetry();
        if(!this.path){this.remove();this.onSummary(null);}
        if(!this.warned){this.warned=true;this.onWarning('예측 갱신이 지연되고 있습니다. 유효한 구간까지만 표시합니다.');}
      }
      return;
    }
    finally {if(token===this.token)this.pending=null;}
    // A slower earlier request must not paint over the current selection.
    if(token!==this.token || this.entityId!==id)return;
    this.responseMs=Math.max(0,this.now()-this.fetchedAt);
    if(path==null)this.deferRetry();
    else {this.retryAt=0;this.failures=0;this.retryContext=null;}
    // A state/phase stream can briefly lag its HTTP forecast. Discard that
    // answer without bypassing the request rate limit on every rendered frame.
    if(this.contextChanged(path,this.anchor(id))){this.refreshUnavailable=true;return;}
    // A prediction the twin cannot serve any more (the state went stale) leaves
    // the last one drawn until its own window runs out, rather than blinking.
    if(path===null && this.entityKind!=='satellite' && this.path){this.refreshUnavailable=true;return;}
    if(path?.kind===COMPARISON_KIND){
      const checked=checkedComparison(path,id,points=>this.positions(points));
      if(!checked){this.remove();this.path=this.previous=null;this.onSummary(null);return;}
      if(this.path?.kind===COMPARISON_KIND && checked.generated_at<this.path.generated_at){this.refreshUnavailable=true;return;}
      if(this.path?.kind!==COMPARISON_KIND)this.remove();
      this.warned=false;this.refreshUnavailable=false;this.previous=null;this.path=checked;
      this.comparison.replace(checked,this.now(),this.anchor(id)?.time,this.anchor(id));this.reportComparison();return;
    }
    if(path && (!Array.isArray(path.points) || path.points.length<2 ||
      !path.points.every((p,i)=>Array.isArray(p) && p.length===4 && p.every(Number.isFinite) &&
        (i===0 || p[0]>path.points[i-1][0])))){
      this.path=this.previous=null;this.remove();this.onSummary(null);return;
    }
    this.warned=false;this.refreshUnavailable=false;
    if(this.path?.kind===COMPARISON_KIND)this.remove();
    this.previous=this.predicting && path?.kind==='aircraft'?this.path:null;this.blendAt=this.now();
    this.path=path;
    if(!this.draw(path)){this.remove();this.path=null;this.onSummary(null);return;}
    this.onSummary(path);
  }
  // Called from the render loop; refetches at most once per refresh window.
  update(now=this.now()) {
    if(this.retryAt && this.retryContext!==this.requestContext()){
      this.retryAt=0;this.failures=0;this.retryContext=null;this.fetchedAt=-Infinity;
    }
    const rate=this.entityKind==='uam'?Math.max(1,this.anchor(this.entityId)?.clockRate??1):1;
    if(this.disposed || this.pending || this.entityId===null || now<this.retryAt || now-this.fetchedAt<Math.max(200,this.refreshMs/rate))return;
    return this.show({entity_id:this.entityId,kind:this.entityKind});
  }
  remove() {
    this.comparison.clear();this.comparisonSummaryKey=this.comparisonFreshnessKey=null;this.comparisonSummaryAt=-Infinity;
    if(this.line)this.polylines.remove(this.line);
    if(this.ghost)this.polylines.remove(this.ghost);
    this.line=this.ghost=null;
  }
  clear() {
    this.token++;this.entityId=null;this.entityKind=null;this.fetchedAt=-Infinity;this.refreshMs=REFRESH_MS;
    this.retryAt=0;this.failures=0;this.retryContext=null;
    this.path=this.previous=null;this.pending=null;this.shownFrom=null;this.warned=false;this.refreshUnavailable=false;this.responseMs=null;this.remove();this.onSummary(null);
  }
  destroy() {
    if(this.disposed)return;
    this.disposed=true;this.token++;this.entityId=null;this.line=null;this.pending=null;this.path=this.previous=null;
    // A shared viewer may already have been destroyed by an earlier pagehide
    // listener. Its scene getter is no longer usable and owns the GPU cleanup.
    if(this.viewer.isDestroyed?.()){this.comparison.destroy();return;}
    this.polylines.removeAll?.();
    this.comparison.destroy();
    this.viewer.scene.primitives.remove(this.polylines);
  }
}
