import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewReporter,postView} from '../../../../communication/browser/view_report.js';

const seoul = {lamin: 37.3, lamax: 37.8, lomin: 126.7, lomax: 127.3};
const shifted = offset => Object.fromEntries(Object.entries(seoul).map(([key, value]) => [key, value + offset]));

function setup({fail = false} = {}) {
  const sent = []; let time = 0; let settle;
  const reporter = new ViewReporter({now: () => time,
    send: view => {sent.push(view); return new Promise((resolve, reject) => {settle = () => fail ? reject(new Error('offline')) : resolve();});}});
  return {reporter, sent, advance: ms => {time += ms;}, finish: async () => {settle?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();}};
}

test('the first view is reported and an unchanged view is not repeated',async()=>{
  const {reporter, sent, advance, finish} = setup();
  assert.equal(reporter.report(seoul), true);
  await finish();
  assert.deepEqual(sent, [seoul]);
  advance(10000);
  assert.equal(reporter.report(seoul), false, 'nothing moved: the provider is polled on its own schedule');
  assert.equal(sent.length, 1);
});

test('a moved view is reported, but not more often than the rate limit',async()=>{
  const {reporter, sent, advance, finish} = setup();
  reporter.report(seoul); await finish();
  advance(1000);
  assert.equal(reporter.report(shifted(1)), false, 'too soon');
  advance(3500);
  assert.equal(reporter.report(shifted(1)), true);
  await finish();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], shifted(1));
});

test('a drift smaller than the threshold is not worth a request',async()=>{
  const {reporter, advance, finish, sent} = setup();
  reporter.report(seoul); await finish(); advance(10000);
  assert.equal(reporter.report(shifted(.01)), false);
  assert.equal(reporter.report(shifted(.03)), true);
  await finish();
  assert.equal(sent.length, 2);
});

test('a report in flight is not queued behind: the next frame carries a newer view',async()=>{
  const {reporter, sent, advance, finish} = setup();
  reporter.report(seoul);
  advance(10000);
  assert.equal(reporter.report(shifted(5)), false, 'one request at a time');
  await finish();
  advance(10000);
  assert.equal(reporter.report(shifted(5)), true);
  await finish();
  assert.deepEqual(sent.map(view => view.lamin), [37.3, 42.3]);
});

test('a failed report is retried rather than remembered as delivered',async()=>{
  const {reporter, sent, advance, finish} = setup({fail: true});
  reporter.report(seoul);
  await finish();
  advance(10000);
  assert.equal(reporter.report(seoul), true, 'the same view is worth sending again after a failure');
  assert.equal(sent.length, 2);
});

test('a view that is not a finite rectangle is never sent',async()=>{
  const {reporter, sent} = setup();
  for(const view of [null, undefined, {}, {...seoul, lamin: NaN}, {...seoul, lomax: Infinity}, {lamin: 1, lamax: 2}])
    assert.equal(reporter.report(view), false);
  assert.deepEqual(sent, []);
});

test('an unchanged viewport is refreshed after server restart without request buildup',async()=>{
  const {reporter,sent,advance,finish}=setup();
  reporter.report(seoul);await finish();advance(15000);
  assert.equal(reporter.report(seoul),true);
  advance(30000);assert.equal(reporter.report(seoul),false,'only one refresh in flight');
  await finish();assert.equal(sent.length,2);
});

test('a failed HTTP view report retries instead of permanently hiding its failure',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>({ok:false,status:503});
    await assert.rejects(postView()(seoul),/전송 실패/);
    globalThis.fetch=async()=>({ok:true,status:200});
    assert.equal((await postView()(seoul)).status,200);
  }finally{globalThis.fetch=original;}
});
