import {SelectionPanel} from './selection_panel.js';
import {mapEntityName} from '/visualization/entity_labels.js';

let nextWindow=0;

// Independent read-only inspection views; the incoming snapshot remains owned
// by the runtime. No selected-target state is shared between these controllers.
export class SelectionWindows {
  // `supportsCamera` says which objects carry a camera; `onCamera` opens it.
  // Both come from the page, so this window does not have to know the kinds.
  constructor({document=globalThis.document,C,template,workspace,singleton=false,onFocus=()=>{},onFollow=()=>{},onCockpit=()=>{},onCamera=()=>{},onRadar=()=>{},onDismiss=()=>{},supportsCamera=()=>false,getMission=null}) {
    Object.assign(this,{document,C,workspace,singleton,onFocus,onFollow,onCockpit,onCamera,onRadar,onDismiss,supportsCamera,getMission});
    this.template=template.cloneNode(true);this.windows=new Map();this.catalog={assets:[]};
  }
  open(entity) {
    if(!entity?.entity_id)return null;
    if(this.singleton){
      const previous=this.windows.values().next().value;
      if(previous?.entityId===entity.entity_id){previous.panel.show(entity);this.workspace.reveal?.(previous.root);return previous;}
      if(previous)previous.close({notify:false});
    }
    const id=`selection-window-${++nextWindow}`,root=this.template.cloneNode(true),nodes=new Map();
    for(const node of [root,...root.querySelectorAll('[id]')]){
      const original=node.id;if(!original)continue;
      nodes.set(original,node);node.dataset.selectionId=original;node.id=`${id}-${original}`;
    }
    for(const node of [root,...root.querySelectorAll('*')]){
      for(const name of ['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant']){
        const value=node.getAttribute(name);
        if(value)node.setAttribute(name,value.split(/\s+/).map(key=>nodes.get(key)?.id??key).join(' '));
      }
    }
    root.id=id;delete root.dataset.workspaceSource;root.classList.add('selection-window');root.hidden=false;root.inert=false;root.dataset.open='true';root.setAttribute('aria-hidden','false');
    for(const key of ['model-preview','flight-readouts','selected-detail','mission-detail','trajectory-detail','physical-sensor-detail'])nodes.get(key)?.replaceChildren();
    const lookup=key=>nodes.get(key)??null;
    // A cloned canvas never carries its renderer. Every window constructs its
    // own preview and its own attribution container.
    let credits=lookup('preview-credits');
    if(credits)credits.remove();
    else {credits=this.document.createElement('div');credits.id=`id-${id}-credits`;}
    credits.classList.add('selection-preview-credits');credits.hidden=true;credits.setAttribute('aria-hidden','true');
    credits.setAttribute('aria-label','3D 미리보기 출처');
    const creditHost=this.document.getElementById?.('attribution')??root;
    creditHost.append(credits);
    this.document.body.append(root);
    const panel=new SelectionPanel(this.C,{document:this.document,root,lookup,creditContainer:credits});
    const controller={id,root,panel,entityId:entity.entity_id,closed:false};
    const dispose=()=>{
      if(controller.closed)return;controller.closed=true;clearTimeout(controller.timer);panel.destroy();credits.remove();this.workspace.release?.(root);root.remove();this.windows.delete(id);
      if(!controller.silentClose)this.onDismiss(controller.entityId);
    };
    controller.close=({notify=true}={})=>{if(controller.closed)return;controller.silentClose=!notify;if(controller.entry?.close)controller.entry.close();dispose();};
    this.windows.set(id,controller);
    for(const [key,callback] of [['focus',this.onFocus],['track',this.onFollow],['cockpit-view',this.onCockpit],['camera-live',this.onCamera],['radar-live',this.onRadar]]){
      const button=lookup(key);if(button){button.onclick=()=>callback(controller.entityId);if(key==='cockpit-view')button.disabled=entity.kind!=='uam';
        // The camera button is cloned hidden with the rest of the template; it
        // shows for something that carries a camera, exactly as on the page.
        if(key==='radar-live')button.hidden=!['uam','aircraft','helicopter','drone'].includes(entity.kind);
        if(key==='camera-live')button.hidden=!this.supportsCamera(entity);}
    }
    const clear=lookup('clear');if(clear){clear.hidden=true;clear.onclick=controller.close;}
    panel.setAssets(this.catalog);panel.show(entity);
    controller.entry=this.workspace.manage(root,{kind:'selection-detail',label:mapEntityName(entity),width:420,height:680,onClose:dispose});
    const refresh=async()=>{
      if(controller.closed||!this.getMission||panel.entity?.kind!=='uam')return;
      try{
        const detail=await this.getMission(panel.entity);
        if(controller.closed)return;
        if(detail&&('mission' in detail||'sensors' in detail||'trajectory' in detail)){
          panel.setMission(detail.mission??null);panel.setSensors(detail.sensors??null);
          if('trajectory' in detail)panel.setTrajectory(detail.trajectory);
        }else panel.setMission(detail??null);
      }catch{if(!controller.closed)panel.setMission(null);}
      finally{if(!controller.closed)controller.timer=setTimeout(refresh,1500);}
    };
    void refresh();return controller;
  }
  observe(snapshot) {
    const entities=snapshot?.entities??[];
    for(const controller of this.windows.values()){
      const entity=entities.find(item=>item.entity_id===controller.entityId);
      if(entity)controller.panel.show(entity);
    }
  }
  setAssets(catalog) {this.catalog=catalog;for(const controller of this.windows.values())controller.panel.setAssets(catalog);}
  destroy() {for(const controller of [...this.windows.values()])controller.close({notify:false});}
}
