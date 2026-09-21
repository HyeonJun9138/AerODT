// Independent presentation forms. A closed form does not own the running simulation.
const LABELS={live:'Live Twinning',simulation:'Simulation',library:'Library',stakeholders:'Stakeholders',analysis:'운항정보 분석'};
export class WorkWindows {
 constructor({document=globalThis.document,workspace,factories,labelPrefix='',singleton=false,onActivate=()=>{}}){Object.assign(this,{document,workspace,factories,labelPrefix,singleton,onActivate});this.rows=new Set();this.retained=new Set();}
 open(kind){
  const existing=this.singleton?[...this.rows].find(row=>row.kind===kind&&!row.closed):null;
  if(existing){this.workspace.reveal?.(existing.node);this.active=existing;this.onActivate(kind,existing.controller);return existing;}
  const factory=this.factories[kind];if(!factory)throw new Error(`Unknown work window: ${kind}`);
  let row;const created=this.workspace.create({kind:`work-${kind}`,label:this.labelPrefix+(LABELS[kind]??kind),width:420,height:650,
   onClose:()=>{if(!row||!this.rows.delete(row))return;row.closed=true;row.controller.close?.();row.node.remove();this.workspace.release?.(row.node);if(this.active===row)this.active=null;},
   onActivate:()=>{if(row&&!row.closed){this.active=row;this.onActivate(kind,row.controller);}}});
  // Shadow roots keep legacy form ids/labels local without copying state or event handlers.
  const host=created.node.attachShadow?.({mode:'open'})??created.node;
  const style=this.document.createElement('style');style.textContent=':host{display:block;height:100%;min-height:0;color:inherit;font:inherit}#drawer-body{height:100%;box-sizing:border-box;padding:16px;overflow:auto;background:var(--panel-glass,linear-gradient(145deg,rgba(107,119,128,.78),rgba(62,75,85,.82)));color:#d6e4eb;font:12px/1.65 "Segoe UI","Malgun Gothic",sans-serif}';host.append(style);
  const body=this.document.createElement('div');body.setAttribute('id','drawer-body');
  // Shadow-root links do not block first paint. Keep layout measurable while
  // preventing the unstyled controls from flashing before their CSS arrives.
  const sources=[...this.document.querySelectorAll('head link[rel="stylesheet"]')];
  body.style.visibility=sources.length?'hidden':'visible';
  const loading=this.document.createElement('div');loading.setAttribute('role','status');loading.textContent='화면 준비 중…';
  loading.style.cssText='position:absolute;top:16px;left:16px;color:inherit;font:12px "Segoe UI","Malgun Gothic",sans-serif';
  if(sources.length)host.append(loading);host.append(body);
  let remaining=sources.length,failed=false;
  for(const source of sources){
   const link=this.document.createElement('link');link.setAttribute('rel','stylesheet');link.setAttribute('href',source.getAttribute('href'));
   const settle=ok=>{link.onload=link.onerror=null;failed ||= !ok;if(--remaining>0 || row?.closed)return;
    if(failed){loading.textContent='화면 스타일을 불러오지 못했습니다. 창을 닫고 다시 열어주세요.';return;}
    body.style.visibility='visible';loading.remove();};
   link.onload=()=>settle(true);link.onerror=()=>settle(false);host.append(link);
  }
  const controller=factory({body,node:created.node,entry:created.entry});row={...created,kind,body,controller,closed:false};this.rows.add(row);this.retained.add(row);controller.render(body);if(this.snapshot)controller.observe?.(this.snapshot);this.active=row;this.onActivate(kind,controller);return row;
 }
 observe(snapshot){this.snapshot=snapshot;for(const row of this.rows)row.controller.observe?.(snapshot);}
 setTransport(status){for(const row of this.rows)row.controller.setTransport?.(status);}
 setAssets(catalog){this.assets=catalog;for(const row of this.retained)row.controller.setAssets?.(catalog);}
 escape(){const c=this.active?.controller;return Boolean(c?.escape?.());}
 destroy(){for(const row of this.retained)row.controller.destroy?.();this.rows.clear();this.retained.clear();this.active=null;this.snapshot=null;}
}
