import {buildElement} from '../../../dom_builder.js';

export const UAM_DISPLAY_DEFAULTS=Object.freeze({all:true,ports:true,routes:true,labels:true,portLabels:true,routeLabels:true,status:true,aircraft:true,paths:true,passengers:true,lights:true});
export const UAM_DISPLAY_ITEMS=[['ports','버티포트 시설'],['routes','항로 · 경유점'],['labels','UAM 이름'],
  ['status','UAM 운항 상태'],['portLabels','버티포트 이름'],['routeLabels','항로 · 경유점 이름 / 고도'],['aircraft','계획 비행체'],['paths','비행 경로 · 수직선'],['passengers','탑승 · 하차 승객'],['lights','버티포트 조명']];
const STORAGE_KEY='aerodt.uam-display.v1';
export function readUamDisplay(storage,defaults=UAM_DISPLAY_DEFAULTS,storageKey=STORAGE_KEY) {
  let saved;try{saved=JSON.parse(storage?.getItem(storageKey) ?? '{}');}catch{}
  // Preserve the old combined label choice when upgrading saved UAM settings.
  if(storageKey===STORAGE_KEY && typeof saved?.labels==='boolean'){
    saved={...saved};
    for(const key of ['portLabels','routeLabels'])if(typeof saved[key]!=='boolean')saved[key]=saved.labels;
  }
  return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof saved?.[key]==='boolean'?saved[key]:value]));
}

export class UamDisplayMenu {
  constructor({button,mount,document=globalThis.document,storage,onChange=()=>{},onOpen=()=>{},
    id='uam',title='UAM',defaults=UAM_DISPLAY_DEFAULTS,items=UAM_DISPLAY_ITEMS,
    note='표시만 변경합니다. 비행 재생은 계속됩니다.'}) {
    const storageKey=id==='uam'?STORAGE_KEY:`aerodt.${id}-display.v1`;
    Object.assign(this,{button,mount,document,storage,onChange,onOpen,defaults,storageKey});this.state=readUamDisplay(storage,defaults,storageKey);
    const el=(tag,props,...children)=>buildElement(document,tag,props,...children);
    this.root=el('section',{id:`${id}-display-menu`,class:'uam-display-menu',role:'region','aria-label':`${title} 시각화 설정`,hidden:''});
    this.master=el('button',{type:'button',class:'uam-master',onclick:()=>this.set('all',!this.state.all)});
    this.root.append(el('header',{},el('div',{},el('strong',{text:title}),el('span',{text:'시각화 레이어'})),this.master));
    this.count=el('div',{class:'display-menu-count',text:'수신 대기'});this.root.append(this.count);
    this.rows=new Map();
    for(const [key,label] of items) {
      const input=el('button',{type:'button',role:'switch','aria-label':label,class:'uam-display-row',onclick:()=>this.set(key,!this.state[key])},
        el('span',{text:label}),el('i',{'aria-hidden':'true'}));
      this.rows.set(key,input);this.root.append(input);
    }
    this.root.append(el('p',{text:note}));mount.append(this.root);
    button.removeAttribute('aria-pressed');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',`${id}-display-menu`);
    button.setAttribute('aria-label',`${title} 시각화 설정`);button.removeAttribute('title');
    button.onclick=()=>this.open(!this.isOpen);
    this.outside=e=>{if(this.isOpen&&!this.root.contains(e.target)&&!button.contains(e.target))this.open(false);};
    this.escape=e=>{if(this.isOpen&&e.key==='Escape'){e.stopPropagation();this.open(false);button.focus();}};
    document.addEventListener('pointerdown',this.outside);document.addEventListener('keydown',this.escape,true);
    this.render();
  }
  open(value){this.isOpen=value;this.root.hidden=!value;this.button.setAttribute('aria-expanded',String(value));if(value)this.onOpen(this);}
  setCount(text){if(this.count.textContent!==text)this.count.textContent=text;}
  set(key,value){
    if(!Object.hasOwn(this.defaults,key))return;
    this.state={...this.state,[key]:Boolean(value)};
    try{this.storage?.setItem(this.storageKey,JSON.stringify(this.state));}catch{}
    this.render();this.onChange({...this.state});
  }
  render(){
    this.master.textContent=this.state.all?'전체 끄기':'전체 켜기';
    this.button.dataset.off=String(!this.state.all);
    for(const [key,row] of this.rows){row.setAttribute('aria-checked',String(this.state[key]));row.disabled=!this.state.all;}
  }
  destroy(){this.document.removeEventListener('pointerdown',this.outside);this.document.removeEventListener('keydown',this.escape,true);this.button.onclick=null;this.root.remove();}
}
