// Local camera input only: independent of simulation time and playback speed.
const KEYS=new Set(['KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE','KeyZ','KeyX']);
const editable=element=>Boolean(element?.closest?.('input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"]'));
export class KeyboardNavigation {
  constructor({enabled,height,move,document=globalThis.document,window=globalThis.window,now=()=>performance.now()}) {
    Object.assign(this,{enabled,height,move,document,window,now});this.keys=new Set();this.reset();
    this.down=event=>{
      if(event.ctrlKey||event.altKey||event.metaKey||event.isComposing){this.reset();return;}
      if(!KEYS.has(event.code))return;
      if(!this.allowed(event.target)){this.reset();return;}
      event.preventDefault();if(!this.keys.size)this.stamp=this.now();this.keys.add(event.code);
    };
    this.up=event=>{this.keys.delete(event.code);if(!this.keys.size)this.reset();};
    this.blur=()=>this.reset();this.focus=()=>{if(!this.allowed())this.reset();};
    document.addEventListener('keydown',this.down);document.addEventListener('keyup',this.up);
    document.addEventListener('focusin',this.focus);document.addEventListener('visibilitychange',this.blur);
    window.addEventListener('blur',this.blur);
  }
  allowed(target=this.document.activeElement) {
    return !this.document.hidden && this.enabled() && !editable(target) && !editable(this.document.activeElement) &&
      !this.document.querySelector('dialog[open],[aria-modal="true"]:not([hidden])');
  }
  reset(){this.keys.clear();this.stamp=null;this.gain=0;}
  update(now=this.now()) {
    if(!this.keys.size)return;
    if(!this.allowed()){this.reset();return;}
    const dt=Math.max(0,Math.min(.05,(now-this.stamp)/1000));this.stamp=now;if(!dt)return;
    this.gain+= (1-this.gain)*-Math.expm1(-dt/.1);
    const axis=(positive,negative)=>Number(this.keys.has(positive))-Number(this.keys.has(negative));
    const forward=axis('KeyW','KeyS'),right=axis('KeyD','KeyA'),up=axis('KeyZ','KeyX'),yaw=axis('KeyE','KeyQ');
    const speed=Math.max(5,Math.min(150000,(this.height()||0)*.4));
    const step=speed*dt*this.gain/Math.max(1,Math.hypot(forward,right,up));
    if(forward||right||up||yaw)this.move({forward:forward*step,right:right*step,up:up*step,yaw:yaw*.8*dt*this.gain});
  }
  destroy(){
    this.reset();this.document.removeEventListener('keydown',this.down);this.document.removeEventListener('keyup',this.up);
    this.document.removeEventListener('focusin',this.focus);this.document.removeEventListener('visibilitychange',this.blur);
    this.window.removeEventListener('blur',this.blur);
  }
}
