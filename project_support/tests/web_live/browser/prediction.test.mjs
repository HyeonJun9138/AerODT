import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PredictionPanel} from '../../../../user_application/web/domains/uam/prediction/prediction_panel.js';
import {predictionExample} from '../../../../user_application/web/prediction_examples.js';
import {geoToEcef,ecefToGeo,distance,scopeFor,candidates,checkedForecast,matchingForecast,pathAt,pathFor,clippedPath,predictionEvents,MAX_FORECASTS}
  from '../../../../user_application/web/prediction_data.js';
const sample=predictionExample(),entity=sample.snapshot.entities[0];
const response=(e=entity,{epoch=0,seconds=90}={})=>({schema_version:1,kind:'aircraft',entity_id:e.entity_id,reference_frame:'ecef_m',epoch,
  continuity_id:e.continuity_id,flight_phase:e.flight_phase,summary:{model:'uam_intent'},points:[[1000,...geoToEcef(e.latitude_deg,e.longitude_deg,e.altitude_m)],
    [1000+seconds,...geoToEcef(e.latitude_deg+.01,e.longitude_deg+.01,e.altitude_m+30)]]});
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function setup({enabled=true,api,now=()=>1000000}={}){
  const document={...fakeDocument,body:new FakeElement('body'),hidden:false},calls=[];
  const getJSON=async(url,options)=>{calls.push({url,options});if(api){const result=api(url,options);if(result!==undefined)return result;}
    if(url.includes('/vertiports'))return {vertiports:sample.ports};if(url.includes('/routes'))return sample.network;
    if(url.includes('/sources'))return {values:{uam_prediction:{enabled,model:'uam_intent'}},sources:[{id:'uam_prediction',provider:'임무 예측'}]};
    if(url.includes('/trajectory/'))return response(sample.snapshot.entities.find(e=>e.entity_id===decodeURIComponent(url.split('/').at(-1))));
    return sample.snapshot;};
  const view=new PredictionPanel({document,getJSON,now});view.observe(sample.snapshot);return {view,document,calls};
}

