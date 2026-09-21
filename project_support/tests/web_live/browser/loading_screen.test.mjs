import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LoadingPhases} from '../../../../user_application/web/loading.js';
const {LoadingScreen}=await import('../../../../user_application/web/loading_screen.js').catch(()=>({}));

function element(){return {hidden:false,dataset:{},attributes:{},textContent:'',style:{setProperty(k,v){this[k]=v;}},setAttribute(k,v){this.attributes[k]=String(v);}};}
function setup(){
  const root=element(),progress=element(),status=element(),retry=element(),frames=new Map();
  let time=0,id=0,visible=true;
  assert.equal(typeof LoadingScreen,'function');
  const screen=new LoadingScreen({root,progress,status,retry,now:()=>time,isVisible:()=>visible,
    requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:key=>frames.delete(key)});
  function advance(ms){while(ms>0){const dt=Math.min(16,ms);time+=dt;ms-=dt;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(time);}}
  function reach(phase){for(let i=0;root.dataset.phase!==phase && i<250;i++)advance(16);assert.equal(root.dataset.phase,phase);}
  return {screen,root,progress,status,retry,frames,advance,reach,setVisible:v=>{visible=v;}};
}

test('letter fill is bounded by actual work, with truthful accessible progress',()=>{
  const {screen,progress}=setup();
  screen.paint(80,45);assert.equal(progress.style['--loading-progress'],'45%');
  assert.equal(progress.attributes['aria-valuenow'],'45');
  screen.paint(99.99,100);assert.equal(progress.attributes['aria-valuenow'],'99');
  screen.paint(NaN,30);assert.equal(progress.style['--loading-progress'],'0%');
  screen.paint(-5,30);assert.equal(progress.attributes['aria-valuenow'],'0');
});

test('visible percent uses the same whole completed percentage as accessible progress',()=>{
  const {screen,progress}=setup();
  screen.paint(73.99,62.45);
  assert.equal(progress.attributes['data-percent'],'62');
  assert.equal(progress.attributes['data-percent'],progress.attributes['aria-valuenow']);
  screen.finish(100,'준비 완료',{reducedMotion:true});
  assert.equal(progress.attributes['data-percent'],'100');
});

test('repeated completion cannot restart the hold, fade or entry flight',()=>{
  const {screen,root,advance,reach}=setup();let entries=0;
  const options={onLeave:()=>{entries++;}};
  screen.finish(100,'준비 완료',options);reach('ready');advance(800);
  screen.finish(100,'늦은 응답',options);advance(100);
  assert.equal(root.dataset.phase,'leaving');assert.equal(entries,1);
  screen.finish(100,'늦은 응답',options);advance(900);
  screen.finish(100,'늦은 응답',options);advance(3000);
  assert.equal(root.hidden,true);assert.equal(entries,1);
});

test('a synchronous entry failure keeps retry visible without rescheduling its cancelled frame',()=>{
  const {screen,root,retry,frames,advance,reach}=setup();
  screen.finish(100,'준비 완료',{onLeave:()=>{throw new Error('context lost');}});
  reach('ready');advance(900);advance(3000);
  assert.equal(root.dataset.phase,'error');assert.equal(root.hidden,false);
  assert.equal(retry.hidden,false);assert.equal(frames.size,0);
});

test('entry callback disposal and explicit failure cannot reschedule cancelled frames',()=>{
  for(const action of ['destroy','fail']){
    const {screen,root,frames,advance,reach}=setup();
    screen.finish(100,'준비 완료',{onLeave:()=>screen[action]('렌더 오류',65)});
    reach('ready');advance(900);
    assert.equal(frames.size,0);assert.equal(root.hidden,false);
  }
});

test('an asynchronous entry rejection restores retry even after the veil is hidden',async()=>{
  for(const delay of [0,900]){
    const {screen,root,retry,frames,advance,reach}=setup();let rejectEntry;
    const entry=new Promise((_,reject)=>{rejectEntry=reject;});
    screen.finish(100,'준비 완료',{onLeave:()=>entry});
    reach('ready');advance(900+delay);rejectEntry(new Error('render failure'));
    await Promise.resolve();advance(3000);
    assert.equal(root.dataset.phase,'error');assert.equal(root.hidden,false);
    assert.equal(retry.hidden,false);assert.equal(frames.size,0);
  }
});

test('a disposed screen ignores a late entry rejection',async()=>{
  const {screen,root,retry,advance,reach}=setup();let rejectEntry;
  screen.finish(100,'준비 완료',{onLeave:()=>new Promise((_,reject)=>{rejectEntry=reject;})});
  reach('ready');advance(900);screen.destroy();rejectEntry(new Error('late'));
  await Promise.resolve();assert.equal(retry.hidden,true);assert.equal(root.dataset.phase,'leaving');
});

test('fast startup visibly finishes filling before a complete hold and a long hand-over fade',()=>{
  const {screen,root,progress,advance,reach}=setup();
  screen.paint(20,70);screen.finish(100,'준비 완료');
  assert.equal(progress.attributes['aria-valuenow'],'20');assert.equal(root.dataset.phase,'settling');
  advance(200);const middle=Number(progress.attributes['aria-valuenow']);assert.ok(middle>20 && middle<100);
  reach('ready');assert.equal(progress.attributes['aria-valuenow'],'100');assert.equal(root.hidden,false);
  advance(899);assert.equal(root.dataset.phase,'ready');assert.equal(root.hidden,false);
  advance(1);assert.equal(root.dataset.phase,'leaving');
  advance(899);assert.equal(root.hidden,false,'the veil takes its time so the map is revealed, not cut to');
  advance(1);assert.equal(root.hidden,true);
});

