import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PsuPanel} from '../../../../user_application/web/domains/uam/operations/psu_panel.js';
import {OperationsSession, roleCard} from '../../../../user_application/web/domains/uam/operations/operations_session.js';
import {StakeholderPanel} from '../../../../user_application/web/domains/uam/operations/stakeholder_panel.js';
const request={id:'r1',facility_id:'VP1',kind:'arrival',callsign:'DEMO 101',version:1,state:'pending',created_at:1000,note:'<script>test</script>',author:'pilot'};
function harness(){
  const document={...fakeDocument,body:new FakeElement('body')},calls=[];
  const session={data:{room_id:'room',facilities:{VP1:'여의도'},participants:[],requests:[structuredClone(request)],history:[],server_time:1000},online:true,member:{role:'psu',name:'PSU'},subscribe:()=>()=>{},action:(...args)=>calls.push(args)};
  const panel=new PsuPanel({document,session}),body=new FakeElement('div');panel.render(body);return {panel,session,body,document,calls};
}
test('PSU role mounts a real view and other role deactivates it',()=>{
  let rendered=0,deactivated=0;const panel=new StakeholderPanel({document:fakeDocument,psuPanel:{render:()=>rendered++,deactivate:()=>deactivated++}}),body=new FakeElement('div');
  panel.render(body);body.querySelector('#stakeholder-tab-psu').click();assert.equal(rendered,1);assert.equal(body.querySelector('#stakeholder-state'),null);
  body.querySelector('#stakeholder-tab-pilot').click();assert.ok(deactivated>=2);
});
test('PSU console can select, hold, collapse and close without commanding a vehicle',()=>{
  const {panel,calls,document}=harness();panel.choose('r1');assert.match(panel.detail.textContent,/미연결/);assert.equal(panel.detail.querySelector('script'),null);
  panel.note.value='FATO 확인 대기';panel.detail.querySelector('[data-action=hold]').click();
  assert.deepEqual(calls[0],['/requests/r1/decision',{version:1,action:'hold',note:'FATO 확인 대기'}]);
  panel.foldButton.click();assert.equal(panel.body.inert,true);panel.foldButton.click();assert.equal(panel.body.hidden,false);
  panel.close();assert.equal(document.body.getAttribute('data-psu-console'),null);panel.destroy();
});
test('read-only and disconnected sessions cannot approve, completed requests stay disabled',()=>{
  const {panel,session}=harness();panel.open();session.member.role='vertiport';panel.update();assert.equal(panel.detail.querySelector('[data-action=proceed]').disabled,true);
  session.member.role='psu';session.online=false;panel.update();assert.equal(panel.detail.querySelector('[data-action=hold]').disabled,true);
  session.online=true;session.data.requests[0].state='proceed';panel.update();assert.equal(panel.detail.querySelector('[data-action=hold]').disabled,true);panel.destroy();
});
test('response draft is preserved on refresh but not copied to another request',()=>{
  const {panel,session}=harness();panel.open();panel.note.value='내 검토';session.data.requests[0].version=2;panel.update();assert.equal(panel.note.value,'내 검토');
  session.data.requests.push({...request,id:'r2'});panel.choose('r2');assert.equal(panel.note.value,'');panel.destroy();
});
test('unchanged polling retains request buttons instead of stealing keyboard focus',()=>{
  const {panel}=harness();panel.open();const button=panel.consoleQueue.children[0];panel.update();assert.equal(panel.consoleQueue.children[0],button);panel.destroy();
});
test('session rejects an older revision of the same room',async()=>{
  const session=new OperationsSession({fetch:async()=>({ok:true,json:async()=>({room_id:'r',revision:1,requests:[]})})});
  session.data={room_id:'r',revision:2,requests:[request]};await session.refresh();assert.equal(session.data.revision,2);session.destroy();
});
test('session handles expiry without retrying a mutation or keeping a fake live role',async()=>{
  let posts=0;const session=new OperationsSession({fetch:async(_url,options)=>{if(options.method==='POST')posts++;return {ok:false,status:401,json:async()=>({message:'expired'})};}});
  session.token='old';session.member={role:'psu'};session.online=true;await session.action('/examples');assert.equal(posts,1);assert.equal(session.token,null);assert.equal(session.member,null);assert.equal(session.online,false);session.destroy();
});
test('session ignores snapshot arriving after destroy',async()=>{
  let resolve;const session=new OperationsSession({fetch:()=>new Promise(r=>resolve=r)});const pending=session.refresh();session.destroy();resolve({ok:true,json:async()=>({member:{role:'psu'}})});await pending;assert.equal(session.data,null);
});

test('the practice card explains nothing: it says only what it alone knows', () => {
  const card = state => {
    const session = {start() {}, join() {}, leave() {}, mutating: false, ...state};
    const {node} = roleCard(fakeDocument, session, 'vertiport', () => 'VP001');
    const note = node.querySelector('.ops-note');
    return {node, note, text: (note.textContent || '').trim()};
  };
  const room = {room_id: 'r1', facilities: {VP001: '여의도'}, participants: []};

  // Connected and not sitting down yet: the button above already says what to
  // do, so nothing is said underneath it.
  const idle = card({online: true, error: null, member: null, data: room});
  assert.equal(idle.text, '');
  assert.equal(idle.note.hidden, true);
  assert.equal(idle.node.querySelectorAll('.ops-note').length, 1, 'and there is no second note');

  // The three things the card alone knows still reach the operator.
  assert.equal(card({online: false, error: null, member: null, data: null}).text, '공유 서버 연결 중…');
  const failed = card({online: true, error: '공유 서버가 응답하지 않습니다.', member: null, data: room});
  assert.equal(failed.text, '공유 서버가 응답하지 않습니다.');
  assert.equal(failed.note.dataset.state, 'warning', 'and a failure reads as one');
  assert.equal(card({online: true, error: null, data: room,
    member: {name: '홍길동', role: 'vertiport', facility_id: 'VP001'}}).text, '홍길동 / 여의도');

  // The room id is still there for anyone diagnosing a shared session, just not
  // taking up a line of the card.
  assert.equal(idle.note.title, 'ROOM r1');
});
