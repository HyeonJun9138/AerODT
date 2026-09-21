import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {FocusMode} from '../../../../user_application/web/focus_mode.js';

const web=new URL('../../../../user_application/web/',import.meta.url);
const html=readFileSync(new URL('index.html',web),'utf8');
const styles=readFileSync(new URL('styles.css',web),'utf8');
const visual=new URL('../../../../digital_twin/visualization/web/',import.meta.url);
const source=readFileSync(new URL('selection_panel.js',web),'utf8').replace(/from '([^']+)'/g,(_,path)=>
  `from '${path.startsWith('/visualization/')?new URL(path.slice(15),visual).href:new URL(path,web).href}'`);
const {SelectionPanel}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function pageHarness(){
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new FakeElement('button')]));
  const listeners=[];
  const body=new FakeElement('body');
  const document={...fakeDocument,body,getElementById:id=>nodes[id] ?? null,
    addEventListener:(kind,handler,capture)=>listeners.push({kind,handler,capture}),
    removeEventListener:(kind,handler)=>{const at=listeners.findIndex(l=>l.kind===kind&&l.handler===handler);if(at>=0)listeners.splice(at,1);}};
  return {nodes,body,document,listeners,
    press:key=>{let stopped=false;const event={key,stopPropagation(){stopped=true;}};
      for(const l of listeners)if(l.kind==='keydown')l.handler(event);return stopped;}};
}

test('focus mode is one switch: the body says so, the round control reflects it, Escape leaves it',()=>{
  const page=pageHarness();
  const seen=[];
  const focus=new FocusMode({document:page.document,onChange:on=>seen.push(on)}).attach();
  const button=page.nodes['focus-exit'];
  assert.equal(focus.active,false);
  assert.equal(button.getAttribute('aria-pressed'),'false');
  assert.equal(page.body.getAttribute('data-focus'),null);
  button.click();
  assert.equal(focus.active,true);assert.deepEqual(seen,[true]);
  assert.equal(page.body.getAttribute('data-focus'),'on');
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.match(button.getAttribute('aria-label'),/해제/,'the control says what pressing it now does');
  assert.equal(page.press('Escape'),true,'Escape is swallowed so it cannot also drop the selection');
  assert.equal(focus.active,false);assert.equal(page.body.getAttribute('data-focus'),null);
  assert.deepEqual(seen,[true,false]);
  assert.equal(page.press('Escape'),false,'outside focus mode Escape belongs to whoever else wants it');
  focus.set(true);focus.destroy();
  assert.equal(page.body.getAttribute('data-focus'),null,'destroy cannot leave the page stuck with no panels');
  assert.equal(page.listeners.length,0);
});

test('focus mode leaves the map, the clock and the map credits, and nothing else',()=>{
  const rule=styles.match(/body\[data-focus\]>:not\(([^)]*)\)[^\n]*/)?.[0];
  assert.ok(rule,'a single rule hides the panels');
  for(const kept of ['#globe','#clock','#attribution','#loading'])
    assert.ok(rule.includes(`:not(${kept})`),`${kept} stays on screen`);
  assert.match(rule,/display:none!important/);
  assert.match(styles,/body\[data-focus\]\{--left-offset:0px\}/,'the clock recentres once the rail has gone');
  // Attribution is a condition of using the imagery, so it may be dimmed but
  // never removed. A test, because it is the one thing here that is not taste.
  assert.match(styles,/body\[data-focus\] #attribution\{opacity:/);
});

test('both consoles and the clock offer the same switch, and the way back is always drawn',()=>{
  assert.match(html,/id="focus-exit"[^>]*aria-pressed="false"/);
  assert.ok(html.indexOf('id="focus-exit"')>html.indexOf('id="state-time"'),'the round control sits beside the clock');
  assert.ok(html.indexOf('id="focus-exit"')<html.indexOf('id="clock"')+400,'and inside the clock bar, which focus mode keeps');
  const bar=readFileSync(new URL('flight_control_bar.js',web),'utf8');
  const scenario=readFileSync(new URL('domains/uam/operations/scenario_control.js',web),'utf8');
  for(const [name,text] of [['flight console',bar],['scenario console',scenario]])
    assert.ok(/focusMode|onFocusMode/.test(text),`${name} offers focus mode`);
  assert.match(bar,/id: 'flight-focus-mode'|'flight-focus-mode'/);
  assert.match(scenario,/scenario-focus-mode/);
  const app=readFileSync(new URL('app.js',web),'utf8');
  assert.match(app,/onFocusMode:\(\)=>focusMode\.set\(true\)/);
});

function panelHarness(){
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new FakeElement('div')]));
  for(const n of Object.values(nodes))n.focus=()=>{};
  let closed=0;
  const preview={close(){closed++;},onStatus(){}};
  const panel=Object.assign(Object.create(SelectionPanel.prototype),{$:id=>nodes[id],assets:new Map(),rows:new Map(),
    revision:0,fieldsKey:'',preview,queuePreview(){},loadThumbnail(){}});
  nodes.mission.hidden=true;
  return {panel,nodes,previewCloses:()=>closed};
}