test('ECEF forecasts project back to local geography without moving the source',()=>{
  for(const [lat,lon,alt] of [[37.54,126.98,300],[37.58,127.12,1200],[0,0,0]]){
    const point=ecefToGeo(geoToEcef(lat,lon,alt));assert.ok(Math.abs(point.latitude-lat)<1e-7);assert.ok(Math.abs(point.longitude-lon)<1e-7);assert.ok(Math.abs(point.altitude_m-alt)<.001);
  }
  assert.equal(ecefToGeo([0,0,0]),null);
});
test('the three scopes give the full network, exactly 3 km at a deck and ownship-centred pilot view',()=>{
  assert.equal(scopeFor('vertiport',sample.snapshot.entities,sample.ports,'EX-V1').radius,3000);
  assert.equal(scopeFor('vertiport',sample.snapshot.entities,sample.ports,'EX-V1').target.id,'EX-V1');
  assert.equal(scopeFor('pilot',sample.snapshot.entities,sample.ports,entity.entity_id).center,entity);
  const area=scopeFor('psu',sample.snapshot.entities,sample.ports,'');assert.ok(sample.ports.every(p=>distance(area.center,p)<area.radius));
});
test('forecast coordinates, clocks and mission identity are validated and future points are never extrapolated',()=>{
  const raw=response(),before=JSON.stringify(raw),record=checkedForecast(raw,entity,0),path=pathFor(record,240,1000);
  assert.equal(record.status,'ready');assert.equal(path.seconds,90);assert.equal(pathAt(path,1091),null);assert.equal(pathAt(path,999),null);
  assert.equal(clippedPath(path,1010,240).at(-1).time,1090);assert.equal(clippedPath(path,1090,90).length,0);
  assert.equal(JSON.stringify(raw),before);
  for(const patch of [{epoch:1},{entity_id:'another'},{continuity_id:99},{flight_phase:'landing'},{reference_frame:'enu_m'},
    {points:[[1000,1,2,3],[1000,3,2,1]]},{points:[[1000,NaN,2,3],[1090,3,2,1]]}])assert.equal(checkedForecast({...raw,...patch},entity,0).paths.length,0);
  assert.equal(matchingForecast(record,{...entity,quality:'stale'},0),false);assert.equal(matchingForecast(record,{...entity,discontinuity:true},0),false);
  assert.equal(matchingForecast(record,{...entity,continuity_id:2},0),false);
});
test('independent learned horizons are preserved and a bad model entry does not hide other valid results',()=>{
  const values=[10,90,240].map((seconds,i)=>{const model=['uam_route_mlp_short','uam_route_mlp_mid','uam_route_mlp_long'][i];return {model_id:model,status:'ready',horizon_seconds:seconds,path:response(entity,{seconds})};});
  const raw={schema_version:2,kind:'uam_prediction_comparison',entity_id:entity.entity_id,epoch:0,continuity_id:1,flight_phase:'cruise',generated_at:1000,predictions:values};
  let record=checkedForecast(raw,entity,0);assert.deepEqual(record.paths.map(p=>p.seconds),[10,90,240]);assert.equal(pathFor(record,90,1000).seconds,90);
  values[1].path.points.at(-1)[0]=1091;record=checkedForecast(raw,entity,0);assert.deepEqual(record.paths.map(p=>p.seconds),[10,240]);
  values.forEach(v=>{v.status='warming_up';v.path=null;});assert.equal(checkedForecast(raw,entity,0).status,'warming_up');
});
test('network inference stays bounded and stable, while pilots get their own craft first',()=>{
  const many=Array.from({length:100},(_,i)=>({...entity,entity_id:`id-${String(i).padStart(3,'0')}`}));
  const first=candidates(many,'psu',null);assert.equal(first.length,MAX_FORECASTS);
  assert.deepEqual(candidates([...many].reverse(),'psu',null,first.map(e=>e.entity_id)).map(e=>e.entity_id),first.map(e=>e.entity_id));
  assert.equal(candidates(many,'pilot',many[99])[0].entity_id,many[99].entity_id);
  assert.equal(candidates(many.map(e=>({...e,flight_phase:'parked'})),'psu',null).length,0);
});
test('events use synchronized future times, altitude separation and the role scope',()=>{
  const options={entities:sample.snapshot.entities,forecasts:sample.forecasts,now:1000,horizon:90,epoch:0};
  const events=predictionEvents({...options,role:'psu'});assert.ok(events.some(e=>e.kind==='near'));assert.ok(events.length<=3);
  assert.ok(events.every(e=>e.metric&&!e.metric.includes('%')));
  const deck=predictionEvents({...options,role:'vertiport',target:sample.ports[0]});assert.ok(deck.some(e=>e.kind==='entry'));
  const pilot=predictionEvents({...options,role:'pilot',target:entity});assert.ok(pilot.every(e=>e.ids.includes(entity.entity_id)));
  assert.equal(predictionEvents({...options,role:'psu',now:2000}).length,0);
  const high=structuredClone(sample.forecasts);for(const record of high.values())if(record.entityId!==entity.entity_id)for(const path of record.paths)for(const p of path.points)p.altitude_m+=1000;
  assert.equal(predictionEvents({...options,forecasts:high,role:'pilot',target:entity}).length,0);
});
test('the live panel draws actual geography and switches role without replacing controls or inventing examples',async()=>{
  const {view}=setup();view.open();try{await settle();assert.match(view.root.textContent,/Network outlook/);assert.equal(view.example,false);
    assert.equal(view.root.querySelectorAll('.pred-aircraft').length,6);const tabs=view.roleTabs,select=view.targetSelect;
    view.setRole('vertiport');assert.equal(view.scope().radius,3000);assert.match(view.root.textContent,/공역 감시/);
    view.setRole('pilot');assert.match(view.root.textContent,/관측 기체/);assert.equal(view.roleTabs,tabs);assert.equal(view.targetSelect,select);
    view.horizon=240;view.paint();assert.equal(view.horizon,240);assert.equal(view.data.snapshot,sample.snapshot);
  }finally{view.destroy();}
});
test('disabled prediction does not call model endpoints; example mode is explicit and isolated',async()=>{
  const {view,calls}=setup({enabled:false});view.open();try{await settle();assert.equal(calls.filter(c=>c.url.includes('/trajectory/')).length,0);
    assert.match(view.mapStatus.textContent,/꺼져/);view.setExample(true);assert.match(view.mapStatus.textContent,/EXAMPLE/);
    assert.equal(view.data,view.exampleData);view.setExample(false);await settle();assert.equal(view.data.snapshot,sample.snapshot);assert.equal(view.example,false);
    assert.equal(calls.some(c=>c.options?.method&&c.options.method!=='GET'),false);
  }finally{view.destroy();}
});

