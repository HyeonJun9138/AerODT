import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {DestinationLoading} from '../../../../user_application/web/destination_loading.js';
test('destination overlay appears only after arrival, reports actual counts and clears on every terminal state',()=>{
 const host=new FakeElement('div'),ui=new DestinationLoading({document:fakeDocument,host});
 ui.update({phase:'moving',total:8,ready:0});assert.equal(ui.root.getAttribute('aria-hidden'),'true');
 ui.update({phase:'preparing',total:8,ready:3});assert.equal(ui.root.getAttribute('aria-hidden'),'false');assert.match(ui.root.textContent,/3 \/ 8/);
 for(const phase of ['ready','timeout','cancelled']){ui.update({phase:'preparing',total:1,ready:0});ui.update({phase});assert.equal(ui.root.getAttribute('aria-hidden'),'true');}
 ui.destroy();assert.equal(host.children.length,0);
});
