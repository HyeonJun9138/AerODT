// Browser-only introduction. The native dialog owns input isolation; live data
// and the globe keep running underneath. No simulation state is changed here.
export class WelcomeScreen {
  constructor({root,button,document=globalThis.document,scope=globalThis,
    setTimer=setTimeout,clearTimer=clearTimeout}) {
    Object.assign(this,{root,button,document,scope});
    // Window timers reject a class instance as their receiver in browsers.
    this.setTimer=(...args)=>setTimer(...args);
    this.clearTimer=(...args)=>clearTimer(...args);
    this.started=false;this.disposed=false;this.timer=null;this.resizeTimer=null;
    this.start=()=>this.dismiss();
    this.cancel=event=>event.preventDefault();
    // Keep document-level shortcuts from operating the scene behind the modal.
    this.keydown=event=>{event.stopPropagation();if(event.key==='Escape')event.preventDefault();};
    this.resize=()=>{
      if(!this.root.open || this.disposed)return;
      this.positionHints();this.clearTimer(this.resizeTimer);
      // The layer chips have a 220ms responsive left-position transition.
      // Re-measure its settled edge too, without a continuous animation loop.
      this.resizeTimer=this.setTimer(()=>{
        this.resizeTimer=null;if(this.root.open && !this.disposed)this.positionHints();
      },260);
    };
    button.addEventListener('click',this.start);
    root.addEventListener('cancel',this.cancel);
    root.addEventListener('keydown',this.keydown);
    scope.addEventListener('resize',this.resize);
  }
  async afterEntry(entry,{reducedMotion=false}={}) {
    await entry;
    if(this.started || this.disposed)return;
    this.started=true;this.reducedMotion=reducedMotion;
    this.root.dataset.phase='preparing';this.button.disabled=true;
    this.root.showModal();this.positionHints();
    const ready=()=>{
      this.timer=null;if(this.disposed || !this.root.open)return;
      this.root.dataset.phase='ready';this.button.disabled=false;
      this.button.focus({preventScroll:true});
    };
    // A brief still view between camera arrival and the softly arriving guide.
    // The modal is already active, so clicks cannot interrupt this hand-over.
    if(reducedMotion)ready();else this.timer=this.setTimer(ready,650);
  }
  positionHints() {
    for(const hint of this.root.querySelectorAll('[data-welcome-target]')) {
      const target=this.document.getElementById(hint.dataset.welcomeTarget);
      if(!target)continue;
      const rect=target.getBoundingClientRect();
      hint.style.setProperty('--target-left',`${rect.left}px`);
      hint.style.setProperty('--target-top',`${rect.top}px`);
      hint.style.setProperty('--target-width',`${rect.width}px`);
      hint.style.setProperty('--target-height',`${rect.height}px`);
    }
  }
  dismiss() {
    if(this.disposed || this.root.dataset.phase!=='ready')return;
    this.root.dataset.phase='leaving';this.button.disabled=true;
    const close=()=>{this.timer=null;if(this.disposed)return;this.root.close();this.root.dataset.phase='closed';};
    if(this.reducedMotion)close();else this.timer=this.setTimer(close,450);
  }
  destroy() {
    this.disposed=true;this.clearTimer(this.timer);this.clearTimer(this.resizeTimer);this.timer=null;this.resizeTimer=null;
    if(this.root.open)this.root.close();
    this.button.removeEventListener('click',this.start);
    this.root.removeEventListener('cancel',this.cancel);
    this.root.removeEventListener('keydown',this.keydown);
    this.scope.removeEventListener('resize',this.resize);
  }
}
