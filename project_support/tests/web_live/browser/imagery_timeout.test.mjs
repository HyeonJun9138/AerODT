import test from 'node:test';
import assert from 'node:assert/strict';
import {loadImageryProvider} from '../../../../digital_twin/visualization/web/visual_asset_loader.js';

test('fallback imagery also times out instead of blocking dashboard startup', async () => {
  const result = await Promise.race([
    loadImageryProvider(() => Promise.reject(new Error('offline')), () => new Promise(() => {}), 5)
      .then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 100))
  ]);
  assert.equal(result, 'rejected');
});
