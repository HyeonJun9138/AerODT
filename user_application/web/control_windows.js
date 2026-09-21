import {SettingsWindows} from './settings_windows.js';
// Multiple control views share the existing replay/clock owner. Closing a view
// must never invoke ScenarioControl.close or PlanPanel.clearFlight.
export function repeatControlViews({source,document,workspace,kind='scenario-control',label='시뮬레이션 컨트롤',createViews=template=>new SettingsWindows({document,workspace,template,kind,label,width:760,height:420,className:'ww-control-view'})}){
 const all=new Set();let views,root,pending,disposed=false;const nativeOpen=source.open;
 const show=()=>{if(disposed||!source.root)return;if(root!==source.root){root=source.root;root.dataset.workspaceSource='true';for(const button of root.querySelectorAll?.('.sc-close')??[])button.textContent='시나리오 종료';views=createViews(root);all.add(views);}return views.open();};
 source.open=async(...args)=>{if(!source.root){pending??=Promise.resolve(nativeOpen.apply(source,args)).finally(()=>{pending=null;});await pending;}return show();};
 return {show,destroy(){disposed=true;for(const view of all)view.destroy();all.clear();}};
}
export function repeatFlightViews({source,document,workspace}){
 let views,root;const all=new Set(),nativeShow=source.show,nativeCollapse=source.setCollapsed;
 const show=()=>{if(!source.root)return;if(root!==source.root){root=source.root;root.dataset.workspaceSource='true';for(const button of root.querySelectorAll?.('.flight-dismiss,.flight-mini-close')??[])button.textContent='재생 종료';views=new SettingsWindows({document,workspace,template:root,singleton:true,kind:'flight-control',label:'단일 비행 컨트롤',width:760,height:420,className:'ww-control-view'});all.add(views);}return views.open();};
 source.setCollapsed=function(collapsed){const value=nativeCollapse.call(source,collapsed);if(!collapsed)show();return value;};
 source.show=function(...args){return nativeShow.apply(source,args);};
 return {show,destroy(){for(const v of all)v.destroy();}};
}
