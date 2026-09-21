import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('single replay selection closes old details silently and opens only the summary',()=>{
  const source=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const callback=source.match(/onDetails:(\(entity,state,\{reopen=false\}=\{\}\)=>\{[\s\S]*?)\n    \},\n    onSnapshot:/)[1]+'\n}';
  const shown=[],summaries=[],closed=[];
  const entity={entity_id:'replay:one'};
  const selectionWindows={windows:new Map([['old',{close:options=>closed.push(options)}]]),open:()=>assert.fail('must not auto-open a window')};
  const handler=new Function('selectionPanel','aircraftDashboard','selectionWindows','aircraftCamera','followMission','replayPresentation',`let detailDrawerOpen=true;return ${callback}`)(
    {show:e=>shown.push(e),text:()=>{},setTrajectory:()=>{}},
    {show:e=>summaries.push(e)},selectionWindows,null,()=>{},{});
  handler(entity,{sample:{time_s:0}},{reopen:true});
  assert.deepEqual(shown,[null]);assert.deepEqual(summaries,[entity]);
  assert.deepEqual(closed,[{notify:false}]);
  handler(entity,{sample:{time_s:1}});
  assert.deepEqual(shown,[null],'telemetry must not reopen the left drawer');
  assert.equal(summaries.length,2);
});

test('focus mode preserves cockpit instruments and the controls popup anchors above the entire summary',()=>{
  const web=new URL('../../../../user_application/web/',import.meta.url);
  const styles=readFileSync(new URL('styles.css',web),'utf8');
  const rule=styles.match(/body\[data-focus\]>[^\n]+/)[0];
  assert.ok(rule.includes(':not(.cockpit-instruments)'));
  assert.ok(rule.includes('display:none!important'));
  const dock=readFileSync(new URL('aircraft_dashboard.css',web),'utf8');
  assert.match(dock,/grid-area:actions;position:static/);
  assert.match(dock,/\.adb-surface\{position:relative\}/);
  assert.match(dock,/\.ww-shelf\{bottom:0;/);
  assert.doesNotMatch(dock,/\.ww-shelf\{bottom:calc\(var\(--aircraft-dashboard-height/);
});

test('side docks stay on the bottom independently of summary height',()=>{
 const css=readFileSync(new URL('../../../../user_application/web/aircraft_dashboard.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/#attribution\{bottom:calc\(var\(--aircraft-dashboard-height/);
 assert.match(css,/#attribution\{bottom:0;right:8px/);
 assert.match(css,/#camera\{right:8px;bottom:56px/);
 assert.match(css,/@media\(min-width:1601px\)/);
 assert.match(css,/right:320px/);
});

test('bottom chrome shares one opaque colour and all provider credits live in the disclosure',()=>{
 const web=new URL('../../../../user_application/web/',import.meta.url);
 const html=readFileSync(new URL('index.html',web),'utf8');
 const css=readFileSync(new URL('styles.css',web),'utf8');
 const dock=readFileSync(new URL('aircraft_dashboard.css',web),'utf8');
 assert.match(html,/<details class="attribution-details"><summary>Data attribution<\/summary><div class="attribution-popover"><div id="map-credits"/);
 // One opaque colour, and the grey the glass panels along the top render at
 // over the map (measured mean #556067) rather than a navy of its own.
 assert.match(css,/--chrome-surface:#556067/);
 assert.doesNotMatch(css,/--chrome-surface:#344b58/);
 assert.match(css,/#attribution,#camera\{background:var\(--chrome-surface\)/);
 assert.match(css,/#attribution\{flex-wrap:nowrap/);
 assert.doesNotMatch(dock,/#attribution[^\n]*flex-wrap:wrap/);
 assert.doesNotMatch(dock,/#attribution \.maker span\{display:none/);
});
