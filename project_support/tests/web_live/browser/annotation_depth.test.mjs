import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Include transient edit/conflict markers, not only the initial route draw.
for (const name of ['route_layer', 'vertiport_layer', 'flight_layer']) {
  test(`${name}: world annotations never opt out of depth testing`, () => {
    const source=readFileSync(new URL(`../../../../digital_twin/visualization/web/${name}.js`,import.meta.url),'utf8');
    const values=[...source.matchAll(/disableDepthTestDistance\s*:\s*([^,}\n]+)/g)].map(m=>m[1].trim());
    assert.ok(values.length>=2);
    assert.ok(values.every(value=>value==='0'),JSON.stringify(values));
  });
}
