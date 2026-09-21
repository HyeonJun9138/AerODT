// Original model coordinates and times remain untouched in geometry/envelope.
// Only the rendered line transitions; it is never fed back into predictions.
export const COMPARISON_KIND='uam_prediction_comparison';
export const COMPARISON_MODEL='uam_route_mlp_comparison';
export const COMPARISON_STYLES=Object.freeze({
  uam_route_mlp_short:{key:'short_enabled',color:'#2dd4bf',seconds:10,pattern:'solid',label:'단기'},
  uam_route_mlp_mid:{key:'mid_enabled',color:'#fb923c',seconds:90,pattern:'dashed',dashPattern:0xff00,label:'중기'},
  uam_route_mlp_long:{key:'long_enabled',color:'#c084fc',seconds:240,pattern:'dotted',dashPattern:0xaaaa,label:'장기'},
});
const TRANSITION_MS=300;
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<.001;

export function checkedComparison(value,entityId,positions) {
  if(value?.schema_version!==2 || value.entity_id!==entityId || !Number.isFinite(value.generated_at) ||
      !Number.isFinite(value.epoch) || value.continuity_id==null || typeof value.flight_phase!=='string' ||
      !Array.isArray(value.predictions) || !value.predictions.length || value.predictions.length>3)return null;
  const ids=value.predictions.map(p=>p?.model_id);
  if(new Set(ids).size!==ids.length || ids.some(id=>!Object.hasOwn(COMPARISON_STYLES,id)))return null;
  const predictions=value.predictions.map(entry=>{
    const style=COMPARISON_STYLES[entry.model_id],path=entry.path;
    const statusValid=['ready','warming_up','unavailable'].includes(entry.status);
    const valid=entry.horizon_seconds===style.seconds && statusValid &&
      (entry.status!=='ready' || (path?.kind==='aircraft' && path.reference_frame==='ecef_m' && path.entity_id===value.entity_id &&
        path.epoch===value.epoch && path.continuity_id===value.continuity_id && path.flight_phase===value.flight_phase &&
        path.summary?.model===entry.model_id && close(path.summary?.seconds,style.seconds) &&
        (path.generated_at===undefined || close(path.generated_at,value.generated_at)) && positions(path.points) &&
        path.points[0][0]>=value.generated_at-.001 && close(path.points.at(-1)[0],value.generated_at+style.seconds)));
    return {...entry,color:style.color,pattern:style.pattern,horizon_seconds:style.seconds,
      label:style.label,status:valid?entry.status:'unavailable',path:valid&&entry.status==='ready'?path:null,
      reason:valid?entry.reason:'예측 좌표 또는 기준 시각이 맞지 않아 표시하지 않습니다.'};
  });
  return {...value,predictions};
}

