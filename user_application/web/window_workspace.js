import {boundsFor,clampRect,snapRect,snapTarget,resizeRect,readLayouts,placeRect,LAYOUT_KEY,SNAP_LABELS} from './window_layout.js';
import {buildElement} from './dom_builder.js';
export const WINDOW_TYPES=[
 ['drawer','#drawer','작업 패널',390,620],['selection','#selection','기체 정보',370,580],
 ['prediction','.prediction-workspace','Prediction',650,570],['analysis','.oa-window','운항 분석',680,570],
 ['pilot','.pilot-console','조종사',540,540],['vertiport','.vp-console','버티포트 운영',610,560],
 ['psu','.psu-control','PSU',640,550],['risk','.risk-radar','주변 교통 레이더',420,450],
 ['decision','.dc-window','의사결정',620,560],['deck','.deck-detail','버티포트 상세',490,500],
 ['port-info','.vp-selection-info','버티포트 정보',380,470],['demand','#demand-summary','비행 생성 요약',500,480],
 ['settings','#settings-panel','설정',350,500],['ai-library','.ai-library','AI 모델',460,480]
];
// Only presentation dismiss controls belong here; scenario/flight stop is not a window close.
const CLOSE_CONTROLS={drawer:'#drawer-close',selection:'button[aria-label="정보 창 숨기기"]',prediction:'.pred-close',analysis:'.oa-close',pilot:'button[aria-label="조종사 컨트롤 닫기"]',vertiport:'.vp-close',psu:'button[aria-label="PSU 컨트롤 닫기"]',risk:'button[aria-label="레이더 접기"]',decision:'button[aria-label="의사결정 로직 닫기"]',deck:'button[aria-label="버티포트 상세 닫기"]','port-info':'button[aria-label="버티포트 정보 닫기"]',demand:'.place-close',settings:'button[aria-label="설정 닫기"]','ai-library':'.place-close'};
// Wrap existing presentation roots; never clone a panel or alter its state/feed.
export class WindowWorkspace {
 constructor({document=globalThis.document,window=globalThis.window,storage,notify=()=>{}}={}){
  Object.assign(this,{document,window,notify});try{this.storage=storage??window.localStorage;}catch{}
  this.layouts=readLayouts(this.storage);this.entries=new Map();this.order=[];this.serials=new Map();this.nodes=new WeakMap();
 }
 el(tag,props,...children){return buildElement(this.document,tag,props,...children);}
 layoutPicture(key){
  const picture=this.el('span',{class:'ww-layout-picture','aria-hidden':'true'});
  const fill=this.el('span',{class:'ww-layout-fill'}),a=this.area();
  const r=key==='free'?{x:a.x+a.width*.24,y:a.y+a.height*.22,width:a.width*.48,height:a.height*.56}:snapRect(key,a);
  Object.assign(fill.style,{left:100*(r.x-a.x)/a.width+'%',top:100*(r.y-a.y)/a.height+'%',width:100*r.width/a.width+'%',height:100*r.height/a.height+'%'});
  picture.append(fill);return picture;
 }
 area(){return boundsFor(this.window.innerWidth,this.window.innerHeight,this.document.getElementById('rail')?.getBoundingClientRect().width??76);}
 start(){
  this.document.body.dataset.workspace='ready';
  this.shelf=this.el('nav',{class:'ww-shelf','aria-label':'열린 창과 배치'});
  this.tabs=this.el('div',{class:'ww-tabs'});
  this.shelf.append(this.el('span',{class:'ww-label',text:'작업창'}),this.tabs,
   this.el('button',{type:'button',text:'정돈',title:'열린 창을 겹침이 적은 자리로 배치',onclick:()=>this.arrange()}),
   this.el('button',{type:'button',text:'배치 초기화',onclick:()=>this.reset()}));
  this.preview=this.el('div',{class:'ww-preview',hidden:'','aria-hidden':'true'});this.previewLabel=this.el('span');this.preview.append(this.previewLabel);
  this.document.body.append(this.shelf,this.preview);
  this.scan();this.observer=new this.window.MutationObserver(records=>{
   if(records.some(r=>r.type==='attributes'||[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1)))this.schedule();
  });
  this.observer.observe(this.document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','aria-hidden','data-open','data-drawer','data-state']});
  this.bodyObserver=new this.window.MutationObserver(()=>this.schedule());this.bodyObserver.observe(this.document.body,{attributes:true,attributeFilter:['class','data-focus']});
  this.resized=()=>{for(const e of this.entries.values()){e.rect=e.snap?snapRect(e.snap,this.area()):clampRect(e.rect,this.area());this.paint(e);}this.save();};
  this.window.addEventListener('resize',this.resized);
  this.keys=event=>{if(event.key==='Escape'&&event.target.closest?.('.ww-titlebar')){event.preventDefault();event.stopImmediatePropagation();const e=[...this.entries.values()].find(e=>e.shell.contains(event.target));if(e){if(e.menu.open)e.menu.open=false;else this.minimize(e);}}};
  this.document.addEventListener('keydown',this.keys,true);
  return this;
 }
 schedule(){if(this.frame||this.disposed)return;this.frame=this.window.requestAnimationFrame(()=>{this.frame=null;this.scan();});}
 visible(e){const n=e.node;if(n.dataset?.workspaceSource==='true')return false;if(n.hidden||n.inert||n.getAttribute('aria-hidden')==='true')return false;
  if(!e.independent&&e.kind==='drawer')return this.document.body.dataset.drawer==='open';
  if(!e.independent&&e.kind==='selection')return n.dataset.open==='true';
  return this.window.getComputedStyle(n).display!=='none';
 }
 scan(){
  for(const e of [...this.entries.values()])if(!e.node.isConnected||e.node.parentElement!==e.content)this.detach(e);
  for(const spec of WINDOW_TYPES)for(const node of this.document.querySelectorAll(spec[1]))if(!this.nodes?.has(node))this.attach(node,spec);
  for(const e of this.entries.values()){
   const open=this.visible(e);if(open&&!e.open){e.minimized=false;this.raise(e);}e.open=open;
   const title=!e.independent&&e.kind==='drawer'?this.document.getElementById('drawer-title')?.textContent:null;
   if(title&&e.title.textContent!==title){e.title.textContent=title;e.tab.textContent=title;}
   const hidden=!open||e.minimized;if(e.shell.hidden!==hidden)e.shell.hidden=hidden;
   if(e.tab.hidden!==!open)e.tab.hidden=!open;e.tab.setAttribute('aria-pressed',String(open&&!e.minimized));
  }
 }
 manage(node,{kind='panel',label,width,height,onClose,onActivate}={}){
  const existing=this.nodes.get(node);if(existing){existing.independent=true;if(onClose)existing.onClose=onClose;if(onActivate)existing.onActivate=onActivate;return existing;}
  const spec=WINDOW_TYPES.find(row=>row[0]===kind);
  if(!node.isConnected)this.document.body.append(node);
  const e=this.attach(node,[kind,null,label??spec?.[2]??'작업창',width??spec?.[3]??480,height??spec?.[4]??500],{independent:true,onClose,onActivate});
  e.open=this.visible(e);e.tab.hidden=!e.open;this.paint(e);if(e.open)this.raise(e);return e;
 }
 create(options={}){const node=this.el('div',{class:'ww-panel'});const entry=this.manage(node,options);return {node,entry};}
 reveal(node){const e=this.nodes.get(node);if(!e)return;e.minimized=false;e.open=true;this.paint(e);this.raise(e);this.save();}
 release(node){const e=this.nodes.get(node);if(e)this.detach(e);}
 attach(node,[kind,selector,label,width,height],options={}){
  const serial=(this.serials.get(kind)??0)+1;this.serials.set(kind,serial);const id=serial===1?kind:kind+'-'+serial;
  const a=this.area(),saved=this.layouts[id],rect=saved?(saved.snap?snapRect(saved.snap,a):clampRect(saved,a)):placeRect({width,height},a,[...this.entries.values()].filter(e=>e.open&&!e.minimized).map(e=>e.rect));
  const e={id,kind,node,rect,width,height,...options,snap:saved?.snap??null,open:false,minimized:false,originalParent:node.parentNode,originalNext:node.nextSibling,modal:node.getAttribute('aria-modal')};
  e.shell=this.el('section',{class:'ww-shell','data-window':id,'data-window-kind':kind,'aria-label':label+' 창'});
  e.header=this.el('header',{class:'ww-titlebar'});e.title=this.el('span',{class:'ww-title',text:label,tabindex:'0',role:'button','aria-label':label+' 창 이동','aria-description':'드래그 또는 방향키로 이동, Shift로 크게 이동'});
  e.menu=this.el('details',{class:'ww-placement'});e.menu.append(this.el('summary',{'aria-label':label+' 창 배치',title:'창 배치'},this.layoutPicture('left')));
  const choices=this.el('div',{class:'ww-choices'});
  for(const [key,text] of Object.entries(SNAP_LABELS))choices.append(this.el('button',{type:'button','aria-label':text,title:text,onclick:()=>{this.snap(e,key);e.menu.open=false;}},this.layoutPicture(key),this.el('span',{text})));
  choices.append(this.el('button',{type:'button','aria-label':'자유 배치',title:'자유 배치',onclick:()=>{e.snap=null;e.menu.open=false;this.save();}},this.layoutPicture('free'),this.el('span',{text:'자유 배치'})));e.menu.append(choices);
  e.header.append(e.title,e.menu,this.el('button',{type:'button',class:'ww-control ww-minimize',text:'−','aria-label':label+' 창 최소화',title:'최소화',onclick:()=>this.minimize(e)}),this.el('button',{type:'button',class:'ww-control ww-close',text:'×','aria-label':label+' 창 닫기',title:'닫기',onclick:()=>this.close(e)}));
  e.content=this.el('div',{class:'ww-content'});node.before(e.shell);e.shell.append(e.header,e.content);e.content.append(node);node.classList.add('ww-managed');if(e.modal==='true')node.setAttribute('aria-modal','false');
  e.tab=this.el('button',{type:'button',text:label,'aria-label':label+' 창 보기',onclick:()=>{e.minimized=false;this.paint(e);this.raise(e);this.save();e.title.focus();}});this.tabs.append(e.tab);
  e.header.onpointerdown=event=>{if(event.button===0&&!event.target.closest('button,summary,details'))this.begin(e,event);};
  e.title.onkeydown=event=>{const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!d)return;event.preventDefault();e.snap=null;const step=event.shiftKey?32:8;e.rect=clampRect({...e.rect,x:e.rect.x+d[0]*step,y:e.rect.y+d[1]*step},this.area());this.paint(e);this.save();};
  e.shell.addEventListener('pointerdown',()=>this.raise(e),true);
  for(const edge of ['n','s','e','w','ne','nw','se','sw']){const grip=this.el('div',{class:'ww-grip ww-'+edge,'aria-hidden':edge==='se'?null:'true',...(edge==='se'?{tabindex:'0',role:'button','aria-label':label+' 창 크기 조절','aria-description':'방향키로 너비와 높이 조절'}:{})});
   grip.onpointerdown=event=>{if(event.button===0)this.begin(e,event,edge);};
   grip.onkeydown=event=>{const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!d)return;event.preventDefault();e.snap=null;e.rect=resizeRect(e.rect,'se',d[0]*(event.shiftKey?32:8),d[1]*(event.shiftKey?32:8),this.area());this.paint(e);this.save();};e.shell.append(grip);
  }
  this.entries.set(id,e);this.nodes.set(node,e);this.paint(e);return e;
 }
 paint(e){Object.assign(e.shell.style,{left:e.rect.x+'px',top:e.rect.y+'px',width:e.rect.width+'px',height:e.rect.height+'px'});e.shell.dataset.snap=e.snap??'';e.shell.hidden=!e.open||e.minimized;e.tab?.setAttribute('aria-pressed',String(e.open&&!e.minimized));}
 raise(e){this.order=this.order.filter(x=>x!==e.id);this.order.push(e.id);this.order.forEach((id,i)=>{const row=this.entries.get(id);if(row){row.shell.style.zIndex=String(10+i);row.shell.dataset.active=String(row===e);}});e.onActivate?.(e);}
 close(e){if(e.closing||!this.entries.has(e.id))return;e.closing=true;
  try{if(e.onClose)e.onClose(e);else{const selector=CLOSE_CONTROLS[e.kind],button=selector?e.node.querySelector(selector):null;if(button)button.click();else e.node.hidden=true;}
   if(e.independent&&e.node.isConnected)e.node.hidden=true;e.open=false;e.menu.open=false;this.paint(e);e.tab.hidden=true;
   if(!e.node.isConnected)this.detach(e);
  }finally{e.closing=false;}
 }
 minimize(e){e.minimized=true;e.menu.open=false;this.paint(e);this.save();e.tab.focus();}
 snap(e,key){e.snap=key;e.rect=snapRect(key,this.area());this.paint(e);this.raise(e);this.save();}
 begin(e,event,edge=null){
  event.preventDefault();event.stopPropagation();this.cancelDrag?.();this.raise(e);const original={...e.rect},oldSnap=e.snap,start={x:event.clientX,y:event.clientY};let target=null,moved=false;
  const handle=event.currentTarget;handle.setPointerCapture?.(event.pointerId);this.document.body.classList.add('ww-dragging');
  const move=ev=>{if(ev.pointerId!==event.pointerId)return;const dx=ev.clientX-start.x,dy=ev.clientY-start.y;if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;e.snap=null;
   e.rect=edge?resizeRect(original,edge,dx,dy,this.area()):clampRect({...original,x:original.x+dx,y:original.y+dy},this.area());this.paint(e);
   target=edge?null:snapTarget({x:ev.clientX,y:ev.clientY},this.area());this.preview.hidden=!target;
   if(target){const r=snapRect(target,this.area());Object.assign(this.preview.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});this.previewLabel.textContent=SNAP_LABELS[target];}
  };
  const finish=cancel=>{try{handle.releasePointerCapture?.(event.pointerId);}catch{}handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',abort);this.preview.hidden=true;this.document.body.classList.remove('ww-dragging');this.cancelDrag=null;
   if(cancel){e.rect=original;e.snap=oldSnap;this.paint(e);}else if(target)this.snap(e,target);else this.save();};
  const up=()=>finish(false),abort=()=>finish(true);this.cancelDrag=abort;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',abort);
 }
 save(){for(const e of this.entries.values())this.layouts[e.id]={...e.rect,snap:e.snap,minimized:e.minimized};try{this.storage?.setItem(LAYOUT_KEY,JSON.stringify({version:1,windows:this.layouts}));}catch{if(!this.storageWarned){this.storageWarned=true;this.notify('창 배치를 저장할 수 없습니다. 현재 화면에서는 계속 사용할 수 있습니다.');}}}
 arrange(){const occupied=[];for(const e of this.entries.values()){if(!e.open||e.minimized)continue;e.snap=null;e.rect=placeRect(e.rect,this.area(),occupied);occupied.push(e.rect);this.paint(e);}this.save();}
 reset(){this.layouts={};const occupied=[];for(const e of this.entries.values()){e.snap=null;e.rect=placeRect({width:e.width,height:e.height},this.area(),occupied);if(e.open&&!e.minimized)occupied.push(e.rect);this.paint(e);}this.save();}
 detach(e){this.entries.delete(e.id);this.nodes.delete(e.node);this.order=this.order.filter(id=>id!==e.id);e.shell.remove();e.tab.remove();}
 destroy(){this.disposed=true;this.cancelDrag?.();this.observer?.disconnect();this.bodyObserver?.disconnect();this.window.cancelAnimationFrame(this.frame);this.window.removeEventListener('resize',this.resized);this.document.removeEventListener('keydown',this.keys,true);
  for(const e of [...this.entries.values()]){e.node.classList.remove('ww-managed');if(e.modal!==null)e.node.setAttribute('aria-modal',e.modal);if(e.node.isConnected)e.shell.before(e.node);this.detach(e);}this.shelf.remove();this.preview.remove();delete this.document.body.dataset.workspace;
 }
}