test('reported operating infrastructure takes priority over saved scenario geography',async()=>{
  const {view,calls}=setup({enabled:false,api:url=>url==='/api/operations/context/environment'?{source:'physical',vertiports:sample.ports,network:sample.network}:undefined});
  view.open();try{await settle();assert.equal(view.contextSource,'physical');assert.match(view.mapSubtitle.textContent,/보고 항로/);
    assert.equal(calls.some(c=>c.url.startsWith('/api/simulation/')),false);
  }finally{view.destroy();}
});

test('refreshes retain event explanations and stable settings controls; reopening restores the target list',async()=>{
  const {view}=setup({enabled:false});view.open();try{await settle();view.setExample(true);
    const details=view.feed.querySelector('details'),settings=view.models.querySelector('button');details.open=true;
    view.paint();assert.equal(view.feed.querySelector('details'),details);assert.equal(view.models.querySelector('button'),settings);
    const events=predictionEvents({entities:view.entities,forecasts:view.data.forecasts,now:1000,horizon:90,role:'psu',epoch:0});
    view.paintFeed(events.map(event=>({...event,metric:'updated result'})),view.entities,view.scope(),view.data.forecasts,1000);
    assert.equal(view.feed.querySelector('details').getAttribute('open'),'');
    view.setRole('pilot');view.close();view.open();assert.ok(view.targetSelect.children.length>0);assert.equal(view.targetSelect.value,view.selection());
  }finally{view.destroy();}
});
test('closing aborts requests and late responses cannot resurrect predictions or the workspace',async()=>{
  const pending=[];const {view,calls}=setup({api:(url)=>url.includes('/trajectory/')?new Promise(resolve=>pending.push(resolve)):undefined});
  view.open();await settle();assert.equal(pending.length,2,'two workers only');view.close();pending.forEach(resolve=>resolve(response()));await settle();
  assert.equal(view.isOpen,false);assert.equal(view.forecasts.size,0);assert.ok(calls.filter(c=>c.url.includes('/trajectory/')).every(c=>c.options.signal.aborted));
});
test('a new epoch discards old results and hidden documents do not start inference',async()=>{
  const {view,document,calls}=setup();view.open();try{await settle();assert.ok(view.forecasts.size>0);
    view.observe({...sample.snapshot,epoch:1});assert.equal(view.forecasts.size,0);
    document.hidden=true;const count=calls.length;await view.readForecasts();assert.equal(calls.length,count);
  }finally{view.destroy();}
});
test('stale live observations hide future paths and never turn no-data into a clear-airspace claim',async()=>{
  let now=1000000;const {view}=setup({now:()=>now});view.open();try{await settle();now+=9000;view.paint();assert.match(view.mapStatus.textContent,/수신 지연/);
    assert.equal(view.root.querySelectorAll('.pred-future-line').length,0);assert.match(view.feed.textContent,/기다립니다/);
  }finally{view.destroy();}
});
test('Prediction is connected to the rail, shared live snapshots, settings and lifecycle',()=>{
  const base=new URL('../../../../user_application/web/',import.meta.url),html=readFileSync(new URL('index.html',base),'utf8'),app=readFileSync(new URL('app.js',base),'utf8');
  assert.match(html,/id="mode-prediction"[\s\S]*?<span>Prediction<\/span>/);assert.match(app,/predictionPanel.observe\(snapshot\)/);
  assert.match(app,/predictionPanel.destroy\(\)/);assert.match(app,/openSettings\('ai_models','uam_prediction'\)/);
});

test('Prediction opens nearby radar and its risk settings through explicit actions',()=>{
 const {view}=setup();const selected=[];let settings=0;view.onRisk=id=>selected.push(id);view.onRiskSettings=()=>settings++;
 view.open();try{
  view.setRole('pilot');view.root.querySelector('[data-risk-open=true]').click();assert.equal(selected[0],entity.entity_id);
  view.root.querySelector('[data-risk-settings=true]').click();assert.equal(settings,1);
 }finally{view.destroy();}
});

test('replay scope survives live snapshots and restores live scope after closing',async()=>{
 const {view:panel,calls}=setup();panel.observe(sample.snapshot);
 const replay={...sample.snapshot,epoch:999,entities:[{...entity,entity_id:'replay:one',source:'replay'}]};
 panel.setReplay(replay);panel.observe({...sample.snapshot,epoch:123});
 assert.equal(panel.snapshot.epoch,999);assert.equal(panel.entities[0].entity_id,'replay:one');
 panel.root={};panel.config={enabled:true};const before=calls.length;
 await panel.readForecasts();assert.equal(calls.length,before);
 panel.root=null;panel.setReplay(null);assert.equal(panel.snapshot.epoch,123);
});
