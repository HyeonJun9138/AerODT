import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {FlightControlBar, altitudeProfile} from '../../../../user_application/web/flight_control_bar.js';

const PLAN = {vehicle:{id:'UAM-TEST',passengers:2,capacity:4},departure:{name:'출발',gate:'G1'},arrival:{name:'도착',gate:'G2'},
  legs:['takeoff','cruise','landing'].map((stage,i)=>({stage,stage_label:stage,name:`구간 ${i}`,start_s:i*10,end_s:(i+1)*10,duration_s:10})),
  totals:{duration_s:30,flight_duration_s:30}};
const recorded = Array.from({length:31},(_,i)=>({time_s:i,position:{altitude_m:i<=15?i*10:(30-i)*10}}));
const sample = (t,index=0)=>({time_s:t,leg_index:index,stage_label:PLAN.legs[index].stage,leg_name:'시험 구간',
  color:'#ace',position:{altitude_m:50},heading_deg:45,speed_mps:10,battery_pct:80,tilt_deg:45,mode:'transition',
  remaining_s:30-t,distance_done_m:100,done:t>=30});
function harness(actions={}) {
  const host=new FakeElement('div'),view=new FlightControlBar({document:fakeDocument,host,actions});
  view.show(PLAN,{run_id:'test'},recorded,'test source');return {host,view};
}

test('profile size is bounded, includes endpoints and never creates another clock',()=>{
  const data=Array.from({length:20000},(_,i)=>({time_s:i,position:{altitude_m:100+Math.sin(i/100)*50}}));
  const profile=altitudeProfile(data);
  assert.ok(profile.count<=161);assert.equal(profile.x(0),4);assert.equal(profile.x(19999),316);
  assert.match(profile.path,/^M4\.00,/);assert.match(profile.path,/L316\.00,/);
  assert.ok(profile.low>=50&&profile.high<=150);assert.equal(altitudeProfile([]),null);
  assert.doesNotMatch(altitudeProfile([{time_s:0,position:{altitude_m:0}}]).path,/NaN|Infinity/);
});

test('collapse is display-only and hidden contents are removed from keyboard navigation',()=>{
  let calls=0;const {view}=harness({toggle:()=>calls++});
  view.update(sample(12,1));const profile=view.profile;
  view.setCollapsed(true);
  assert.equal(view.content.inert,true);assert.equal(view.content.getAttribute('aria-hidden'),'true');
  assert.equal(view.collapseButton.getAttribute('aria-expanded'),'false');assert.equal(calls,0);
  view.update(sample(15,1));assert.match(view.clockText.textContent,/0:15/);
  view.playButton.click();assert.equal(calls,1,'compact bar can still pause/play');
  view.setCollapsed(false);assert.equal(view.content.inert,false);assert.equal(view.profile,profile);
});

test('Escape only folds this bar and moves focus out of the hidden body',()=>{
  const {view}=harness();let stopped=0,focused=0;
  view.content.contains=()=>true;view.collapseButton.focus=()=>focused++;
  view.root.onkeydown({key:'Escape',stopPropagation:()=>stopped++});
  assert.equal(stopped,1);assert.equal(focused,1);assert.equal(view.collapsed,true);
});

test('minimised, one flight collapses to the same row a whole day does',()=>{
  // A single flight being scrubbed and a day being replayed are the same kind
  // of thing to an operator, so they take the same shape.
  const {view,host}=harness();
  assert.equal(view.collapsed,false);
  view.collapseButton.click();
  assert.equal(view.collapsed,true);
  assert.equal(host.querySelector('#flight-console').getAttribute('data-collapsed'),'true');
  assert.equal(view.collapseButton.getAttribute('aria-label'),'비행 컨트롤 바 펼치기');
  for(const id of ['#flight-mini-stop','#flight-mini-play','#flight-mini-back','#flight-mini-forward',
    '#flight-mini-rate','#flight-mini-follow','#flight-mini-expand','#flight-mini-dismiss'])
    assert.ok(host.querySelector(id),`${id} is on the small row`);
  host.querySelector('#flight-mini-expand').click();
  assert.equal(view.collapsed,false);
  const css=readFileSync(new URL('../../../../user_application/web/flight_control_bar.css',import.meta.url),'utf8');
  assert.match(css,/\.flight-console\[data-collapsed=true\] \.flight-console-header\{display:none\}/);
  assert.match(css,/\.flight-console\[data-collapsed=true\] \.flight-mini\{display:flex\}/);
});

