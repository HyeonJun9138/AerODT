import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {VertiportPanel} from '../../../../user_application/web/domains/uam/operations/vertiport_panel.js';

test('live board preserves full identifiers, titles and aircraft navigation', () => {
  const selected=[], panel=new VertiportPanel({document:fakeDocument,onFocusAircraft:id=>selected.push(id)});
  panel.live={clock:'06:47:55',inbound:[{flight_id:'FPL000012',aircraft_id:'UAM0012',origin:'VP002',airborne:true}],outbound:[],holding:[]};
  const host=new FakeElement('div');panel.fillLiveBoard(host);
  const table=host.querySelector('.vp-board-live'), row=table.querySelector('tbody').children[0];
  for(const [i,id] of ['FPL000012','UAM0012'].entries()){
    assert.equal(row.children[i].textContent,id);assert.equal(row.children[i].getAttribute('title'),id);
  }
  row.click();assert.deepEqual(selected,['UAM0012']);
  row.onkeydown({key:'Enter',preventDefault(){}});assert.deepEqual(selected,['UAM0012','UAM0012']);
});

test('live board has readable fixed identity columns and horizontal overflow fallback', () => {
  const css=readFileSync(new URL('../../../../user_application/web/vertiport_panel.css',import.meta.url),'utf8');
  assert.match(css,/\.vp-board\.vp-board-live\{min-width:640px\}/);
  assert.match(css,/\.vp-board-live th:first-child\{width:110px\}/);
  assert.match(css,/\.vp-board-live th:nth-child\(2\)\{width:100px\}/);
  assert.match(css,/\.vp-board-live td:nth-child\(-n\+2\).*overflow-wrap:anywhere/);
});
