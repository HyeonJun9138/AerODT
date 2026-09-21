// Small bounded render-time diagnostic; not simulation or authoritative time.
export class FrameTiming {
  constructor() {this.intervals=new Float64Array(120);this.count=0;this.cursor=0;this.previous=null;this.summaryAt=-Infinity;}
  record(now) {
    const delta=this.previous===null?0:now-this.previous;
    if(delta>0&&delta<200)this.recentMs=this.recentMs===undefined?delta:this.recentMs*.75+delta*.25;
    if(this.previous!==null){this.intervals[this.cursor]=Math.max(0,now-this.previous);this.cursor=(this.cursor+1)%120;this.count=Math.min(120,this.count+1);}
    this.previous=now;
  }
  summary() {
    // Consumers include the HUD and the per-frame resolution budget. Sorting
    // the same ring 60+ times a second is unnecessary for a slow LOD policy.
    if(this.cached&&this.previous-this.summaryAt<200)return this.cached;
    if(!this.count)return {fps:0,frameMs:0,p50Ms:0,p95Ms:0,samples:0};
    const values=Array.from(this.intervals.subarray(0,this.count)).sort((a,b)=>a-b);
    const frameMs=values.reduce((sum,value)=>sum+value,0)/this.count;
    this.summaryAt=this.previous;
    return this.cached={fps:frameMs?1000/frameMs:0,frameMs,p50Ms:values[Math.floor(this.count*.5)],
      // p75 is what the display grader reads; it is the same ring, not a second
      // measurement, so a consumer never sees two disagreeing views of a frame.
      p75Ms:values[Math.min(this.count-1,Math.floor(this.count*.75))],
      p95Ms:values[Math.ceil(this.count*.95)-1],samples:this.count};
  }
}
