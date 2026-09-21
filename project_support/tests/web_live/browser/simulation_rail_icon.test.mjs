import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('available Simulation rail icon uses the shared full-opacity style, not the obsolete preparing state',()=>{
  const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
  const button=html.match(/<button\b[^>]*id="mode-simulation"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button,/class="rail-button"/);
  assert.doesNotMatch(button,/data-state="preparing"|준비 중|disabled|style=/);
});
