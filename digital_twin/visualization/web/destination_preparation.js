// A bounded rendering preference, not another copy of aircraft state.
// The latest EntityScene positions are queried again as snapshots arrive.
export class DestinationPreparation {
  constructor(scene,{onStatus=()=>{},now=()=>performance.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}={}) {
    Object.assign(this,{scene,onStatus,now,setTimer,clearTimer});this.serial=0;this.active=null;
  }
  start(centre) {
    this.cancel();
    const token=++this.serial;
    this.active={token,centre,arrivedAt:null,lastScan:-Infinity};
    // Also bound a camera animation whose completion callback never arrives.
    this.timer=this.setTimer(()=>this.finish('timeout',token),8000);
    this.update(true);return token;
  }
  arrive(token) {
    if(this.active?.token!==token)return;
    this.active.arrivedAt=this.now();this.clearTimer(this.timer);
    this.timer=this.setTimer(()=>this.finish('timeout',token),5000);
    this.update(true);
  }
  cancel() {if(this.active)this.finish('cancelled',this.active.token);}
  finish(phase,token) {
    if(this.active?.token!==token)return;
    this.clearTimer(this.timer);this.timer=null;this.active=null;
    this.scene.destinationItems=new Set();this.scene.needsLod=true;
    this.onStatus({phase});
  }
  update(force=false) {
    const state=this.active;if(!state)return;
    const now=this.now();if(!force&&now-state.lastScan<120)return;
    state.lastScan=now;
    const nearby=[];
    for(const item of this.scene.items.values()) {
      const layer=this.scene.layers[item.entity.kind];
      if(!['uam','aircraft'].includes(item.entity.kind)||!layer?.visible||layer.showModels===false||
         !this.scene.assets.has(item.assetId)||item.failed||!item.position)continue;
      const p=item.position,c=state.centre,distance=Math.hypot(p.x-c.x,p.y-c.y,p.z-c.z);
      if(distance<=1500)nearby.push({item,distance});
    }
    nearby.sort((a,b)=>a.distance-b.distance);
    const items=nearby.slice(0,Math.min(8,this.scene.performance.maxModels)).map(row=>row.item);
    this.scene.destinationItems=new Set(items);
    let ready=0;
    for(const item of items) {
      item.lastModelUse=now;
      if(item.model?.ready!==false&&item.model&&item.modelTexturesReady!==false)ready++;
      else if(!item.model)void this.scene.loadModel(item,'destination');
    }
    const arrived=state.arrivedAt!==null;
    if(arrived&&ready===items.length&&(items.length>0||now-state.arrivedAt>=600)) {
      this.finish('ready',state.token);return;
    }
    this.onStatus({phase:arrived?'preparing':'moving',ready,total:items.length});
  }
}
