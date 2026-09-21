import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';
test('manual panel keeps command ownership outside the view and preserves retained throttle without side overlays',()=>{const sent=[];const document={...fakeDocument,body:new FakeElement('body')};const panel=new ManualFlightPanel({document,target:null,onCommand:c=>sent.push(c)});panel.open();panel.input.setThrottle(.4);panel.tick(.02);assert.equal(sent[0].throttle,.4);assert.equal(panel.root.querySelector('.manual-throttle'),null);assert.equal(panel.root.querySelector('.manual-direction'),null);assert.equal(panel.root.hidden,false);panel.close();assert.equal(panel.tick(.02),null);assert.equal(panel.root.hidden,true);panel.destroy();});
test('screen mode softens intermediate stick input and releases it completely',()=>{const document={...fakeDocument,body:new FakeElement('body')};const p=new ManualFlightPanel({document,target:null});p.open();p.source.value='screen';p.source.onchange();assert.equal(p.input.source,'screen');p.input.setStick(.5,.5);const c=p.tick(.01);assert.ok(c.roll>0&&c.roll<.5);assert.equal(c.roll,c.pitch);p.releaseStick();assert.equal(p.tick(.01).roll,0);p.destroy();});

test('state and the way out of it are one control, and only a held session can be pressed',()=>{
  // They used to be two: a sentence saying input was held, and a separate
  // 'resume' beside it. An operator reads one thing and presses the same thing.
  const resumed=[];
  const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new ManualFlightPanel({document,target:null,onResume:()=>resumed.push(1)});
  const chip=panel.stateChip;
  // Before a session there is nothing to resume, so the chip is a label.
  assert.equal(chip.getAttribute('data-state'),'idle');
  assert.equal(panel.status.textContent,'대기');
  assert.equal(chip.getAttribute('aria-disabled'),'true');

  panel.setStatus('active','조작 중','조작 중 · 방향키 지상 이동 / Q·E 회전 / W·S 스로틀');
  assert.equal(panel.status.textContent,'조작 중');
  assert.equal(chip.getAttribute('aria-disabled'),'true');
  // The key legend left the strip; it is under the stick and the throttle, and
  // stays reachable here without taking a line.
  assert.match(chip.getAttribute('title'),/방향키/);
  chip.onclick();
  assert.deepEqual(resumed,[],'a session already flying has nothing to resume');

  panel.setStatus('held','대기','입력 보호 중 · 창으로 돌아오면 자동 재개');
  assert.equal(panel.status.textContent,'재개');
  chip.onclick();
  assert.deepEqual(resumed,[1]);

  // A closed session is not resumable from here: the plan has to run again.
  panel.setStatus('closed','종료됨','연결 종료 · 계획에서 다시 실행하세요');
  assert.equal(panel.status.textContent,'종료됨');
  chip.onclick();
  assert.deepEqual(resumed,[1]);
  panel.destroy();
});

test('the operations strip says what the aircraft is doing, and never how it is being flown',()=>{
  const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new ManualFlightPanel({document,target:null});
  const toolbar=panel.root.querySelector('.manual-toolbar');
  // Which device is flying it, and which flight mode it is in, are settings.
  // They belong at the flight console; this strip is read during operation.
  assert.deepEqual([...toolbar.children].map(node=>node.className||node.tagName),
    ['manual-state','manual-exit']);
  assert.equal(toolbar.querySelector('select'),null,'no input device on the strip');
  assert.doesNotMatch(toolbar.textContent,/키보드|조이스틱|화면|멀티로터|고정익/);
  // The selects still exist unmounted: they are the console's handles onto the
  // same input, so `control('source', …)` keeps working.
  assert.deepEqual([...panel.mode.children].map(o=>o.textContent),['멀티로터','고정익']);
  assert.deepEqual([...panel.source.children].map(o=>o.textContent),['키보드','화면','조이스틱']);
  const dashboard=readFileSync(new URL('../../../../user_application/web/aircraft_dashboard.js',import.meta.url),'utf8');
  assert.match(dashboard,/class: 'adb-actions'\}, \.\.\.this\.actionGroups, this\.controlsHost, this\.manualHost/,
    'it is mounted inside the action row');
  const css=readFileSync(new URL('../../../../user_application/web/aircraft_dashboard.css',import.meta.url),'utf8');
  assert.doesNotMatch(css,/grid-template-areas:'identity actions' 'manual manual'/,'no row of its own');
  assert.match(css,/\.adb-manual\{[^}]*border-left/,'marked off as a group instead');
  // One line, and it stays one: the window controls dropping to a second row is
  // what read as a two-line strip, and a longer status word was enough to do it.
  assert.match(css,/\[data-manual=true\] \.adb-actions\{flex-wrap:nowrap\}/);
  const panelCss=readFileSync(new URL('../../../../user_application/web/manual_flight_panel.css',import.meta.url),'utf8');
  assert.match(panelCss,/\.manual-status\{[^}]*min-width/,'the state word sits in a fixed box');
  // Controls are fixed-size tools; the name is the text that gives way.
  assert.match(css,/\[data-manual=true\]\[data-minimised=true\] \.adb-surface\{grid-template-columns:minmax\(0,1fr\) max-content\}/);
  assert.match(css,/\.adb-manual \.manual-toolbar select\{[^}]*min-width:\d/,'a select never shrinks to its arrow');
  panel.destroy();
});
