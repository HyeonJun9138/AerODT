// Presentation only: work percentages come from LoadingPhases. The finish
// animation catches up to completed work, holds it long enough to be read, then
// hands over to the map (onLeave) and fades away over the map's arrival instead
// of cutting to it.
const COMPLETE_HOLD_MS = 900;
const HAND_OVER_MS = 900;
// Reduced motion keeps a longer, calmer read and a short fade, but still hands
// the arrival to the map rather than cutting to it.
const REDUCED_MOTION_HOLD_MS = 2000;
const REDUCED_MOTION_HAND_OVER_MS = 400;
const bounded=value=>Number.isFinite(value)?Math.max(0,Math.min(100,value)):0;

export class LoadingScreen {
  constructor({root,progress,status,retry,requestFrame=fn=>requestAnimationFrame(fn),
    cancelFrame=id=>cancelAnimationFrame(id),now=()=>performance.now(),isVisible=()=>!document.hidden}) {
    Object.assign(this,{root,progress,status,retry,requestFrame,cancelFrame,now,isVisible});
    this.generation=0;this.frame=null;this.disposed=false;this.shown=0;
    root.dataset.phase='loading';retry.hidden=true;this.paint(0,0);
  }
  paint(shown,actual) {
    if(this.disposed || this.root.dataset.phase!=='loading')return;
    const value=Math.min(bounded(shown),bounded(actual));
    this.draw(value);
  }
  draw(value) {
    this.shown=value;
    // Do not invalidate the clipped text for invisible sub-pixel progress or
    // write its accessible value on every animation frame.
    const painted=Math.floor(value*100)/100;
    if(painted!==this.painted){
      this.progress.style.setProperty('--loading-progress',`${painted}%`);this.painted=painted;
    }
    const readable=String(Math.floor(value));
    if(readable!==this.readable){
      this.progress.setAttribute('aria-valuenow',readable);
      this.progress.setAttribute('data-percent',readable);this.readable=readable;
    }
  }
  setStatus(message) {
    if(!this.disposed && this.root.dataset.phase==='loading' && this.status.textContent!==message)this.status.textContent=message;
  }
  cancel() {
    this.generation++;
    if(this.frame!==null)this.cancelFrame(this.frame);
    this.frame=null;
  }
  finish(percent,message,{reducedMotion=false,onLeave=()=>{}}={}) {
    // Late completion reports must not restart the entry flight or its fade.
    if(this.disposed || this.root.dataset.phase!=='loading')return;
    this.cancel();
    const target=bounded(percent),from=Math.min(this.shown,target);
    const duration=Math.min(700,Math.max(220,(target-from)*7));
    const animate=!reducedMotion && target>from;
    this.draw(animate?from:target);this.root.hidden=false;
    this.status.textContent=message;this.root.setAttribute('aria-busy','false');
    this.root.dataset.phase=animate?'settling':'ready';this.retry.hidden=true;
    const generation=this.generation;
    let handedOver=false;
    const entryFailed=()=>{
      if(this.disposed || generation!==this.generation)return;
      this.fail('지도를 여는 중 문제가 발생했습니다. 다시 시도해 주세요.',this.shown);
    };
    const handOver=()=>{
      if(handedOver)return;handedOver=true;
      try {
        // The map owns its animation. Observe failure without holding the veil
        // over that animation or allowing a rejected entry to become unhandled.
        const entry=onLeave();
        if(entry && typeof entry.then==='function')Promise.resolve(entry).catch(entryFailed);
      } catch {entryFailed();}
    };
    let elapsed=0,last=this.now();
    const tick=timestamp=>{
      if(this.disposed || generation!==this.generation)return;
      const dt=Math.min(50,Math.max(0,timestamp-last));last=timestamp;
      if(this.isVisible()){
        elapsed+=dt;
        if(this.root.dataset.phase==='settling'){
          const t=Math.min(1,elapsed/duration);
          this.draw(from+(target-from)*(1-(1-t)**2));
          if(t===1){this.draw(target);this.root.dataset.phase='ready';elapsed=0;}
        }else if(this.root.dataset.phase==='ready' && elapsed>=(reducedMotion?REDUCED_MOTION_HOLD_MS:COMPLETE_HOLD_MS)){
          // The map starts moving as the veil starts lifting, so it is already
          // arriving by the time it can be seen.
          this.root.dataset.phase='leaving';elapsed=0;handOver();
          if(this.disposed || generation!==this.generation)return;
        }else if(this.root.dataset.phase==='leaving' && elapsed>=(reducedMotion?REDUCED_MOTION_HAND_OVER_MS:HAND_OVER_MS)){
          this.root.hidden=true;this.frame=null;return;
        }
      }
      this.frame=this.requestFrame(tick);
    };
    this.frame=this.requestFrame(tick);
  }
  fail(message,percent) {
    if(this.disposed)return;
    this.cancel();this.root.hidden=false;this.root.dataset.phase='loading';this.paint(percent,percent);
    this.root.dataset.phase='error';this.root.setAttribute('aria-busy','false');
    this.status.textContent=message;this.retry.hidden=false;
  }
  destroy(){this.cancel();this.disposed=true;}
}