test('the right button on either speed button goes straight back to real time',()=>{
  // Stepping round the whole list to get back to ×1 is the sort of thing an
  // operator does while an aircraft is moving. The browser's own menu would
  // open over the map, so it is swallowed.
  const asked=[];
  const {view,host}=harness({resetRate:()=>asked.push('reset'),rate:()=>asked.push('step')});
  let prevented=0;
  const event={preventDefault:()=>prevented++};
  assert.equal(host.querySelector('#plan-rate').oncontextmenu(event),false);
  view.setCollapsed(true);
  host.querySelector('#flight-mini-rate').oncontextmenu(event);
  assert.deepEqual(asked,['reset','reset'],'both buttons, the same way back');
  assert.equal(prevented,2,'and no context menu over the map');
  host.querySelector('#flight-mini-rate').click();
  assert.deepEqual(asked,['reset','reset','step'],'the left button still steps');
});

test('the small row drives the same replay as the full one',()=>{
  const calls=[];
  const {view,host}=harness({toggle:()=>calls.push(['toggle']),skip:seconds=>calls.push(['skip',seconds]),
    rate:()=>calls.push(['rate']),stop:()=>calls.push(['stop']),follow:()=>calls.push(['follow'])});
  view.setCollapsed(true);
  host.querySelector('#flight-mini-play').click();
  host.querySelector('#flight-mini-back').click();
  host.querySelector('#flight-mini-forward').click();
  host.querySelector('#flight-mini-rate').click();
  host.querySelector('#flight-mini-stop').click();
  host.querySelector('#flight-mini-follow').click();
  assert.deepEqual(calls.map(call=>call[0]),['toggle','skip','skip','rate','stop','follow']);
  assert.deepEqual(calls.filter(call=>call[0]==='skip').map(call=>call[1]),[-10,10]);
  // And both say the same thing about what the replay is doing.
  view.transport({playing:true,speed:6,following:true});
  assert.equal(host.querySelector('#flight-mini-play').textContent,'⏸');
  assert.equal(host.querySelector('#flight-mini-rate').textContent,'×6');
  assert.equal(host.querySelector('#flight-mini-follow').getAttribute('aria-pressed'),'true');
  view.update(sample(15,1));
  assert.equal(host.querySelector('#flight-mini-clock').textContent,
    host.querySelector('#plan-clock').textContent,'one clock, shown twice');
});

test('phase buttons use callbacks, show temporal progress and support rewind/end',()=>{
  const asked=[];const {view,host}=harness({seek:t=>asked.push(t)});
  view.update(sample(15,1));const button=host.querySelector('#plan-leg-1');
  assert.equal(button.tagName,'BUTTON');assert.equal(button.getAttribute('aria-current'),'step');
  assert.equal(view.phaseProgress[1].getAttribute('style'),'width:50%');
  button.click();assert.deepEqual(asked,[10]);
  view.update(sample(2,0));assert.equal(button.getAttribute('data-state'),'next');
  assert.equal(button.getAttribute('aria-current'),null);assert.equal(view.phaseProgress[1].getAttribute('style'),'width:0%');
  view.update(sample(30,2));assert.ok(view.phaseButtons.every(b=>b.getAttribute('data-state')==='done'));
  assert.equal(view.stageTag.textContent,'운항 완료');
});

test('the replay console does not read out the vehicle; the vehicle does',()=>{
  // Height, speed, battery, tilt and the altitude trace were repeated here for
  // an aircraft that answers for itself when it is selected, and they made this
  // the widest thing on the screen.
  const {view,host}=harness();view.update(sample(15,1));
  for(const id of ['#plan-altitude','#plan-speed','#plan-battery','#plan-tilt-text','#plan-remaining','#flight-mode'])
    assert.equal(host.querySelector(id),null,`${id} is not the replay console's to show`);
  assert.equal(view.profile,undefined,'and no chart of its own');
  // What is left is the replay's own state: where it is, and in which phase.
  assert.equal(host.querySelector('#plan-clock').textContent,'0:15 / 0:30');
  assert.equal(host.querySelector('#flight-phase-count').textContent,'2 / 3');
});

