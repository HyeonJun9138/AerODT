import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {OperationsAnalysis} from '../../../../user_application/web/domains/uam/analysis/operations_analysis.js';
import {clock} from '../../../../user_application/web/domains/uam/analysis/operations_charts.js';

const report=JSON.parse(readFileSync(new URL('../fixtures/operations_analysis.json',import.meta.url),'utf8'));
const summary=()=>({...structuredClone(report),sorties:undefined,available:true});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function make(api){
  const document={...fakeDocument,body:new FakeElement('body'),hidden:false};const calls=[],focus=[];
  const get=async url=>{calls.push(url);if(api)return api(url);if(url.includes('/records'))return {records:[{id:'archive',date:'2026-09-10',name:'기록'}]};
    if(url.includes('/sorties/'))return {meta:report.meta,row:structuredClone(report.sorties[0])};
    if(url.includes('/sorties?'))return {meta:report.meta,rows:structuredClone(report.sorties),page:1,pages:1,total:8};
    return summary();};
  let visible=true;
  const view=new OperationsAnalysis({document,getJSON:get,isSideVisible:()=>visible,onAircraft:id=>focus.push(id),pollMs:1e8});
  const body=new FakeElement('div');document.body.append(body);view.render(body);
  return {view,document,body,calls,focus,hide:()=>{visible=false;}};
}

test('summary, archive picker, chart drill-down and sortie events use the API contract',async()=>{
  const {view,body,calls,focus}=make();try{
    await settle();assert.match(body.textContent,/착륙 완료/);assert.equal(view.sideSelect.children.length,4);
    view.open('overview');await settle();assert.equal(view.tabs.children.length,6);assert.match(view.content.textContent,/시간대별 계획/);
    view.content.querySelector('.oa-hour-pick').click();await settle();
    assert.equal(view.tab,'sorties');assert.equal(view.filters.hour,0);assert.ok(calls.some(url=>url.includes('hour=0')));
    view.rowsNode.querySelector('.oa-text-button').click();await settle();assert.match(view.inspector.textContent,/주기장 출발/);
    view.inspector.querySelector('button').click();assert.deepEqual(focus,['A0']);
    view.open('fleet');view.content.querySelector('.oa-rank-row').click();await settle();assert.equal(view.filters.aircraft,'A0');
    view.open('ports');view.content.querySelector('.oa-rank-row').click();await settle();assert.equal(view.filters.vertiport,'V2');
  }finally{view.destroy();}
});

test('hidden panel does not poll; closing details leaves the simulation untouched',async()=>{
  const {view,calls,hide,document}=make();try{
    await settle();hide();const n=calls.length;await view.refresh();assert.equal(calls.length,n);
    view.open();await settle();view.close();const closed=calls.length;await view.refresh();assert.equal(calls.length,closed);
    assert.ok(calls.every(url=>url.startsWith('/api/simulation/analysis')));
    document.hidden=true;view.open();const hidden=calls.length;await view.refresh();assert.equal(calls.length,hidden);
  }finally{view.destroy();}
});

test('one summary request in flight and a late response cannot overwrite selected recording',async()=>{
  let resolve,counter=0;
  const {view}=make(url=>{
    if(url.includes('/records'))return {records:[]};counter++;
    if(counter===1)return new Promise(r=>{resolve=r;});
    return {...summary(),meta:{...report.meta,scenario_id:'archive'}};
  });try{
    await view.refresh();assert.equal(counter,1);view.choose('archive');assert.equal(counter,1);
    resolve(summary());await settle();assert.equal(view.report.meta.scenario_id,'archive');assert.equal(counter,2);
  }finally{view.destroy();}
});

test('errors preserve the last valid totals and recover on next successful response',async()=>{
  let fail=false;
  const {view}=make(url=>{if(url.includes('/records'))return {records:[]};if(fail)throw Error('offline');return summary();});
  try{await settle();const t=view.report.totals;fail=true;await view.refresh();assert.equal(view.report.totals,t);assert.match(view.sideContent.textContent,/마지막 수신값/);
    fail=false;await view.refresh();assert.equal(view.error,'');
  }finally{view.destroy();}
});

test('scenario reset clears filters; tab navigation and query controls survive refresh',async()=>{
  let current=summary();const {view}=make(url=>{if(url.includes('/records'))return {records:[]};if(url.includes('/sorties?'))return {meta:current.meta,rows:[],page:1,pages:1,total:0};return current;});
  try{await settle();view.drill({aircraft:'A0'});await settle();const form=view.form;
    await view.refresh();assert.equal(view.form,form);
    view.tabs.children[3].onkeydown({key:'Home',preventDefault(){}});assert.equal(view.tab,'overview');
    await settle();
    current={...summary(),meta:{...report.meta,scenario_id:'new'}};await view.refresh();assert.equal(view.filters.aircraft,'');assert.equal(view.selected,null);
  }finally{view.destroy();}
});

test('clock labels preserve dates across midnight and unknown values',()=>{
  assert.equal(clock(null),'—');assert.equal(clock(86460),'+1일 00:01:00');
});

test('FATO and decision charts drill into the exact assigned pad and recorded reason',async()=>{
  const data=summary();data.fatos=[{vertiport:'V2',fato:'F4',role:'both',planned_departures:3,planned_arrivals:4,assigned_departures:2,assigned_arrivals:4,takeoffs:2,landings:3,terminal_wait_s:120,protected_s:500}];
  data.decisions={total:4,fato_reassignments:1,hold_reasons:[{reason:'교차 경로',count:2}],recent:[]};
  const {view,calls}=make(url=>{
    if(url.includes('/flows?'))return {available:true,health:{written:1,dropped:0,pending:0},rows:[]};
    if(url.includes('records'))return {records:[]};
    if(url.includes('/sorties?'))return {meta:data.meta,rows:[],page:1,pages:1,total:0};
    return data;
  });
  try{
    await settle();view.open('fatos');await settle();
    assert.match(view.content.textContent,/이착륙 공용/);
    view.content.querySelector('.oa-rank-row').click();await settle();
    assert.equal(view.filters.fato,'F4');assert.equal(view.filters.vertiport,'V2');
    assert.ok(calls.some(url=>url.includes('fato=F4')));
    view.open('flows');await settle();assert.match(view.content.textContent,/데이터 수신·송신 이력/);
    view.content.querySelector('.oa-rank-row').click();await settle();
    assert.equal(view.filters.decision_reason,'교차 경로');
  }finally{view.destroy();}
});
