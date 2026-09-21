import {buildElement} from './dom_builder.js';

// Feedback only. The map keeps rendering and neither input nor replay pauses.
export class DestinationLoading {
  constructor({document=globalThis.document,host=document.body}={}) {
    const el=(tag,props,...children)=>buildElement(document,tag,props,...children);
    this.detail=el('span',{class:'destination-loading-detail'});
    this.root=el('div',{class:'destination-loading','aria-hidden':'true'},
      el('div',{class:'destination-loading-card',role:'status','aria-live':'polite'},
        el('i',{class:'destination-loading-spinner','aria-hidden':'true'}),
        el('div',{},el('strong',{text:'주변 기체 준비 중'}),this.detail)));
    host.append(this.root);
  }
  update({phase,ready=0,total=0}) {
    const active=phase==='preparing';
    this.root.setAttribute('data-active',String(active));
    this.root.setAttribute('aria-hidden',String(!active));
    const text=total?`3D 모델 ${ready} / ${total} · 간단 표시로도 조작할 수 있습니다`:'주변 기체 확인 중';
    if(active&&this.detail.textContent!==text)this.detail.textContent=text;
  }
  destroy(){this.root.remove();}
}
