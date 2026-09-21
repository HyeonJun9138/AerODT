// Adaptive terrain detail: uniform quality over peak sharpness.
//
// Cesium draws every tile at whatever level has finished loading, so a view
// whose tiles arrive slower than the camera reveals them is a patchwork of
// sharp and blurred blocks that keeps changing. A high oblique view over an
// aircraft needs hundreds of tiles across many levels; a moving camera renews
// that demand every second. When the load queue stays long, the allowed
// screen-space error rises half a step, which turns the whole view one notch
// coarser at once, uniformly, and lets the queue drain; once it has stayed
// drained for a while, detail returns half a step at a time. High views also
// start from a coarser floor: at that distance a finer level cannot be told
// apart on screen and would only multiply the tiles. Display only.
export class TerrainDetail {
  constructor({base=2,maximum=6,step=.5,backlog=80,drained=12,raiseAfterMs=600,lowerAfterMs=2000}={}) {
    Object.assign(this,{base,maximum,step,backlog,drained,raiseAfterMs,lowerAfterMs});
    this.error=base;this.congestedSince=null;this.idleSince=null;
  }
  // 2 up to 3 km above the ground, one level coarser by 10 km.
  static floor(height,base=2) {
    return base+Math.max(0,Math.min(1,(height-3000)/7000));
  }
  // pending: tiles still to load for the current view; height: view altitude.
  observe(pending,height,now) {
    const floor=TerrainDetail.floor(height,this.base);
    if(pending>this.backlog){
      this.idleSince=null;this.congestedSince ??= now;
      if(now-this.congestedSince>=this.raiseAfterMs && this.error<this.maximum){
        this.error=Math.min(this.maximum,this.error+this.step);this.congestedSince=now;
      }
    } else if(pending<this.drained){
      this.congestedSince=null;this.idleSince ??= now;
      if(now-this.idleSince>=this.lowerAfterMs && this.error>floor){
        this.error=Math.max(floor,this.error-this.step);this.idleSince=now;
      }
    } else {this.congestedSince=null;this.idleSince=null;}
    if(this.error<floor)this.error=floor;
    return this.error;
  }
  get value() {return this.error;}
}
