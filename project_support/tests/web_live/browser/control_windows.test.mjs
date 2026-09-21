import {readFileSync} from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';
import {repeatControlViews} from '../../../../user_application/web/control_windows.js';
test('reopening a scenario control adds views without restarting or stopping the scenario',async()=>{
 let opens=0,views=0,stops=0;const source={root:null,async open(){opens++;this.root={dataset:{}};},close(){stops++;}};
 const group=repeatControlViews({source,createViews:()=>({open(){views++;},destroy(){}})});await source.open();await source.open();assert.equal(opens,1);assert.equal(views,2);group.destroy();assert.equal(stops,0);
});

test('scenario mirror owners all dispose after the native root changes',async()=>{
 let disposed=0;const source={root:null,async open(){this.root={dataset:{}};}};
 const group=repeatControlViews({source,createViews:()=>({open(){},destroy(){disposed++;}})});
 await source.open();source.root=null;await source.open();group.destroy();assert.equal(disposed,2);
});

test('both replay consoles stay on the map, not in a floating window',()=>{
 // SettingsWindows hides the template it repeats, so repeating the single
 // flight console took the bar off the top of the map and reopened it as a
 // panel to drag around. The multi-flight console has always stayed put; this
 // one reads as the same control and belongs in the same place.
 const launchers=readFileSync(new URL('../../../../user_application/web/window_launchers.js',import.meta.url),'utf8');
 assert.doesNotMatch(launchers,/repeatFlightViews/,'the flight console is not repeated into a window');
 assert.doesNotMatch(launchers,/from '\.\/control_windows\.js'/,'and its module is not imported for that');
 // Both bars are laid out the same way: full width under the clock, centred.
 const flight=readFileSync(new URL('../../../../user_application/web/flight_control_bar.css',import.meta.url),'utf8');
 const scenario=readFileSync(new URL('../../../../user_application/web/scenario_control.css',import.meta.url),'utf8');
 const place=(css,selector)=>{
  const at=css.indexOf(selector+'{');
  assert.ok(at>=0,selector+' has no rule');
  const block=css.slice(at+selector.length+1,css.indexOf('}',at));
  const declared=new Map(block.split(';').map(part=>{
   const colon=part.indexOf(':');
   return colon<0?['','']:[part.slice(0,colon).trim(),part.slice(colon+1).trim()];
  }));
  return Object.fromEntries(['position','top','left','right','justify-content']
   .map(key=>[key,declared.get(key)]));
 };
 const one=place(flight,'.flight-console'),many=place(scenario,'.scenario-console');
 assert.deepEqual(one,many,'the single-flight bar sits exactly where the multi-flight bar sits');
 assert.equal(one.position,'fixed');
 assert.equal(one.top,'calc(var(--edge) + var(--top-bar) + 6px)','under the clock, not at the bottom');
 assert.equal(one['justify-content'],'center');
});
