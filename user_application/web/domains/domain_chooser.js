import {DOMAINS} from './domain_catalog.js';

// Explicit choice on every page load; no persisted choice silently starts UAM.
export class DomainChooser {
  constructor({root,onSelect,onAfterClose=()=>{},onFailure=()=>{},transitionMs=420,
    reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches??false,
    setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}){
    Object.assign(this,{root,onSelect,onAfterClose,onFailure,transitionMs,reducedMotion,setTimer,clearTimer});
    this.busy=false;this.disposed=false;this.timer=null;this.finishLeave=null;
    this.buttons=[...root.querySelectorAll('[data-domain-choice]')];
    this.cancel=e=>e.preventDefault();
    this.key=e=>{e.stopPropagation();if(e.key==='Escape')e.preventDefault();};
    this.click=e=>void this.choose(e.currentTarget.dataset.domainChoice);
    root.addEventListener('cancel',this.cancel);root.addEventListener('keydown',this.key);
    for(const button of this.buttons)button.addEventListener('click',this.click);
  }
  show(){if(this.disposed)return;this.root.dataset.phase='ready';this.root.showModal();this.buttons[0]?.focus();}
  leave(){
    this.root.dataset.phase='leaving';
    if(this.reducedMotion||this.transitionMs<=0)return Promise.resolve(true);
    return new Promise(resolve=>{
      this.finishLeave=resolve;
      this.timer=this.setTimer(()=>{this.timer=null;this.finishLeave=null;resolve(true);},this.transitionMs);
    });
  }
  cancelLeave(result=false){
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;
    const finish=this.finishLeave;this.finishLeave=null;finish?.(result);
  }
  async choose(id){
    if(this.busy||this.disposed||!DOMAINS[id])return false;
    this.busy=true;for(const button of this.buttons)button.disabled=true;
    const status=this.root.querySelector('[data-domain-status]');
    status.textContent=`${DOMAINS[id].label} 화면 준비 중…`;
    try{
      await this.onSelect(id);
      if(!await this.leave()||this.disposed)return false;
      this.root.close();this.root.dataset.phase='closed';this.onAfterClose(id);return true;
    }
    catch(error){this.root.dataset.phase='ready';this.onFailure(id,error);status.textContent=`진입하지 못했습니다. 다시 선택해 주세요. ${error.message}`;return false;}
    finally{this.busy=false;for(const button of this.buttons)button.disabled=false;}
  }
  destroy(){this.disposed=true;this.cancelLeave(false);if(this.root.open)this.root.close();this.root.removeEventListener('cancel',this.cancel);this.root.removeEventListener('keydown',this.key);for(const b of this.buttons)b.removeEventListener('click',this.click);}
}
