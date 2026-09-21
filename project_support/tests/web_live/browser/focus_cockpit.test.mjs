import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
// Execute the application's actual focus-mode callback with camera spies.
const body=source.match(/const focusMode=new FocusMode\(\{document,onChange:on=>\{([\s\S]*?)\n\}\}\)\.attach\(\);/)[1];
const change=new Function('aircraftDashboard','liveGlobe','on',body);
test('focus mode keeps the multi-flight cockpit and only changes dashboard visibility',()=>{
 const seen=[],globe={cockpit:{active:true,single:false},tracking:false,approaching:false,focus(){this.cockpit.active=false;seen.push('external');}};
 const dashboard={setFocusMode:on=>seen.push(on)};
 for(const on of [true,false,true,true])change(dashboard,globe,on);
 assert.deepEqual(seen,[true,false,true,true]);assert.equal(globe.cockpit.active,true);
 globe.cockpit.single=true;change(dashboard,globe,true);assert.equal(globe.cockpit.active,true);
});
test('an unfollowed external view starts following, but existing tracking and approach stay intact',()=>{
 for(const flags of [{},{tracking:true},{approaching:true}]){
  let followed=0;const globe={cockpit:{active:false},focus:()=>followed++,...flags};
  change({setFocusMode(){}},globe,true);assert.equal(followed,Object.keys(flags).length?0:1);
  change({setFocusMode(){}},globe,false);assert.equal(followed,Object.keys(flags).length?0:1);
 }
});