const entity={entity_id:'scenario:UAM11',name:'UAM11',source:'scenario',kind:'uam',quality:'nominal',
  provenance:'simulation',derivation:'simulated',orientation_source:'attitude',latitude_deg:37.5,longitude_deg:127,
  altitude_m:335,velocity_ecef_mps:[30,40,0],heading_deg:91,pitch_deg:-2.2,roll_deg:0,tilt_deg:90,
  rotor_radps:670,flight_phase:'cruise',state_time:100,observation_time:100};

test('closing the card puts the reading away, not the target, and a chip says what is still followed',()=>{
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes,previewCloses}=panelHarness();
  try{
    panel.show(entity);
    assert.equal(nodes['selection-restore'].hidden,true,'nothing to restore while the card is open');
    assert.equal(nodes.selection.dataset.open,'true');
    const before=previewCloses();
    panel.setCollapsed(true);
    assert.equal(panel.entityId,'scenario:UAM11','the selection is still the selection');
    assert.equal(nodes.selection.dataset.open,'false');assert.equal(nodes.selection.inert,true);
    assert.equal(nodes['selection-restore'].hidden,false);
    assert.equal(nodes['selection-restore-name'].textContent,'UAM11');
    assert.ok(previewCloses()>before,'the second WebGL context is released while the card is away');
    // Telemetry keeps arriving for something that is still selected and still
    // followed; it must not quietly reopen the card the operator just closed.
    panel.show({...entity,altitude_m:400});
    assert.equal(nodes.selection.dataset.open,'false');
    assert.equal(panel.collapsed,true);
    panel.setCollapsed(false);
    assert.equal(nodes.selection.hidden,false);assert.equal(nodes.selection.dataset.open,'true');
    assert.equal(nodes['selection-restore'].hidden,true);
    assert.equal(panel.readoutNodes.get('altitude').value.textContent,'400','it reopens on the latest state, not the stale one');
    // Letting the target go really lets it go: no chip left pointing at nothing.
    panel.setCollapsed(true);panel.show(null);
    assert.equal(nodes['selection-restore'].hidden,true);assert.equal(panel.collapsed,false);
    // A different aircraft opens its own card rather than inheriting the fold.
    panel.show(entity);panel.setCollapsed(true);panel.show({...entity,entity_id:'scenario:UAM12'});
    assert.equal(panel.collapsed,false);assert.equal(nodes['selection-restore'].hidden,true);
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});

test('the close button no longer claims to release the selection',()=>{
  assert.match(html,/id="clear"[^>]*aria-label="정보 창 숨기기"/);
  assert.match(html,/id="selection-restore"[^>]*hidden/);
  assert.ok(html.indexOf('id="selection-restore"')>html.indexOf('id="layers"'),'the chip lives with the layer buttons at the top');
  assert.ok(html.indexOf('id="selection-restore"')<html.indexOf('id="settings-panel"'));
  const app=readFileSync(new URL('app.js',web),'utf8');
  // Hiding the drawer keeps the selection: the strip along the bottom stays,
  // and the map's selection is released only by the strip's own × or Esc.
  assert.match(app,/\$\('clear'\)\.onclick=\(\)=>\{detailDrawerOpen=false;selectionPanel\.show\(null\);\}/);
  assert.doesNotMatch(app,/\$\('clear'\)\.onclick=[^;]*globe\.select\(null\)/);
  // A plain click no longer opens a window of the card beside the strip.
  assert.match(app,/if\(entity&&reopen\)selectionWindows\?\.open\(entity\)/);
  assert.doesNotMatch(app,/if\(entity&&\(reopen\|\|selected\)\)selectionWindows\?\.open/);
  assert.match(app,/\$\('selection-restore'\)\.onclick=\(\)=>selectionPanel\.setCollapsed\(false\)/);
});

test('right-click app callback restores a collapsed card on fresh telemetry without touching tracking',()=>{
  const app=readFileSync(new URL('app.js',web),'utf8');
  const callback=app.match(/onSelect:(\(entity,\{reopen=false\}=\{\}\)=>\{[\s\S]*?)\n  \}\}\);/)[1]+'\n}';
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes}=panelHarness();let mission=null;
  const globe={tracking:true,selected:entity.entity_id,detailsTracked:()=>true};
  const onSelect=new Function('selectionPanel','$','globe','followMission','return '+callback)(panel,id=>nodes[id],globe,e=>mission=e);
  try{
    panel.show(entity);panel.setCollapsed(true);
    onSelect({...entity,altitude_m:456});assert.equal(panel.collapsed,true);
    onSelect({...entity,altitude_m:567},{reopen:true});
    assert.equal(panel.collapsed,false);assert.equal(nodes.selection.dataset.open,'true');
    assert.equal(panel.readoutNodes.get('altitude').value.textContent,'567');
    assert.equal(globe.tracking,true);assert.equal(globe.selected,entity.entity_id);assert.equal(mission.altitude_m,567);
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});
