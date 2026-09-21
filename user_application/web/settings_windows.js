// Settings are one browser preference set, presented by independent windows.
// Only the original controls execute the existing preference callbacks.
let nextWindow=0;
const referenceAttributes=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','list','headers']);
function nodes(root){return [root,...Array.from(root.children??[]).flatMap(nodes)];}
// TextContent replaces Text nodes even when the element tree is unchanged.
// Reconcile only those non-element siblings; never replace a live button just
// because its clock or label changed between pointerdown and pointerup.
function syncTextChildren(source,copy){
 let index=0;
 for(const child of source.childNodes){
  let target=copy.childNodes[index];
  if(child.nodeType===1){
   while(target&&target.nodeType!==1){target.remove();target=copy.childNodes[index];}
  }else if(target?.nodeType===child.nodeType){
   if(target.nodeValue!==child.nodeValue)target.nodeValue=child.nodeValue;
  }else copy.insertBefore(child.cloneNode(true),target??null);
  index++;
 }
 while(copy.childNodes.length>index)copy.childNodes[index].remove();
}
function control(node){return ['INPUT','SELECT','TEXTAREA'].includes(node.tagName);}
// What the person looking at this window has done with it, as opposed to what
// the preference is. A fold they opened is theirs: the template is hidden and
// nobody ever opens it, so mirroring its state would shut the fold under their
// hand -- which it did, on the quarter-second beat, leaving 세부 성능 조정 and
// every other fold in the settings window impossible to keep open.
function viewerOwned(node,name){return name==='open'&&node.tagName==='DETAILS';}
export class SettingsWindows {
 constructor({document=globalThis.document,workspace,template,singleton=false,kind='settings-copy',label='설정',width=380,height=560,className='ww-settings-window'}={}) {
  Object.assign(this,{document,workspace,template,singleton,kind,label,width,height,className});this.instances=new Set();this.window=document.defaultView??globalThis;
  this.template.hidden=true;
 }
 startSync(){
  if(this.timer!==undefined)return;
  const Observer=this.window.MutationObserver;
  if(Observer){this.observer=new Observer(()=>this.sync());this.observer.observe(this.template,{subtree:true,childList:true,characterData:true,attributes:true});}
  this.timer=this.window.setInterval(()=>this.sync(),250);this.timer?.unref?.();
 }
 stopSync(){this.observer?.disconnect();this.observer=null;if(this.timer!==undefined)this.window.clearInterval(this.timer);this.timer=undefined;}
 open(){
  if(this.disposed)return;
  if(this.singleton&&this.instances.size){const view=this.instances.values().next().value;this.workspace.reveal?.(view.root);return view;}
  const prefix=`settings-copy-${++nextWindow}-`,root=this.template.cloneNode(true);
  root.removeAttribute('style');root.removeAttribute('data-workspace-source');
  const view={root,prefix,pairs:[],originals:new Map(),closed:false};
  const rebuild=()=>{
   const copies=nodes(root);view.pairs=nodes(this.template).map((source,i)=>[source,copies[i]]);
   view.originals=new Map(view.pairs.map(([source,copy])=>[copy,source]));view.sourceParents=new Map(view.pairs.map(([source])=>[source,source.parentNode]));
   this.syncView(view);
  };
  view.rebuild=rebuild;
  const close=()=>{
   if(view.closed)return;view.closed=true;
   for(const type of ['input','change','click'])root.removeEventListener(type,forward);
   this.instances.delete(view);this.workspace.release(root);root.remove();
   if(!this.instances.size)this.stopSync();
  };
  const forward=event=>{
   if(view.closed)return;
   let target=event.target,original=view.originals.get(target);
   if(event.type==='click'){
    while(target&&target!==root&&!['BUTTON','A'].includes(target.tagName)&&!(target.tagName==='INPUT'&&['button','submit','reset'].includes(target.getAttribute('type'))))target=target.parentNode;
    if(!target||target===root)return;
    original=view.originals.get(target);
   }
   if(!original)return;
   event.stopPropagation();
   if(control(target)) {original.value=target.value;original.checked=target.checked;}
   const EventClass=event.type==='click'?(this.window.MouseEvent??this.window.Event):this.window.Event;
   // Do not call onclick plus dispatchEvent, or synthesize a second change.
   original.dispatchEvent(new EventClass(event.type,{bubbles:true,cancelable:true}));
   this.sync();
  };
  view.close=close;view.destroy=close;
  rebuild();for(const type of ['input','change','click'])root.addEventListener(type,forward);
  this.instances.add(view);this.document.body.append(root);
  this.workspace.manage(root,{kind:this.kind,label:this.label,width:this.width,height:this.height,onClose:close});
  this.startSync();return view;
 }
 syncView(view){
  for(const [source,copy] of view.pairs){
   if(!copy)continue;

   const isRoot=copy===view.root,editing=this.document.activeElement===copy&&control(copy);
   for(const name of source.getAttributeNames()){
    if(name.startsWith('on')||name==='data-workspace-source'||name==='style'&&isRoot||name==='hidden'&&isRoot||viewerOwned(copy,name))continue;
    let value=source.getAttribute(name);
    if(name==='id'){copy.setAttribute('data-settings-source-id',value);value=view.prefix+value;}
    else if(referenceAttributes.has(name))value=value.split(/\s+/).map(id=>view.prefix+id).join(' ');
    else if(name==='name'&&source.tagName==='INPUT')value=view.prefix+value;
    else if(name==='href'&&value.startsWith('#'))value='#'+view.prefix+value.slice(1);
    if(name==='class'&&isRoot)value=value.replace(/\bww-managed\b/g,'')+' '+this.className+(/\bww-managed\b/.test(copy.getAttribute('class')??'')?' ww-managed':'');
    if(copy.getAttribute(name)!==value)copy.setAttribute(name,value);
   }
   for(const name of copy.getAttributeNames()){
    if(name.startsWith('on')||(!isRoot&&name!=='data-settings-source-id'&&!viewerOwned(copy,name)&&source.getAttribute(name)===null))copy.removeAttribute(name);
   }
   if(isRoot){copy.hidden=false;copy.removeAttribute('hidden');if(!source.getAttribute('class'))copy.setAttribute('class','glass '+this.className+(/\bww-managed\b/.test(copy.getAttribute('class')??'')?' ww-managed':''));}
   else {copy.hidden=source.hidden;copy.disabled=source.disabled;if('inert' in source)copy.inert=source.inert;}
   if(control(source)&&!editing){copy.value=source.value;copy.checked=source.checked;}
   if(source.tagName!=='TEXTAREA')syncTextChildren(source,copy);
  }
 }
 sync(){
  if(this.disposed)return;if(!this.template.hidden)this.template.hidden=true;
  const current=nodes(this.template);
  for(const view of this.instances){
   const changed=current.length!==view.pairs.length||current.some((node,i)=>node!==view.pairs[i]?.[0]||node.parentNode!==view.sourceParents.get(node));
   if(changed){
    if(view.root.contains(this.document.activeElement))continue;
    // A rebuild throws the copy away and the viewer's open folds with it. They
    // are carried over by position -- best effort, since it is the positions
    // that just changed, and a fold that cannot be matched simply starts shut.
    const folds=nodes(view.root).filter(node=>node.tagName==='DETAILS').map(node=>node.getAttribute('open'));
    view.root.replaceChildren(...Array.from(this.template.childNodes,n=>n.cloneNode(true)));view.rebuild();
    nodes(view.root).filter(node=>node.tagName==='DETAILS')
     .forEach((node,index)=>{if(folds[index]!=null)node.setAttribute('open',folds[index]);});
   }else this.syncView(view);
  }
 }
 destroy(){if(this.disposed)return;this.disposed=true;for(const view of [...this.instances])view.close();this.stopSync();}
}



