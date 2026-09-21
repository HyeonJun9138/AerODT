// Constructor dependencies may be shared; each window owns a fresh controller.
const recipes = new WeakMap();
const singletons = new WeakMap();
export function createPanel(Class, options = {}) {
 const saved = {...options};
 const instance = new Class(saved);
 recipes.set(instance, {Class, options:saved});
 return instance;
}
export function copyPanel(instance, overrides = {}) {
 const recipe = recipes.get(instance);
 if (!recipe) throw new TypeError('Panel must be constructed with createPanel');
 return createPanel(recipe.Class, {...recipe.options, ...overrides});
}
export function repeatPanel(workspace, source, {
 singleton=false, method='open', root='root', closeMethod='close', getRoot, kind, label, width, height,
 create=(source)=>copyPanel(source), prepare=()=>{}, feedMethods=[],retainChildrenOnSourceDestroy=false,
} = {}) {
 const instances = new Set(), disposers = new Map(), feeds = new Map();
 const originalOpen = source[method], originalDestroy = source.destroy;
 let destroyed = false;
 if(!singletons.has(workspace))singletons.set(workspace,new Map());
 const shared=singletons.get(workspace),singleKey=kind??source;
 const readRoot = getRoot ?? (child=>child[root]);

 for (const name of feedMethods) {
  const original = source[name];
  if (typeof original !== 'function') continue;

  source[name] = function(...args) {
   feeds.set(name, args);
   const result = original.apply(source,args);
   for (const child of [...instances]) child[name]?.(...args);
   return result;
  };
 }
 const open = (...args) => {
  // A launcher whose source group was torn down used to do nothing at all
  // when pressed - no window, no message - which reads as a broken button.
  // Say so where a developer will find it.
  if (destroyed) {console.warn(`[windows] ${label??kind??'panel'} 창을 여는 원본 패널이 이미 정리되어 열 수 없습니다.`);return undefined;}
  const prior=singleton?shared.get(singleKey):null;
  if(prior){
   if(args.length && args.some((value,i)=>value!==prior.args[i])){prepare(prior.child,source,args);const result=prior.child[method](...args);prior.args=args;if(result?.then)return Promise.resolve(result).then(()=>{workspace.reveal?.(prior.readRoot(prior.child));return prior.child;},error=>{prior.child.destroy();throw error;});}
   workspace.reveal?.(prior.readRoot(prior.child));return prior.child;
  }
  const child = create(source,args);
  if (!child || child === source) throw new TypeError('Each panel window needs a new controller');
  const nativeClose = child[closeMethod], nativeDestroy = child.destroy;
  let closed=false, cleaning=false, managed=null, invoking=false;
  const dispose = () => {
   if (closed || cleaning) return;
   closed=true;cleaning=true;if(shared.get(singleKey)?.child===child)shared.delete(singleKey);instances.delete(child);disposers.delete(child);
   try {
    nativeClose?.call(child);
    nativeDestroy?.call(child);
   } finally {
    if (managed) workspace.release(managed);
    managed=null;cleaning=false;
   }
  };
  const register = () => {
   const node=readRoot(child);
   if (closed) {node?.remove?.();return;}
   if (!node || node===managed) return;
   if (managed) workspace.release(managed);
   managed=node;
   workspace.manage(node,{kind,label,width,height,onClose:dispose});
  };
  child[closeMethod]=function(...closeArgs) {
   if (invoking && !closed) {
    const result=nativeClose?.apply(child,closeArgs);
    if(managed){workspace.release(managed);managed=null;}
    return result;
   }
   return dispose();
  };
  child.destroy=dispose;
  child[method]=function(...openArgs) {
   if(closed)return;
   invoking=true;
   try {return originalOpen.apply(child,openArgs);}
   finally {invoking=false;register();}
  };
  // Async opens may mount before their promise resolves. Register in that same
  // microtask turn, ahead of the workspace's scheduled DOM discovery pass.
  const descriptor=Object.getOwnPropertyDescriptor(child,root);
  if (!getRoot && (!descriptor || ('value' in descriptor && descriptor.configurable))) {
   let node=child[root];
   Object.defineProperty(child,root,{configurable:true,enumerable:true,get:()=>node,set:value=>{
    if (closed && value) {value.remove?.();node=null;return;}
    node=value;if(value)queueMicrotask(register);
   }});
  }
  instances.add(child);disposers.set(child,dispose);
  if(singleton)shared.set(singleKey,{child,args,readRoot});
  try {
   for (const [name,values] of feeds) child[name]?.(...values);
   prepare(child,source,args);
   // Only the source is patched: child callbacks retain their native open.
   const result=child[method](...args);
   register();
   if (result && typeof result.then==='function') {
    return Promise.resolve(result).then(()=>{register();return child;},error=>{dispose();throw error;});
   }
   return child;
  } catch (error) {dispose();throw error;}
 };
 source[method]=open;
 // Existing toolbar readers use either a getter or a method named isOpen.
 let owner=source,descriptor;
 while(owner && !descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'isOpen');owner=Object.getPrototypeOf(owner);}
 if (!descriptor || descriptor.configurable!==false) {
  if (typeof descriptor?.value==='function') source.isOpen=()=>instances.size>0;
  else Object.defineProperty(source,'isOpen',{configurable:true,get:()=>instances.size>0,set:()=>{}});
 }
 const destroy = () => {
  if (destroyed) return;
  destroyed=true;
  for (const dispose of [...disposers.values()]) dispose();
  feeds.clear();
  originalDestroy?.call(source);
 };
 source.destroy=retainChildrenOnSourceDestroy?()=>originalDestroy?.call(source):destroy;
 return {source,instances,open,destroy};
}


