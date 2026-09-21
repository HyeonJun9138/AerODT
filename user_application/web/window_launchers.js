import {copyPanel,repeatPanel,createPanel} from './panel_instances.js';
import {WorkWindows} from './work_windows.js';
import {ModelLibrary} from './model_library.js';
import {AiModelLibrary} from './ai_model_library.js';
import {RouteCard} from './domains/uam/planning/route_card.js';
import {PlaceMenu} from './place_menu.js';
import {SettingsWindows} from './settings_windows.js';

export function installWindowLaunchers({document,workspace,focusMode,sources:s,onSimulationActive,onSample,onPlan,onFollow}){
 const groups=[],retained=[];let settings;
 const repeat=(source,options)=>{const group=repeatPanel(workspace,source,{...options,singleton:true});groups.push(group);return group;};
 const common={onOpen:()=>focusMode.set(false),onClose:()=>{}};
 const analysis=source=>repeat(source,{kind:'analysis',label:'UAM / 운항정보 분석',root:'window',create:p=>copyPanel(p,{...common,onAircraft:p.onAircraft}),prepare:(c,p)=>{c.recording=p.recording;c.filters={...p.filters};}});
 const decision=source=>repeat(source,{kind:'decision',label:'의사결정'});
 const deck=source=>{const originalRender=source.render;source.render=function(host){const root=originalRender.call(source,host);if(source.root)source.root.dataset.workspaceSource='true';return root;};return repeat(source,{kind:'deck',label:'버티포트 상세',retainChildrenOnSourceDestroy:true,prepare:c=>c.render(document.body)});};
 const pilot=source=>repeat(source,{kind:'pilot',label:'조종사',root:'console',create:p=>copyPanel(p,common),prepare:c=>{void c.load();}});
 const port=source=>{
  repeat(source,{kind:'vertiport',label:'버티포트 운영',root:'console',create:p=>copyPanel(p,common),prepare:(c,p)=>{
   c.records=p.records;c.selectedId=p.selectedId;c.demo=p.demo;
  }});
  repeat(source,{kind:'port-info',label:'버티포트 정보',method:'showInfo',closeMethod:'closeInfo',root:'info',create:p=>copyPanel(p,common)});
 };
 const independentDeck=p=>{p.openDeck=id=>{if(!id)return;p.onFocusDeck?.(id);void p.deckView?.open(id);};return p;};
 const psu=source=>{independentDeck(source);return repeat(source,{kind:'psu',label:'PSU',root:'console',feedMethods:['observe'],create:p=>{
  const d=copyPanel(s.psuDeckView);deck(d);return independentDeck(copyPanel(p,{...common,deckView:d}));
 }});};
 repeat(s.predictionPanel,{kind:'prediction',label:'UAM / Prediction',feedMethods:['observe','setReplay'],create:p=>copyPanel(p,common)});
 // Both replay consoles stay where they are drawn: one bar across the top of
 // the map, under the clock. Repeating the single-flight console into a
 // workspace window hid the original -- SettingsWindows hides its template --
 // so the bar vanished from the top and came back as a floating panel, which is
 // not what the multi-flight console does and not what an operator watching a
 // replay wants to chase around the screen.
 analysis(s.operationsAnalysis);decision(s.decisionPanel);deck(s.psuDeckView);pilot(s.pilotPanel);port(s.vertiportPanel);psu(s.psuPanel);
 repeat(s.demandSummary,{kind:'demand',label:'비행 생성 요약'});
 repeat(s.aiModelLibrary,{kind:'ai-library',label:'AI 모델'});
 repeat(s.riskRadar,{kind:'risk',label:'주변 교통 레이더',method:'select',closeMethod:'hide',feedMethods:['observe','setConfig']});
 const openRadar=s.riskRadar.select;s.riskRadar.select=entity=>entity?openRadar(entity):undefined;
 const ownAi=owner=>{
  const ai=createPanel(AiModelLibrary,{document,mount:document.body,onPick:request=>owner().chooseModel(request)});
  repeat(ai,{kind:'ai-library',label:'AI 모델'});return ai;
 };
 const work=new WorkWindows({document,workspace,labelPrefix:'UAM / ',singleton:true,factories:{
  live:({node})=>{let c;const ai=ownAi(()=>c);c=copyPanel(s.livePanel,{aiLibrary:ai,isVisible:()=>node.isConnected});return {
   render:body=>c.render(body),observe:snapshot=>c.observe(snapshot),setTransport:v=>c.setTransport(v),close:()=>c.leave(),destroy:()=>c.destroy(),panel:c};},
  library:()=>{let c;const ai=ownAi(()=>c);const models=new ModelLibrary({document,allowedKinds:['aircraft','person'],el:(...args)=>c.el(...args),load:s.libraryPanel.models?.load});c=copyPanel(s.libraryPanel,{models,aiLibrary:ai});const catalog=work.assets??s.libraryPanel.models?.catalog;if(catalog)models.setCatalog(catalog);return {
   render:body=>c.render(body),setAssets:catalog=>models.setCatalog(catalog),close:()=>{c.body=null;models.container=null;},destroy:()=>{c.body=null;models.container=null;},panel:c};},
  analysis:({node})=>{const c=copyPanel(s.operationsAnalysis,{...common,isSideVisible:()=>node.isConnected});analysis(c);return {
   render:body=>c.render(body),close:()=>{c.side=null;},destroy:()=>c.destroy(),panel:c};},
  stakeholders:()=>{
   const p=copyPanel(s.pilotPanel,common),v=copyPanel(s.vertiportPanel,common),d=copyPanel(s.psuDeckView),u=copyPanel(s.psuPanel,{...common,deckView:d});
   pilot(p);port(v);deck(d);psu(u);const c=copyPanel(s.stakeholderPanel,{pilotPanel:p,vertiportPanel:v,psuPanel:u});
   return {render:body=>c.render(body),observe:snapshot=>u.observe(snapshot),close:()=>c.deactivate(),destroy:()=>{c.destroy();p.destroy();v.destroy();u.destroy();},panel:c};
  },
  simulation:()=>{
   let c,p,d;const routeCard=new RouteCard({document,mount:document.body}),card=new RouteCard({document,mount:document.body});
   const menu=new PlaceMenu({document,mount:document.body,onChange:(name,value)=>c.toolChanged(name,value),onPlace:()=>c.placeWithTools(),onResume:()=>c.resumeTools()});
   const r=copyPanel(s.routePanel,{card:routeCard});
   d=copyPanel(s.demandPanel);
   p=copyPanel(s.planPanel,{demandPanel:d,onSample:sample=>onSample(p,sample),onPlan:plan=>onPlan?.(p,plan),onFollow:(sample,options)=>onFollow?.(p,sample,options)});
   c=copyPanel(s.simulationPanel,{routePanel:r,planPanel:p,card,placeMenu:menu});
   const controller={render:body=>c.render(body),setAssets:catalog=>p.setAssets(catalog),activate:()=>{onSimulationActive(c,p);c.armMap();},escape:()=>c.escape(),
    close:()=>{c.leave();c.body=null;},destroy:()=>{c.leave();p.destroy();routeCard.close();card.close();menu.close?.();},panel:c,plan:p};
   if(work.assets)p.setAssets(work.assets);return controller;
  }
 },onActivate:(kind,c)=>{if(kind==='simulation')c.activate();}});
 // Settings are multiple views of one browser preference set, not separate settings stores.
 const openSettings=template=>{settings??=new SettingsWindows({document,workspace,template,singleton:true,label:template.getAttribute('aria-label')??'설정'});return settings.open();};
 return {work,openSettings,destroy(){settings?.destroy();work.destroy();for(const g of groups)g.destroy();for(const item of retained)item.destroy?.();}};
}