test('a phase jump targets its first recorded sample rather than an earlier rounded boundary',()=>{
  const asked=[],{view}=harness({seek:t=>asked.push(t)});
  view.show(PLAN,{run_id:'sample-boundaries'},[
    {time_s:9.9,leg_index:0},{time_s:10.1,leg_index:1},{time_s:10.3,leg_index:1}], 'source');
  view.phaseButtons[1].click();assert.deepEqual(asked,[10.1]);
  view.phaseButtons[2].click();assert.deepEqual(asked,[10.1,20],'missing records retain the plan boundary fallback');
});

test('reopening the same run reuses DOM/profile; a new run replaces instead of duplicating',()=>{
  const {view,host}=harness();const root=view.root,run=view.run,profile=view.profile;
  view.setCollapsed(true);view.show(PLAN,run,recorded,'test source');
  assert.equal(view.root,root);assert.equal(view.profile,profile);assert.equal(view.collapsed,true);
  view.show({...PLAN},{run_id:'new'},recorded,'new source');
  assert.equal(host.children.length,1);assert.notEqual(view.root,root);assert.equal(view.collapsed,false);
  view.destroy();assert.equal(host.children.length,0);
});

test('unchanged samples do not reconstruct controls or phases',()=>{
  const {view}=harness(),button=view.phaseButtons[0];
  view.update(sample(3));let writes=0;
  const original=button.setAttribute.bind(button);button.setAttribute=(...args)=>{writes++;original(...args);};
  for(let i=0;i<100;i++)view.update(sample(3));
  assert.equal(writes,0);assert.equal(view.phaseButtons[0],button);
});

test('resizing a paused bar reveals the active phase and releases its observer',()=>{
  const observers=[];
  class Observer {
    constructor(callback){this.callback=callback;observers.push(this);}
    observe(node){this.node=node;}
    disconnect(){this.disconnected=true;}
  }
  const document={...fakeDocument,defaultView:{ResizeObserver:Observer}};
  const view=new FlightControlBar({document,host:new FakeElement('div')});
  view.show(PLAN,{run_id:'first'},recorded,'source');view.update(sample(15,1));
  view.timeline.clientWidth=300;view.timeline.scrollWidth=700;view.timeline.scrollLeft=0;
  view.timeline.getBoundingClientRect=()=>({left:0,right:300,width:300});
  view.phaseButtons[1].getBoundingClientRect=()=>({left:400,right:500,width:100});
  const scroll=[];view.timeline.scrollTo=options=>scroll.push(options.left);
  observers[0].callback();assert.deepEqual(scroll,[300]);
  view.setCollapsed(true);observers[0].callback();assert.equal(scroll.length,1);
  view.show(PLAN,{run_id:'second'},recorded,'source');assert.equal(observers[0].disconnected,true);
  view.destroy();assert.equal(observers[1].disconnected,true);
});

test('floating geometry is scoped, collapsible, keyboard accessible and motion-reduced',()=>{
  const css=readFileSync(new URL('../../../../user_application/web/flight_control_bar.css',import.meta.url),'utf8');
  assert.match(css,/\.flight-console\{position:fixed/);assert.match(css,/pointer-events:none/);
  assert.match(css,/grid-auto-flow:column/);assert.match(css,/\[data-collapsed=true\]/);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/:focus-visible/);
  assert.match(css,/order:3;flex-direction:row;flex:1 0 100%/,'narrow header status gets its own row');
});

