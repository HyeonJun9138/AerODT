import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceChart} from '../../../../user_application/web/domains/uam/cockpit/cockpit_surface.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
const position={entity_id:'scenario:U1',latitude_deg:37,longitude_deg:127,phase:'hold'};
const detail={state:{aircraft_id:'U1',phase:'hold',destination:'VP1',holding:true,
 clearance:{vertiport:'VP1',fato:'F2',stand:'G5',sequence:2},
 instruction:{clearance:'hold',clearance_reason:'PSU VP1 R2-H1 · 접근점 복귀'}}};
test('PSU read-only view retains observed pilot decision and queue after SURFACE removal',()=>{
 const snapshot=JSON.stringify(detail),chart=surfaceChart(new Map(),position,null,detail);
 const c=new CockpitConsole({document:fakeDocument});c.update({chart});
 assert.match(c.psuNotice.textContent,/2/);assert.match(c.psuDepartNote.textContent,/R2-H1/);
 assert.match(c.psuState.textContent,/체공/);assert.match(c.psuNotice.textContent,/PSU/);
 assert.equal(chart.liveFato,'F2');assert.equal(chart.liveGate,'G5');assert.equal(c.departButton.disabled,true);
 assert.equal(JSON.stringify(detail),snapshot);
 c.update({chart,stale:true});assert.equal(c.psuConnection.textContent,'수신 지연');assert.match(c.psuDepartNote.textContent,/오래된/);
 c.update({chart:surfaceChart(new Map(),{...position,entity_id:'scenario:U2'},null,detail)});
 assert.match(c.psuDepartNote.textContent,/연결된 PSU/);assert.equal(c.psuState.textContent,'PSU 미연결');
});
test('pilot traffic response is distinct from PSU hold instruction',()=>{
 const d=structuredClone(detail);d.state.instruction={...d.state.instruction,action:'avoid_right',reason:'앞선 기체 회피'};
 const c=new CockpitConsole({document:fakeDocument});
 d.state.holding=false;d.state.phase='cruise';
 c.update({chart:surfaceChart(new Map(),{...position,phase:'cruise'},null,d)});
 assert.match(c.psuDepartNote.textContent,/R2-H1/);assert.match(c.psuNextText.textContent,/앞선 기체 회피/);
});
