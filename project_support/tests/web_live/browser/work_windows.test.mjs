import test from 'node:test';import assert from 'node:assert/strict';
import {WorkWindows} from '../../../../user_application/web/work_windows.js';
import {FakeElement} from './fake_dom.mjs';
const fixture=()=>{const entries=[];const document={createElement:t=>new FakeElement(t),querySelectorAll:()=>[]};const workspace={create(o){const node=new FakeElement('section'),entry={...o,node};entries.push(entry);return {node,entry};},raise(){}};return {entries,document,workspace};};
test('each launch owns a fresh controller and closing a form does not stop its simulation',()=>{
 const f=fixture();let stopped=0,closed=0;const controller=()=>({render(body){this.body=body;body.textContent='new';},close(){closed++;},destroy(){stopped++;}});
 const w=new WorkWindows({...f,factories:{simulation:controller}});const a=w.open('simulation'),b=w.open('simulation');a.controller.body.textContent='first draft';assert.notEqual(a.controller,b.controller);assert.equal(b.controller.body.textContent,'new');f.entries[0].onClose();assert.equal(closed,1);assert.equal(stopped,0);assert.equal(w.rows.size,1);w.destroy();assert.equal(stopped,2);
});
test('snapshot fanout updates all open monitors with the same immutable input reference',()=>{
 const f=fixture(),seen=[];const w=new WorkWindows({...f,factories:{live:()=>({render(){},observe(s){seen.push(s);}})}});w.open('live');w.open('live');const s=Object.freeze({entities:[]});w.observe(s);assert.deepEqual(seen,[s,s]);
});

test('single work window preserves its draft on repeated menu activation',()=>{
 const f=fixture();let shown=0;f.workspace.reveal=()=>shown++;const w=new WorkWindows({...f,singleton:true,factories:{simulation:()=>({render(body){body.textContent='draft';}})}});
 const a=w.open('simulation');a.body.textContent='edited';assert.equal(w.open('simulation'),a);assert.equal(a.body.textContent,'edited');assert.equal(shown,1);
});

test('unstyled work content stays invisible until every stylesheet has loaded',()=>{
 const f=fixture();const links=['/base.css','/forms.css'].map(href=>{const n=new FakeElement('link');n.setAttribute('href',href);return n;});f.document.querySelectorAll=()=>links;
 let visibleDuringRender;const w=new WorkWindows({...f,factories:{simulation:()=>({render(body){visibleDuringRender=body.style.visibility;}})}});
 const row=w.open('simulation'),styles=row.node.querySelectorAll('link');assert.equal(visibleDuringRender,'hidden');assert.equal(row.body.style.visibility,'hidden');
 styles[0].onload();assert.equal(row.body.style.visibility,'hidden');styles[1].onload();assert.equal(row.body.style.visibility,'visible');
});
test('stylesheet failure never reveals raw simulation controls',()=>{
 const f=fixture();const source=new FakeElement('link');source.setAttribute('href','/failed.css');f.document.querySelectorAll=()=>[source];
 const w=new WorkWindows({...f,factories:{simulation:()=>({render(){}})}}),row=w.open('simulation');row.node.querySelector('link').onerror();assert.equal(row.body.style.visibility,'hidden');assert.match(row.node.textContent,/스타일을 불러오지 못했습니다/);
});
