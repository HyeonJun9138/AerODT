import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css=readFileSync(new URL('../../../../user_application/web/styles.css',import.meta.url),'utf8');
const rule=selector=>css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\{([^}]+)\\}`))?.[1] ?? '';

test('shared HUD and selected drawer use the neutral glass surface',()=>{
  assert.match(css,/--panel-glass:/);
  assert.match(rule('.glass'),/background:var\(--panel-glass\)/);
  assert.match(rule('#selection'),/background:var\(--panel-glass\)/);
  assert.match(rule('.glass'),/backdrop-filter:blur\(var\(--display-panel-blur,14px\)\)/,
    'preserve the normal glass, allowing a lighter compositor effect on efficient clients');
  assert.match(css,/button:focus-visible/);
});

test('rail, chips and settings share the gray glass while the map overlay stays bare',()=>{
  // The credits read over bright imagery on a surface of their own no more
  // than the rail does: every overlay wears the same grey glass.
  for(const selector of ['#rail','#layers','#settings-panel','#attribution']){
    assert.doesNotMatch(rule(selector),/background:(?:#|rgb|linear-gradient)/,`${selector} keeps the shared .glass surface`);
    assert.doesNotMatch(rule(selector),/backdrop-filter/,`${selector} blurs through .glass, not on its own`);
  }
  assert.match(rule('.brand-mark'),/(?:^|;)background:transparent(?:;|$)/);
  assert.equal(rule('header'),'');
  assert.equal(rule('#program-footer'),'');
});
