// Presentation only. One extent drives haze, building clipping and cell requests.
// The saved distance is an upper bound; a close inspection needs a smaller city.
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
export function cameraEnvironment({height=0,range=0,following=false,fog=1,maximum=40000}={}) {
  height=Math.max(0,Number.isFinite(height)?height:0);
  range=Math.max(0,Number.isFinite(range)?range:0);
  fog=clamp(Number.isFinite(fog)?fog:1,0,1.5);
  const close=following?1-clamp((range-1200)/4800,0,1):0;
  const local=clamp(1400+height*2.2,1400,maximum);
  // A close airborne subject needs a local view, even high above the ground.
  const inspection=clamp(650+range*1.6+Math.min(height,range*1.5)*.45,900,maximum);
  const radius=fog>0?Math.min(maximum,local+(Math.min(local,inspection)-local)*close):maximum;
  return {range:radius,focusFraction:.35,following:close>.1,
    density:.0006*fog*(1+close*2.4),visualDensity:.15+close*.4,
    hazeStrength:fog>0?.58+close*.37:0,fogError:4+close*6};
}
export class CameraEnvironment {
  update(options,now) {
    const next=cameraEnvironment(options),dt=clamp(now-(this.at??now),0,500);this.at=now;
    if(!this.value)this.value={...next};
    else for(const key of ['range','density','visualDensity','hazeStrength','fogError']){
      const tau=key==='range'&&next.range>this.value.range?1400:450;
      this.value[key]+=(next[key]-this.value[key])*(1-Math.exp(-dt/tau));
      if(Math.abs(next[key]-this.value[key])<Math.max(1e-8,Math.abs(next[key])*.002))this.value[key]=next[key];
    }
    this.value.following=next.following;this.value.focusFraction=next.focusFraction;
    // Stable bands keep tiny tracking/terrain changes out of the cell selector.
    return {...this.value,range:Math.ceil(this.value.range/100)*100};
  }
}
