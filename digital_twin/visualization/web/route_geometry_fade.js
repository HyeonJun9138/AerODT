import {LABEL_FADE_MS,labelFadeAlpha,labelDistanceAlpha} from './label_fade.js';
const read=(p,t)=>p?.getValue?p.getValue(t):p;
const same=(a,b)=>a&&b&&['red','green','blue','alpha'].every(k=>a[k]===b[k]);
const differs=(a,b)=>a[0]!==b[0]||a[1]!==b[1]||a[2]!==b[2]||a[3]!==b[3];

// Updates presentation attributes only. Never rebuild the network during a fade.
export class RouteGeometryFade {
  // `started` counts the fades that began (see InfrastructureLabelFade).
  constructor(C) {this.C=C;this.states=new WeakMap();this.colors=new WeakMap();this.started=0;}
  // Fade everything in again from nothing, without forgetting what colour
  // anything is. The two are separate on purpose: `states` is the clock, and
  // throwing it away restarts the fade, which is what an arrival wants.
  // `colors` is what each thing looks like at full strength, read once from
  // the layer and multiplied by the fade ever since. Throw THAT away while
  // something is faded out and its full strength is recorded as transparent -
  // the fade then multiplies nothing by the curve and it never comes back.
  restart() {this.states=new WeakMap();}
  alpha(key,position,range,viewer,now,visible,fadeMs=LABEL_FADE_MS) {
    let state=this.states.get(key);if(!state){state={visible:false};this.states.set(key,state);}
    const distance=viewer.scene.mode===this.C.SceneMode.SCENE2D?viewer.camera.positionCartographic.height:
      position?this.C.Cartesian3.distance(viewer.camera.positionWC,position):0;
    const inside=visible&&distance>=range.near&&distance<=range.far;
    // The length is fixed when the fade begins; see InfrastructureLabelFade.
    if(inside&&!state.visible){state.start=now;state.duration=fadeMs;this.started++;}
    state.visible=inside;
    return inside?labelFadeAlpha(now-state.start,state.duration)*labelDistanceAlpha(distance,range.near,range.far):0;
  }
  tint(owner,field,alpha,time) {
    const current=read(owner?.[field],time);if(!current||!Number.isFinite(current.alpha))return;
    let fields=this.colors.get(owner);if(!fields){fields=new Map();this.colors.set(owner,fields);}
    let state=fields.get(field);
    if(state&&state.alpha===alpha&&same(current,state.applied))return;
    if(!state||!same(current,state.applied))state={base:this.C.Color.clone(current)};
    const target=this.C.Color.clone(state.base);target.alpha*=alpha;
    if(!same(current,target))owner[field]=target;
    state.applied=target;state.alpha=alpha;fields.set(field,state);
  }
  update(layer,viewer,now,fadeMs=LABEL_FADE_MS,enabled=true,meshes=true) {
    const time=viewer.clock.currentTime;
    for(const e of layer.owned){
      const positions=read(e.polyline?.positions,time);
      const position=read(e.position,time)??positions?.[Math.floor(positions.length/2)];
      for(const g of [e.point,e.polyline,e.cylinder]){
        if(!g)continue;
        const range=read(g.distanceDisplayCondition,time)??{near:0,far:260000};
        const alpha=this.alpha(g,position,range,viewer,now,enabled&&layer.visible&&e.show!==false,fadeMs);
        this.tint(g,'color',alpha,time);this.tint(g,'outlineColor',alpha,time);
        if(g.material?.color)this.tint(g.material,'color',alpha,time);
      }
    }
    if(meshes)this.updateMeshes(layer,viewer,now,fadeMs,enabled);
  }
  updateMeshes(layer,viewer,now,fadeMs=LABEL_FADE_MS,enabled=true) {
    if(!layer?.primitive?.ready)return;
    for(const item of layer.fadeMeshes??[]){
      const attributes=layer.primitive.getGeometryInstanceAttributes(item.id);
      if(!attributes?.color)continue;
      const current=attributes.color;
      if(!item.base || (item.applied&&differs(current,item.applied)))item.base=Uint8Array.from(current);
      const alpha=this.alpha(item,item.position,{near:0,far:260000},viewer,now,enabled&&layer.visible,fadeMs);
      const opacity=Math.round(item.base[3]*alpha);
      if(current[0]!==item.base[0]||current[1]!==item.base[1]||current[2]!==item.base[2]||current[3]!==opacity){
        const next=Uint8Array.from(item.base);next[3]=opacity;
        attributes.color=next;item.applied=next;
      }else if(!item.applied||differs(current,item.applied))item.applied=Uint8Array.from(current);
    }
  }
}
