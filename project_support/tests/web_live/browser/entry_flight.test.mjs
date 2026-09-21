import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ENTRY, entryStart, planEntry, entryView,entryZoomProgress,ENTRY_BRAKE_START,ENTRY_MAX_FRAME_MS} from '../../../../digital_twin/visualization/web/entry_flight.js';

const home = {longitude: 126.978, latitude: 37.5665, height: 120000};

test('initial placement and first animation frame share the exact distant view in both motion modes',async()=>{
 for(const reducedMotion of [false,true]){
  const C={Cartesian3:{fromDegrees:(longitude,latitude,height)=>({longitude,latitude,height})}},views=[];
  const camera={setView:view=>views.push(view)},plan=planEntry(home,{reducedMotion});
  ENTRY.placeStart(C,camera,plan);
  const abort=new AbortController();
  const pending=ENTRY.fly(C,camera,home,{reducedMotion,signal:abort.signal,requestFrame:()=>1,cancelFrame:()=>{}});
  assert.deepEqual(views[0],views[1]);assert.ok(views[0].destination.height>20000000);
  abort.abort();await pending;
 }
});

test('startup prepares the far view rather than rendering Seoul behind the loading screen',()=>{
 const read=path=>readFileSync(new URL(`../../../../${path}`,import.meta.url),'utf8');
 const globe=read('digital_twin/visualization/web/globe.js'),app=read('user_application/web/app.js');
 const constructor=globe.slice(globe.indexOf('constructor('),globe.indexOf('  async imagery()'));
 assert.doesNotMatch(constructor,/this\.reset\(true\)/);
 assert.match(constructor,/ENTRY\.placeStart\(C, v.camera, planEntry\(HOME_VIEW,\{reducedMotion\}\)\)/);
 assert.ok(app.indexOf('const reducedMotion=')<app.indexOf('const globe=new LiveGlobe'));
 assert.match(app,/'globe',\{reducedMotion,onHover:/);
 assert.match(app,/onLeave:\(\)=>domainChooser\.show\(\)/,
  'loading hands over to explicit domain choice, not a Seoul flight');
});

test('the entry begins far enough out to see the whole Earth, off to one side of the destination', () => {
  const start = entryStart(home);
  assert.ok(start.height > 6371000 * 2, 'beyond two Earth radii, so the globe reads as a globe');
  assert.ok(Math.abs(start.longitude - home.longitude) > 10, 'off to the side, so the Earth turns under the fall');
  assert.ok(start.latitude < home.latitude, 'and below it, so Korea comes up into view');
  assert.ok(Math.abs(start.latitude) < 85 && Math.abs(start.longitude) <= 180, 'a real place on the globe');
});

test('the camera-only arrival returns to the original short Seoul city-wide view', () => {
  const plan = planEntry(home);
  assert.deepEqual(plan.destination, home);
  assert.deepEqual(plan.start, entryStart(home));
  assert.equal(plan.duration,6.4/1.5,'1.5 times the original camera-only speed');
  assert.equal(plan.orientation.pitch, -Math.PI / 2, 'looking straight down at both ends');
  assert.equal(plan.orientation.heading, 0);
  // The arrival from the globe is the point of the entry, so reduced motion
  // keeps it and only drops the sideways sweep, not viewing time.
  const gentle = planEntry(home, {reducedMotion: true});
  assert.equal(gentle.start.height, plan.start.height, 'still begins with the whole Earth in frame');
  assert.equal(gentle.start.longitude, home.longitude, 'straight above, with no sideways sweep');
  assert.equal(gentle.start.latitude, home.latitude);
  assert.ok(gentle.duration > 0 && gentle.duration <= plan.duration, 'and arrives sooner');
});

function flightHarness(options={}){
 const C={Cartesian3:{fromDegrees:(longitude,latitude,height)=>({longitude,latitude,height})}};
 const views=[],progress=[],frames=new Map();let time=0,id=0;
 const camera={frustum:{get fov(){return 1;},set fov(_v){throw new Error('the entry must not change FOV');}},
  setView(v){views.push(v.destination);},flyTo(){throw new Error('segmented flight must not return');}};
 const control=new AbortController();
 const pending=ENTRY.fly(C,camera,home,{onProgress:t=>progress.push(t),signal:control.signal,
  requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:i=>frames.delete(i),now:()=>time,...options});
 return {pending,views,progress,control,frames,step(dt=50){time+=dt;const work=[...frames.values()];frames.clear();for(const fn of work)fn(time);},
  advance(ms){while(ms>0){const dt=Math.min(ms,ENTRY_MAX_FRAME_MS);this.step(dt);ms-=dt;}}};
}
test('one continuous frame clock reaches Seoul and releases its frame on completion',async()=>{
 const h=flightHarness();assert.deepEqual(h.views[0],entryStart(home));
 h.advance(6400/1.5-1);
 assert.ok(h.progress.at(-1)<1);assert.equal(h.frames.size,1);
 h.step(1);
 assert.equal(await h.pending,'complete');assert.deepEqual(h.views.at(-1),planEntry(home).destination);
 assert.equal(h.progress.at(-1),1);assert.equal(h.frames.size,0);
});
test('1.5x playback follows exactly the same path at the correspondingly advanced time',async()=>{
 const h=flightHarness();h.advance(1600);
 assert.ok(Math.abs(h.progress.at(-1)-.375)<1e-12);
 assert.deepEqual(h.views.at(-1),entryView(planEntry(home),.375));
 h.control.abort();await h.pending;
});
test('steady logarithmic zoom eases down monotonically to zero speed in the final 30 percent',()=>{
 const plan=planEntry(home),expected=Math.log(home.height/plan.start.height)/1000/(ENTRY_BRAKE_START+(1-ENTRY_BRAKE_START)/2);
 let previous=plan.start.height;
 let previousSpeed=Infinity;
 for(let i=1;i<=1000;i++){
  const height=entryView(plan,i/1000).height;
  const speed=-Math.log(height/previous);
  assert.ok(height<previous);
  if(i<=ENTRY_BRAKE_START*1000)assert.ok(Math.abs(-speed-expected)<1e-12);
  else {assert.ok(speed<=previousSpeed+1e-12);previousSpeed=speed;}
  previous=height;
 }
 assert.ok(previousSpeed<Math.abs(expected)*.0001,'the last step is imperceptible, not a hard stop');
 assert.deepEqual(entryView(plan,1),home);
});

test('brake joins with continuous velocity and acceleration and never overshoots',()=>{
 const h=1e-5,a=ENTRY_BRAKE_START,p=entryZoomProgress;
 const left=(p(a)-p(a-h))/h,right=(p(a+h)-p(a))/h;
 assert.ok(Math.abs(left-right)<1e-6);
 assert.ok(Math.abs((p(a+h)-2*p(a)+p(a-h))/(h*h))<.002);
 assert.ok((p(1)-p(1-h))/h<1e-7);
 assert.ok(Math.abs((p(1)-2*p(1-h)+p(1-2*h))/(h*h))<.002);
 for(let i=0;i<=1000;i++)assert.ok(p(i/1000)>=0&&p(i/1000)<=1);
});

test('a long visible shader / scheduling stall cannot skip the cushioned arrival',async()=>{
 const h=flightHarness();h.advance(3800);const before=h.progress.at(-1);
 h.step(1200);
 assert.ok(h.progress.at(-1)-before<=ENTRY_MAX_FRAME_MS/(planEntry(home).duration*1000)+1e-9);
 assert.ok(h.progress.at(-1)<1);h.advance(1000);
 assert.equal(await h.pending,'complete');assert.deepEqual(h.views.at(-1),home);
});
test('the camera path needs no model catalogue or staging definitions',()=>{
 const plan=planEntry(home);
 assert.equal('cameos' in plan,false);
 const source=readFileSync(new URL('../../../../digital_twin/visualization/web/entry_flight.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/ENTRY_SCENES|assetId|displaySize|fromGltfAsync/);
});
test('the arrival stops above Seoul without descending to street or campus level',()=>{
 const plan=planEntry(home);
 assert.equal(plan.destination.height,120000);
 assert.equal(entryView(plan,.25).longitude,home.longitude);
 assert.equal(entryView(plan,.25).latitude,home.latitude);
});
test('the veil fades over the flight rather than cutting away', () => {
  const css = readFileSync(new URL('../../../../user_application/web/loading.css', import.meta.url), 'utf8');
  const leaving = css.match(/#loading\[data-phase=leaving\]\{([^}]+)\}/)?.[1] ?? '';
  assert.match(leaving, /opacity:0/);
  const shell = css.match(/#loading\s*\{([^}]+)\}/)?.[1] ?? '';
  const duration = Number(shell.match(/transition:opacity (\d+)ms/)?.[1] ?? 0);
  assert.ok(duration >= 800, `the fade lasts long enough to feel like a hand-over: ${duration}ms`);
  assert.match(shell, /position:fixed/);
  assert.match(shell, /inset:0/, 'the veil covers the viewport throughout the hand-over');
  assert.match(shell, /opacity:1/, 'the prepared map starts behind an opaque veil');
  assert.match(leaving, /pointer-events:none/, 'the departing veil does not intercept map input');
});

test('teardown aborts the camera clock without a late frame resurrecting it',async()=>{
 const h=flightHarness();h.step();const late=[...h.frames.values()][0];
 h.control.abort();assert.equal(await h.pending,'cancel');const count=h.views.length;
 late(30000);assert.equal(h.views.length,count);assert.equal(h.frames.size,0);
});
test('hidden time pauses the film, then visible playback resumes on the same clock',async()=>{
 const visibility=new EventTarget();visibility.hidden=false;const h=flightHarness({visibility});
 h.step(20);const before=h.progress.at(-1);visibility.hidden=true;h.step(60000);
 assert.equal(h.progress.at(-1),before);visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));h.step(20);
 assert.ok(h.progress.at(-1)-before<=20/(planEntry(home).duration*1000)+1e-9);
 h.control.abort();await h.pending;
});
test('reduced motion keeps the same continuous arrival but removes lateral travel',async()=>{
 const h=flightHarness({reducedMotion:true});h.advance(6400/1.5+1);
 assert.equal(await h.pending,'complete');assert.deepEqual(h.views.at(-1),planEntry(home).destination);
 assert.ok(h.views.every(v=>Math.abs(v.longitude-home.longitude)<1e-10&&Math.abs(v.latitude-home.latitude)<1e-10));
});

