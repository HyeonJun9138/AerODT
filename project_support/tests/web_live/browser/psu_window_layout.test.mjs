import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../../../../user_application/web/window_workspace.css',import.meta.url),'utf8');
const body=selector=>{const start=css.indexOf(selector+'{');assert.notEqual(start,-1,selector);return css.slice(start+selector.length+1,css.indexOf('}',start));};
test('managed PSU distributes window height through console and content',()=>{
 for(const selector of ['.ww-content>.psu-control.ww-managed','.ww-content>.psu-control.ww-managed>.psu-console-content']){
  assert.match(body(selector),/display:flex/);assert.match(body(selector),/flex-direction:column/);
 }
 assert.match(body('.ww-content>.psu-control.ww-managed>.psu-console-content'),/flex:1/);
});
test('managed PSU live and practice areas use remaining height instead of viewport caps',()=>{
 for(const child of ['.psu-live-workspace','.psu-practice']){
  const rule=body('.ww-content>.psu-control.ww-managed '+child);
  for(const property of ['flex:1','height:auto','min-height:0','max-height:none'])assert.ok(rule.includes(property),property);
 }
});
