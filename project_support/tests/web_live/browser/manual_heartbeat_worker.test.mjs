import test from 'node:test';import assert from 'node:assert/strict';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';

// While the tab is hidden the panel suspends input on purpose, so the only
// thing left on the socket is the keepalive -- and the timer that sent it is a
// page timer, which a hidden page throttles to a second and then to a minute.
// The server gave up after thirty seconds of that and ended the flight. The
// beat now comes from a worker, whose timer is not throttled the same way.

const session=(socket,extra={})=>Object.assign(Object.create(ManualFlightSession.prototype),{socket},extra);

test('a beat tells the server the pilot is still there, and moves nothing',()=>{
 const sent=[],s=session({readyState:1,send:m=>sent.push(JSON.parse(m))});
 s.keepAlive();
 assert.deepEqual(sent,[{type:'keepalive'}],'the only message is a keepalive');
 // No sequence, no controls: a keepalive steps no physics and replays no held
 // key, so the pose a hidden tab left is the pose the pilot returns to.
 assert.equal(sent[0].sequence,undefined);
});

test('a beat does not pile up behind one that just went, or behind a command',()=>{
 const sent=[],s=session({readyState:1,send:m=>sent.push(JSON.parse(m))});
 s.keepAlive();s.keepAlive();s.keepAlive();
 assert.equal(sent.length,1,'one beat, not three');
 // A pilot who is actively flying already says they are there every command.
 const flying=session({readyState:1,send:m=>sent.push(JSON.parse(m))},{lastSend:performance.now()});
 flying.keepAlive();
 assert.equal(sent.length,1,'no beat while commands are flowing');
});

test('a beat is never sent down a socket that is not open',()=>{
 for(const readyState of [0,2,3]){
  const sent=[],s=session({readyState,send:m=>sent.push(m)});
  s.keepAlive();assert.equal(sent.length,0,`readyState ${readyState}`);
 }
 const gone=session(null);gone.keepAlive();          // and none at all after teardown
});

test('somewhere without workers keeps its page timer instead of failing',()=>{
 const s=session({readyState:1,send:()=>{}});
 s.startHeartbeat();                                  // node has no DOM Worker
 assert.equal(s.beat,null,'no worker, and no exception either');
 s.stopHeartbeat();
 // Stopping twice, or before starting, is what teardown does on every path.
 s.stopHeartbeat();
});

test('the beat is slower than the server is patient, with room to miss one',async()=>{
 const source=await import('node:fs').then(fs=>fs.readFileSync(
  new URL('../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js',import.meta.url),'utf8'));
 const beat=Number(/const HEARTBEAT_MS=(\d+)/.exec(source)[1]);
 // The server waits SILENCE_SECONDS (30) before it holds the aircraft. Two
 // missed beats must still land inside that, or a hold appears for no reason.
 assert.ok(beat*3<=30000,`${beat} ms leaves no room under a 30 s silence window`);
 assert.ok(beat>=1000,'and not so fast that a hidden tab chatters');
});
