import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PilotPanel} from '../../../../user_application/web/domains/uam/operations/pilot_panel.js';

test('pilot sidebar and console open radar for the current pilot aircraft without flight commands',async()=>{
  const opened=[],document={...fakeDocument,body:new FakeElement('body')};
  const view=new PilotPanel({document,api:{read:async()=>null},onRisk:id=>opened.push(id)});
  try{
    const body=new FakeElement('div');await view.render(body);view.operations.selected='UAM22';
    body.querySelectorAll('button').find(button=>button.textContent==='주변 교통 레이더 ↗').click();
    view.open();view.operations.selected='UAM33';
    view.console.querySelectorAll('button').find(button=>button.textContent==='주변 레이더').click();
    assert.deepEqual(opened,['UAM22','UAM33']);
  }finally{view.destroy();}
});
