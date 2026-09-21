import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanel} from '../../../../user_application/web/panel_instances.js';
import {installWindowLaunchers} from '../../../../user_application/web/window_launchers.js';
import {FakeElement} from './fake_dom.mjs';
class Controller {
 constructor(options){Object.assign(this,options);this.records=[];this.selectedId=null;this.recording='current';this.closed=0;this.destroyed=0;this.root=null;this.console=null;this.window=null;}
 open(){const node=new FakeElement('section');this.document.body.append(node);this.root=this.console=this.window=node;}
 showInfo(){this.open();this.info=this.root;}
 select(){this.open();}
 close(){this.closed++;this.root?.remove();this.root=this.console=this.window=null;}
 closeInfo(){this.close();}hide(){this.close();}
 destroy(){this.destroyed++;this.close();}
 render(body){this.body=body;}
 observe(snapshot){this.snapshot=snapshot;}
 setReplay(){}setConfig(){}setTransport(){}setAssets(catalog){this.catalog=catalog;}
 leave(){this.closed++;}deactivate(){this.body=null;}armMap(){}escape(){return false;}
 load(){this.loaded=true;return Promise.resolve();}
 el(tag){return new FakeElement(tag);}
}
function fixture(){
 const document={body:new FakeElement('body'),createElement:t=>new FakeElement(t),querySelectorAll:()=>[]};
 const entries=new Map(),workspace={create(options){const node=new FakeElement('section');document.body.append(node);const entry={...options,node};entries.set(node,entry);return {node,entry};},manage(node,options){entries.set(node,options);},release(node){entries.delete(node);}};
 const names=['scenarioControl','predictionPanel','operationsAnalysis','pilotPanel','vertiportPanel','psuPanel','decisionPanel','psuDeckView','demandSummary','aiModelLibrary','riskRadar','libraryPanel','livePanel','simulationPanel','routePanel','planPanel','demandPanel','stakeholderPanel'];
 const sources=Object.fromEntries(names.map(name=>[name,createPanel(Controller,{document,api:{generate:async()=>({})}})]));
 const active=[];const installed=installWindowLaunchers({document,workspace,focusMode:{set(){}},sources,onSimulationActive:(...args)=>active.push(args),onSample(){}});return {installed,sources,entries,active};
}
test('launcher simulation reuses its form and closing it does not stop the plan',()=>{
 const f=fixture(),a=f.installed.work.open('simulation'),b=f.installed.work.open('simulation');assert.equal(a,b);assert.equal(f.installed.work.rows.size,1);
 const plan=a.controller.panel.planPanel;f.entries.get(a.node).onClose();assert.equal(plan.destroyed,0);assert.equal(f.installed.work.rows.size,0);assert.notEqual(f.installed.work.open('simulation'),a);f.installed.destroy();
});
test('launcher repeats reuse same-kind windows while different kinds coexist',()=>{
 const f=fixture();const a=f.sources.predictionPanel.open(),b=f.sources.predictionPanel.open();assert.equal(a,b);assert.equal(a.closed,0);
 const l=f.installed.work.open('library'),m=f.installed.work.open('library');assert.equal(l,m);assert.notEqual(f.installed.work.open('live'),l);f.installed.destroy();
});
test('pilot launch fetches settings for the fresh controller',()=>{
 const f=fixture(),pilot=f.sources.pilotPanel.open();assert.equal(pilot.loaded,true);f.installed.destroy();
});
test('analysis detail inherits the selected recording from its launching summary',()=>{
 const f=fixture();f.sources.operationsAnalysis.recording='recording-2026';const detail=f.sources.operationsAnalysis.open('sorties');assert.equal(detail.recording,'recording-2026');f.installed.destroy();
});

test('each simulation plan routes follow updates through its owner',()=>{
 const f=fixture(),row=f.installed.work.open('simulation');assert.equal(typeof row.controller.panel.planPanel.onFollow,'function');f.installed.destroy();
});


test('scenario control keeps its original single console open method',()=>{
 const f=fixture();assert.equal(f.sources.scenarioControl.open,Controller.prototype.open);f.sources.scenarioControl.open();assert.notEqual(f.sources.scenarioControl.root.dataset.workspaceSource,'true');f.installed.destroy();
});

test('library window receives cached catalog and later asset updates',()=>{
 const f=fixture(),catalog={assets:[{asset_id:'a',thumbnail:'/a.jpg',kind:'aircraft'}]};f.installed.work.setAssets(catalog);
 const row=f.installed.work.open('library');assert.equal(row.controller.panel.models.catalog,catalog);
 const next={assets:[]};f.installed.work.setAssets(next);assert.equal(row.controller.panel.models.catalog,next);f.installed.destroy();
});
test('library window inherits the catalog loader when opened before map assets',async()=>{
 const f=fixture(),catalog={assets:[]};let calls=0;f.sources.libraryPanel.models={load:async()=>{calls++;return catalog;}};
 const row=f.installed.work.open('library');await row.controller.panel.models.fetchCatalog();assert.equal(calls,1);assert.equal(row.controller.panel.models.state,'ready');f.installed.destroy();
});
