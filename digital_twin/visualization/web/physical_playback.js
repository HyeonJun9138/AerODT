// Timing only. Interpolate accepted observations; never invent future positions.
export class PhysicalPlayback {
  constructor(t,now,clock){this.reset(t,now,clock);}
  reset(t,now,clock){this.arrivals=[{t,now}];this.t=t;this.at=now;this.rate=1;this.speed=0;this.clock=clock;this.last=now;this.started=now;this.bufferSeconds=.45;}
  observe(t,now){
    const last=this.arrivals.at(-1);if(t<=last.t)return;
    this.arrivals.push({t,now});if(this.arrivals.length>24)this.arrivals.shift();
    const first=this.arrivals[0],span=(now-first.now)/1000;
    if(span>.2 && this.clock==='physical'){
      const measured=Math.max(.02,Math.min(2,(t-first.t)/span));
      this.rate=this.arrivals.length===2?measured:this.rate+.15*(measured-this.rate);
    }
    const gaps=this.arrivals.slice(1).map((p,i)=>(p.now-this.arrivals[i].now)/1000).sort((a,b)=>a-b);
    // Cover ordinary arrival jitter. This is a target reserve, not a promise
    // about end-to-end delay: source age and transport remain visible separately.
    const desired=Math.max(.45,Math.min(2,gaps[Math.floor((gaps.length-1)*.9)]+.15));
    this.bufferSeconds+=.2*(desired-this.bufferSeconds);this.last=now;
  }
  advance(now,newest,oldest){
    const dt=Math.max(0,Math.min(.1,(now-this.at)/1000));this.at=now;
    if(now-this.started<450 || this.arrivals.length<2)return this.t;
    const reserve=this.bufferSeconds*this.rate,available=Math.max(0,newest-this.t);
    const desired=this.rate*Math.min(1.3,Math.sqrt(available/Math.max(.02,reserve)));
    this.speed+=(1-Math.exp(-dt/.4))*(desired-this.speed);
    this.t=Math.max(oldest,Math.min(newest,this.t+dt*this.speed));return this.t;
  }
}