export class UamPredictionComparison {
  constructor(C,viewer,polylines,positions) {
    Object.assign(this,{C,viewer,polylines,positions});this.records=new Map();this.visibility={};this.labels=null;
  }
  enabled(entry) {return this.visibility[COMPARISON_STYLES[entry.model_id].key]!==false;}
  setVisibility(settings={}) {this.visibility=settings.model===COMPARISON_MODEL?{...settings}:{};}
  material(style,hidden=false) {
    const C=this.C,color=C.Color.fromCssColorString(style.color);
    return style.pattern==='solid'
      ? C.Material.fromType('PolylineOutline',{color:color.withAlpha(hidden?.25:.95),outlineColor:C.Color.BLACK.withAlpha(.5),outlineWidth:1})
      : C.Material.fromType('PolylineDash',{color:color.withAlpha(hidden?.25:.95),gapColor:C.Color.TRANSPARENT,
        dashLength:style.pattern==='dotted'?10:20,dashPattern:style.dashPattern});
  }
  geometry(points) {return {points,positions:this.positions(points),from:null};}
  lines(entry,geometry) {
    const style=COMPARISON_STYLES[entry.model_id],positions=geometry.positions;
    return [true,false].map(hidden=>this.polylines.add({positions,width:4,show:true,
      material:this.material(style,hidden),...(hidden?{disableDepthTestDistance:Infinity}:{})}));
  }
  opacity(lines,style,share,visible) {
    if(!lines || (lines.share===share && lines.visible===visible))return;
    lines.share=share;lines.visible=visible;
    for(let i=0;i<(lines?.length??0);i++) {
      lines[i].show=visible&&share>0;
      lines[i].material.uniforms.color=this.C.Color.fromCssColorString(style.color).withAlpha((i===0?.25:.95)*share);
    }
  }
  trim(lines,geometry,time) {
    if(!lines || !geometry)return false;
    const points=geometry.points,from=Number.isFinite(time)?Math.max(time,points[0][0]):points[0][0];
    if(geometry.from===from || from>=points.at(-1)[0])return false;
    geometry.from=from;
    // Original future vertices are reused. The only new vertex is the cut at
    // the current time, linearly interpolated between two served samples.
    let i=0;while(i<points.length-2 && points[i+1][0]<=from)i++;
    const a=points[i],b=points[i+1],u=(from-a[0])/(b[0]-a[0]);
    const cut=this.C.Cartesian3.fromArray(a.slice(1).map((value,k)=>value+(b[k+1]-value)*u));
    // The validated renderer may have downsampled an unusually large response.
    const positions=geometry.positions.length===points.length
      ?[cut,...geometry.positions.slice(i+1)]
      :this.positions([[from,cut.x,cut.y,cut.z],...points.slice(i+1)]);
    for(const line of lines)line.positions=positions;
    return true;
  }
  // A presentation-only connector exposes, rather than translates away, prediction error.
  animateFlow(record,id,now,anchor,visible) {
    const C=this.C,at=anchor?.displayPosition??anchor?.position;
    visible=visible&&Array.isArray(at)&&at.length===3&&at.every(Number.isFinite);
    if(!visible){const changed=record.flow?.some(item=>item.show)??false;for(const item of record.flow??[])item.show=false;return changed;}
    if(!this.flow)this.flow=this.viewer.scene.primitives.add(new C.PolylineCollection());
    const color=C.Color.fromCssColorString(COMPARISON_STYLES[id].color);
    if(!record.flow){
      record.flow=[this.flow.add({id:`${id}:connector`,positions:[],width:2,show:false,
        material:C.Material.fromType('PolylineGlow',{color:color.withAlpha(.45),glowPower:.15})})];
      for(let i=0;i<3;i++)for(const core of [false,true])record.flow.push(this.flow.add({
        id:`${id}:${core?'core':'pulse'}:${i}`,positions:[],width:core?4:9,show:false,
        material:C.Material.fromType('PolylineGlow',{color:color.withAlpha(core?1:.8),glowPower:core?.08:.3})}));
    }
    const points=[C.Cartesian3.fromArray(at),...record.current[0].positions];
    const connector=record.flow[0],old=connector.positions;
    const moved=!connector.show||points.slice(0,2).some((p,i)=>!old[i]||p.x!==old[i].x||p.y!==old[i].y||p.z!==old[i].z);
    connector.positions=points.slice(0,2);connector.show=true;
    const lengths=[0];
    for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y,points[i].z-points[i-1].z));
    const total=lengths.at(-1);
    const cut=d=>{
      let i=1;while(i<lengths.length-1&&lengths[i]<d)i++;
      const a=points[i-1],b=points[i],u=Math.max(0,Math.min(1,(d-lengths[i-1])/Math.max(1e-9,lengths[i]-lengths[i-1])));
      return C.Cartesian3.fromArray([a.x+(b.x-a.x)*u,a.y+(b.y-a.y)*u,a.z+(b.z-a.z)*u]);
    };
    const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for(let i=0;i<3;i++){
      const phase=((now/3600+i/3)%1+1)%1,end=phase*total;
      for(let core=0;core<2;core++){
        const item=record.flow[1+i*2+core],start=Math.max(0,end-total*(core?.002:.035));
        item.show=!reduced&&total>1e-3&&end>start;
        if(item.show){item.positions=[cut(start),...points.filter((_,j)=>lengths[j]>start&&lengths[j]<end),cut(end)];
          item.material.uniforms.color=color.withAlpha(Math.min(1,phase/.04,(1-phase)/.06)*(core?1:.8));}
      }
    }
    return moved||!reduced;
  }
  morph(record,share) {
    const target=record.targetPositions,source=record.morphFrom;
    if(!target?.length)return;
    let positions=target;
    if(source?.length&&share<1){
      const u=share*share*(3-2*share);
      // Corresponding progress along the two visible paths, including both
      // endpoints. Resample the source when the served sample count changes.
      positions=target.map((p,i)=>{
        const at=i/Math.max(1,target.length-1)*(source.length-1),j=Math.floor(at),f=at-j;
        const a=source[j],b=source[Math.min(j+1,source.length-1)];
        return this.C.Cartesian3.fromArray([p.x,p.y,p.z].map((v,k)=>{const old=a[k]+(b[k]-a[k])*f;return old+(v-old)*u;}));
      });
    }
    for(const line of record.current)line.positions=positions;
    record.label.position=positions.at(-1);
  }
  removeLines(lines) {for(const line of lines??[])this.polylines.remove(line);}
  drop(id) {
    const record=this.records.get(id);if(!record)return;
    this.removeLines(record.current);this.removeLines(record.previous);this.removeLines(record.spare);
    for(const item of record.flow??[])this.flow?.remove(item);
    this.labels?.remove(record.label);this.records.delete(id);
  }
  replace(envelope,now,time,anchor) {
    if(this.envelope)this.update(this.envelope,now,time,anchor);
    this.envelope=envelope;
    const ready=new Set(envelope.predictions.filter(p=>p.status==='ready').map(p=>p.model_id));
    for(const id of this.records.keys())if(!ready.has(id))this.drop(id);
    for(const entry of envelope.predictions) {
      if(entry.status!=='ready')continue;
      let record=this.records.get(entry.model_id);
      const key=JSON.stringify(entry.path.points);
      if(record?.key===key)continue; // Same paused/cache result: no new transition or GPU objects.
      const geometry=this.geometry(entry.path.points);
      if(record) {
        record.morphFrom=record.current[0].positions.map(p=>[p.x,p.y,p.z]);
        // Two line pairs per model, reused after warm-up. A faster incoming
        // answer supersedes the older display buffer instead of growing a queue.
        const reusable=record.spare??record.previous;
        record.previous=record.current;record.previousGeometry=record.geometry;record.previousUntil=record.until;
        record.current=reusable??this.lines(entry,geometry);record.spare=null;record.started=now;
      } else {
        this.labels??=this.viewer.scene.primitives.add(new this.C.LabelCollection());
        const C=this.C,style=COMPARISON_STYLES[entry.model_id];
        record={current:this.lines(entry,geometry),previous:null,spare:null,started:now,label:this.labels.add({
          text:`+${style.seconds}초`,font:'bold 13px sans-serif',fillColor:C.Color.fromCssColorString(style.color),
          outlineColor:C.Color.BLACK,outlineWidth:3,style:C.LabelStyle?.FILL_AND_OUTLINE,
          pixelOffset:new C.Cartesian2(0,-14),showBackground:true,backgroundColor:C.Color.BLACK.withAlpha(.72),
          // Labels respect terrain/buildings just like the visible line.
          disableDepthTestDistance:0,
        })};
        this.records.set(entry.model_id,record);
      }
      record.key=key;record.geometry=geometry;record.targetPositions=geometry.positions;
      record.until=entry.path.points.at(-1)[0];record.label.position=this.C.Cartesian3.fromArray(entry.path.points.at(-1).slice(1));
    }
    this.update(envelope,now,time,anchor);
  }
  update(envelope,now,time,anchor) {
    let changed=false;
    for(const entry of envelope.predictions) {
      const record=this.records.get(entry.model_id),expired=entry.status==='ready'&&Number.isFinite(time)&&time>=entry.path.points.at(-1)[0];
      const visible=this.enabled(entry);
      if(entry.visible!==visible || entry.expired!==expired)changed=true;
      entry.visible=visible;entry.expired=expired;
      if(!record)continue;
      const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const style=COMPARISON_STYLES[entry.model_id],share=record.previous&&!reduced?Math.min(1,Math.max(0,(now-record.started)/TRANSITION_MS)):1;
      if(visible&&!expired){
        const trimmed=this.trim(record.current,record.geometry,time);
        if(trimmed)record.targetPositions=record.current[0].positions;
        changed=trimmed||changed;this.morph(record,share);
      }
      this.opacity(record.current,style,1,visible&&!expired);
      this.opacity(record.previous,style,0,false);
      record.label.show=visible&&!expired;
      changed=this.animateFlow(record,entry.model_id,now,anchor,visible&&!expired)||changed;
      if(record.previous) {
        changed=true;
        if(share>=1){record.spare=record.previous;record.previous=null;record.previousGeometry=null;record.morphFrom=null;}
      }
    }
    return changed;
  }
  clear() {for(const id of this.records.keys())this.drop(id);this.envelope=null;}
  destroy() {
    if(this.viewer.isDestroyed?.()){
      this.records.clear();this.envelope=null;this.labels=this.flow=null;return;
    }
    this.clear();if(this.labels)this.viewer.scene.primitives.remove(this.labels);this.labels=null;if(this.flow)this.viewer.scene.primitives.remove(this.flow);this.flow=null;
  }
}
