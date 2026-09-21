import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
import {mountAlignment,paintAlignment} from '../../../../user_application/web/uam_alignment_panel.js';

const settings={enabled:true,coast_seconds:2,gate_sigma:5,attitude_seconds:.12,max_sigma_m:20,max_alignment_skew_s:.5};
const status=()=>({settings:{...settings},modes:{filtered:90,coasting:8,frozen:2},max_horizontal_sigma_m:4});
test('background refresh preserves edits and saves validated settings',async t=>{
  t.mock.method(globalThis,'fetch',async(_url,options)=>({ok:true,json:async()=>({...status(),settings:JSON.parse(options.body)})}));
  globalThis.document=fakeDocument;const parent=new FakeElement('div'),update=mountAlignment(parent);
  update(status());const input=parent.querySelectorAll('input').find(x=>x.getAttribute('aria-label')==='누락 예측 한도 (초)');
  input.value='3';input.oninput();update(status());assert.equal(input.value,'3');
  const apply=parent.querySelectorAll('button').find(x=>x.textContent==='정렬 설정 적용');
  await apply.onclick();assert.match(parent.textContent,/저장·적용했습니다/);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).coast_seconds,3);
});
test('failed save keeps edits and displays failure without a success message',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:false,json:async()=>({message:'범위 오류'})}));
  globalThis.document=fakeDocument;const parent=new FakeElement('div'),update=mountAlignment(parent);update(status());
  const apply=parent.querySelectorAll('button').find(x=>x.textContent==='정렬 설정 적용');
  await apply.onclick();assert.match(parent.textContent,/범위 오류/);assert.doesNotMatch(parent.textContent,/저장·적용했습니다/);
});
test('frozen state explains why motion stops and keeps original GNSS distinct',()=>{
  globalThis.document=fakeDocument;
  const result=paintAlignment({sensors:{},raw_sensors:{gnss:{values:{latitude_deg:37,longitude_deg:127,altitude_ellipsoid_m:200}}},
    estimation:{mode:'frozen',horizontal_sigma_m:22,vertical_sigma_m:10,observation_age_s:5,prediction_seconds:2,
      gnss_outliers:1,attitude_outliers:0,latitude_deg:37.001,longitude_deg:127,altitude_m:201},alignment_settings:settings});
  assert.equal(result.dataset.mode,'frozen');assert.match(result.textContent,/마지막 유효 위치에서 정지/);
  assert.match(result.textContent,/원본 GNSS/);assert.match(result.textContent,/현재 Twin/);assert.match(result.textContent,/실제 위치 오차의 보증/);
});