test('the map is told to begin its entry exactly once, as the veil starts lifting',()=>{
  const {screen,root,advance,reach}=setup();
  const started=[];
  screen.finish(100,'준비 완료',{onLeave:()=>started.push(root.dataset.phase)});
  reach('ready');
  assert.deepEqual(started,[],'nothing moves while the completion is still being read');
  advance(900);
  assert.deepEqual(started,['leaving'],'the flight starts with the fade, so the map is already moving when seen');
  advance(2000);
  assert.equal(started.length,1,'and only once');
});

test('reduced motion still hands the map its arrival, with a shorter hold and fade',()=>{
  const {screen,root,advance}=setup();
  const started=[];
  screen.finish(100,'완료',{reducedMotion:true,onLeave:()=>started.push(root.dataset.phase)});
  advance(1999);assert.equal(root.hidden,false);assert.deepEqual(started,[]);
  advance(1);assert.deepEqual(started,['leaving'],'the map is told to arrive, not skipped');
  assert.equal(root.hidden,false,'and the veil still lifts rather than vanishing');
  advance(399);assert.equal(root.hidden,false);
  advance(1);assert.equal(root.hidden,true);
});

test('partial startup fills only completed work and never claims 100%',()=>{
  const {screen,root,progress,reach,status}=setup();
  screen.finish(70,'일부 연결 실패 — 제한 모드로 시작');
  reach('ready');assert.equal(progress.attributes['aria-valuenow'],'70');assert.equal(root.hidden,false);
  assert.match(status.textContent,/제한 모드/);
});

test('errors interrupt fill or fade and queued callbacks cannot hide the retry',()=>{
  for(const phase of ['settling','leaving']){
    const {screen,root,progress,frames,retry,status,reach,advance}=setup();
    screen.finish(100,'준비 완료');reach(phase);const late=[...frames.values()][0];
    screen.fail('렌더링 실패',70);late(5000);advance(3000);
    assert.equal(root.hidden,false);assert.equal(root.dataset.phase,'error');assert.equal(retry.hidden,false);
    assert.equal(progress.attributes['aria-valuenow'],'70');assert.match(status.textContent,/렌더링 실패/);
    screen.paint(100,100);assert.equal(progress.attributes['aria-valuenow'],'70');
  }
});

test('reduced motion skips the fill animation but still shows the full text for 2000ms',()=>{
  const {screen,root,progress,advance}=setup();screen.finish(100,'완료',{reducedMotion:true});
  assert.equal(progress.attributes['aria-valuenow'],'100');assert.equal(root.hidden,false);
  advance(2000);assert.equal(root.dataset.phase,'leaving','the text was read, then the veil lifts');
  advance(399);assert.equal(root.hidden,false);advance(1);assert.equal(root.hidden,true);
});

test('hidden tabs do not consume the visible completion hold; disposal cancels callbacks',()=>{
  const a=setup();a.screen.finish(100,'완료',{reducedMotion:true});a.setVisible(false);a.advance(5000);
  assert.equal(a.root.hidden,false);a.setVisible(true);a.advance(2399);assert.equal(a.root.hidden,false);a.advance(1);assert.equal(a.root.hidden,true);
  const b=setup();b.screen.finish(100,'완료');const late=[...b.frames.values()][0];b.screen.destroy();late(5000);
  assert.equal(b.frames.size,0);assert.equal(b.root.hidden,false);
});

test('late successful API work cannot overwrite a render failure during boot',async()=>{
  const {screen,root,status,retry}=setup();
  const phases=new LoadingPhases(['globe','assets','snapshot']);
  const report=(key,message)=>{phases.complete(key);screen.setStatus(message);};
  report('globe','서버 확인 중');
  phases.fail('globe','렌더 오류');screen.fail('렌더 오류',phases.percent);
  await Promise.resolve();report('assets','자산 수신');report('snapshot','서버 상태 수신');
  screen.finish(phases.percent,'준비 완료');
  assert.equal(phases.ready,false);assert.equal(root.hidden,false);assert.equal(retry.hidden,false);
  assert.equal(status.textContent,'렌더 오류');
  const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
  assert.match(app,/function report\(key, message\) \{phases.complete\(key\);loadingScreen.setStatus\(message\);\}/);
});

test('loading markup retains the brand and one accessible letter progress indicator',()=>{
  const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
  assert.match(html,/<h1[^>]*id="loading-title"[^>]*><picture>[\s\S]*?<img[^>]*class="loading-logo"[^>]*alt="AERODT"[^>]*><\/picture><\/h1>/);
  assert.match(html,/id="loading-progress"[^>]*role="progressbar"/);
  assert.match(html,/class="twinning-fill"[^>]*>TWINNING<\/span>/);
  assert.doesNotMatch(html,/id="loading-bar"|id="loading-percent"|AERO TWINNING/);
  assert.match(html,/id="loading-step"[^>]*role="status"/);
});

test('loading accents use teal, sky and lilac while the glint follows real progress',()=>{
  const css=readFileSync(new URL('../../../../user_application/web/loading.css',import.meta.url),'utf8');
  for(const token of ['--loading-teal','--loading-sky','--loading-lilac'])assert.ok(css.includes(`var(${token})`),token);
  assert.match(css,/calc\(var\(--loading-progress\) - 1%\)/);
  assert.doesNotMatch(css,/animation:[^;]*infinite/);
});

test('loading logo uses the original aspect ratio and no added image backing',()=>{
  const css=readFileSync(new URL('../../../../user_application/web/loading.css',import.meta.url),'utf8');
  const logo=css.match(/\.loading-logo\s*\{([^}]+)\}/)[1];
  assert.match(logo,/width:100%/);assert.match(logo,/height:auto/);
  assert.doesNotMatch(logo,/background:|filter:/);
});
