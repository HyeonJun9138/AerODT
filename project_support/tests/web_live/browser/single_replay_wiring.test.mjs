import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../../../../',import.meta.url);
const app=readFileSync(new URL('user_application/web/app.js',root),'utf8');
test('single flight panel wires its cockpit action to enterSingle',()=>{
 const block=app.slice(app.indexOf('let planPanel=createPanel(PlanPanel,'),app.indexOf("window.addEventListener('pagehide',()=>planPanel.destroy()"));
 assert.match(block,/onCockpit:[\s\S]*?enterSingle\(/);
});
test('MFD is below application drawers and prediction windows',()=>{
 const css=readFileSync(new URL('user_application/web/cockpit_avionics.css',root),'utf8');
 const rule=css.match(/\.cockpit-instruments\.cockpit-projected\{([^}]+)\}/)[1];
 assert.ok(Number(rule.match(/z-index:(\d+)/)[1])<5);
});
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
test('right click on a single flight reaches inspection without entity registry entry',()=>{
 let opened=null;const flight={plan:{},sample:{}};
 const g={pickInteraction:()=>({id:'single'}),flightLayer:{pick:()=>flight},onFlightPick:(f,p,o)=>opened={f,o}};
 LiveGlobe.prototype.handleRightClick.call(g,{x:5,y:6});
 assert.equal(opened.f,flight);assert.equal(opened.o.detailsOnly,true);
});

test('inactive replay samples cannot overwrite the selected map replay',()=>{
 const app=readFileSync('user_application/web/app.js','utf-8');
 assert.match(app,/onSample:\(plan,sample\)=>\{if\(planPanel!==plan\)return;liveGlobe\?\.moveFlight\(sample\)/);
 assert.match(app,/onPlan:\(owner,plan\)=>\{if\(plan\)\{planPanel=owner/);
});
