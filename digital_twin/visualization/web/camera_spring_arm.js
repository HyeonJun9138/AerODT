// Display-only critically damped anchor. Positions are ECEF metres; time is
// monotonic wall milliseconds, never the accelerated simulation clock.
export class CameraSpringArm {
  constructor(){this.position={x:0,y:0,z:0};this.previous={x:0,y:0,z:0};this.velocity={x:0,y:0,z:0};this.reset();}
  reset(){this.at=null;this.key=null;}
  update(target,now,key,maxLag=Infinity){
    if(this.at===null||this.key!==key||now<this.at||now-this.at>1000){
      Object.assign(this.position,target);Object.assign(this.previous,target);
      this.velocity.x=this.velocity.y=this.velocity.z=0;this.at=now;this.key=key;return this.position;
    }
    const dt=(now-this.at)/1000;if(dt<=0)return this.position;
    // Exact critically damped solution for a linearly moving target, avoiding
    // frame-rate-dependent Euler integration. ~0.16 s steady cruising lag.
    const omega=12.5,decay=Math.exp(-omega*dt);
    for(const axis of ['x','y','z']){
      const speed=(target[axis]-this.previous[axis])/dt;
      const error=this.position[axis]-this.previous[axis]+2*speed/omega;
      const relative=this.velocity[axis]-speed,term=relative+omega*error;
      this.position[axis]=target[axis]-2*speed/omega+(error+term*dt)*decay;
      this.velocity[axis]=speed+(relative-omega*term*dt)*decay;
      this.previous[axis]=target[axis];
    }
    const dx=this.position.x-target.x,dy=this.position.y-target.y,dz=this.position.z-target.z;
    const distance=Math.hypot(dx,dy,dz);
    // Keep high-speed satellites/accelerated aircraft inside their close-up.
    if(distance>maxLag){const scale=maxLag/distance;
      this.position.x=target.x+dx*scale;this.position.y=target.y+dy*scale;this.position.z=target.z+dz*scale;
      this.velocity.x*=scale;this.velocity.y*=scale;this.velocity.z*=scale;
    }
    this.at=now;return this.position;
  }
}