test('the console sits on the line the day\'s console uses, in the same material',()=>{
  const css=readFileSync(new URL('../../../../user_application/web/flight_control_bar.css',import.meta.url),'utf8');
  const shell=readFileSync(new URL('../../../../user_application/web/styles.css',import.meta.url),'utf8');
  const day=readFileSync(new URL('../../../../user_application/web/scenario_control.css',import.meta.url),'utf8');
  // The same line under the target chips the scheduled day's console uses, the
  // same left edge, and it moves with the drawer just as that one does.
  assert.match(css,/\.flight-console\{[^}]*left:calc\(var\(--left-offset\) \+ var\(--edge\)\)/);
  assert.match(day,/\.scenario-console\{[^}]*left:calc\(var\(--left-offset\) \+ var\(--edge\)\)/,
    'the rule the day\'s console uses');
  assert.match(css,/\.flight-console\{[^}]*top:calc\(var\(--edge\) \+ var\(--top-bar\) \+ 6px\)/);
  assert.match(day,/\.scenario-console\{[^}]*top:calc\(var\(--edge\) \+ var\(--top-bar\) \+ 6px\)/);
  assert.match(css,/\.flight-console\{[^}]*justify-content:center/,'centred on that line, like the other');
  assert.match(css,/\.flight-console\{[^}]*transition:left \.22s ease/,'and slides with the drawer');
  assert.doesNotMatch(css,/--credits-reserve/,'nothing left down by the map credits');
  assert.doesNotMatch(css,/\.flight-console\{[^}]*bottom:/,'and nothing anchored to the bottom edge');
  assert.match(css,/\.flight-console-surface\{width:min\(880px,100%\)/,'and the surface caps its own width');
  // A narrow screen has no room beside the chips, so it spans the width below them.
  assert.match(css,/@media\(max-width:700px\)\{\.flight-console\{left:10px;right:10px;top:68px\}/);
  // Material: the shared glass, not a colour of its own.
  assert.match(css,/\.flight-console-surface\{[^}]*background:var\(--panel-glass\)/);
  assert.match(css,/\.flight-console-surface\{[^}]*border:1px solid var\(--glass-border\)/);
  assert.match(css,/\.flight-console-surface\{[^}]*border-radius:12px/);
  assert.doesNotMatch(css,/#233947|#132431/,'the old navy surface is gone');
  assert.doesNotMatch(css,/#a0cde61c/,'and so are its tinted rules');
});

test('single flight console exposes a cockpit action without changing playback',()=>{
 let calls=0;const {view}=harness({cockpit:()=>calls++});
 const button=view.root.querySelector('#flight-cockpit');assert.ok(button);button.click();assert.equal(calls,1);
});

test('one console on screen: a second panel takes the spot instead of stacking on it',()=>{
  // The plan editor and the copy inside the simulation window are two panels,
  // each mounting a bar with the same id in the same fixed spot. Stacked they
  // look like one, and dismissing the top one uncovers the next -- which reads
  // as a close button that does nothing.
  const host = new FakeElement('body');
  const bar = name => new FlightControlBar({document: fakeDocument, host,
    actions: {dismiss: () => made[name].destroy()}});
  const made = {};
  made.editor = bar('editor'); made.window = bar('window');

  made.editor.show(PLAN, {id: 1}, recorded, 'from the editor');
  assert.equal(host.children.length, 1);
  made.window.show(PLAN, {id: 2}, recorded, 'from the window');
  assert.equal(host.children.length, 1, 'the newer plan takes the spot, it does not pile on');
  assert.equal(made.editor.root, null, 'and the older console steps down');
  assert.ok(made.window.root);

  made.window.setCollapsed(true);
  made.window.root.querySelector('#flight-mini-dismiss').click();
  assert.equal(host.children.length, 0, 'closing leaves nothing underneath');
  assert.equal(made.window.root, null);

  // The panel that stepped down still owns its plan and can show it again.
  made.editor.show(PLAN, {id: 1}, recorded, 'from the editor');
  assert.equal(host.children.length, 1);
  made.editor.destroy();
  assert.equal(host.children.length, 0);
});

test('closing works from the expanded row as well as the minimised one',()=>{
  const host = new FakeElement('body');
  let closed = 0;
  const single = new FlightControlBar({document: fakeDocument, host,
    actions: {dismiss: () => {closed++; single.destroy();}}});
  single.show(PLAN, {id: 1}, recorded, 'source');
  single.root.querySelector('#flight-console-dismiss').click();
  assert.equal(closed, 1);
  assert.equal(host.children.length, 0);
});
