import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('template suppression targets only the managed root, not nested PSU deck templates',()=>{
 const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
 const styles=[...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
 const rules=[...styles.matchAll(/([^{}]+)\{\s*display:\s*none\s*!important\s*\}/g)].map(m=>m[1]);
 const templateRule=rules.find(selector=>selector.includes('data-workspace-source'));
 assert.ok(templateRule,'template hiding rule remains present');
 assert.match(templateRule,/\.ww-shell:has\(\s*>\s*\.ww-content\s*>\s*\[data-workspace-source="true"\]\s*\)/);
});
