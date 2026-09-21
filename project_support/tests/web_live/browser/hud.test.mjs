import test from 'node:test';
import assert from 'node:assert/strict';
const hud = await import('../../../../user_application/web/hud.js').catch(() => ({}));

test('notice feed suppresses unchanged channel states and keeps only three newest events', () => {
  assert.equal(typeof hud.NoticeFeed, 'function');
  const feed = new hud.NoticeFeed();
  assert.equal(feed.update('transport', 'ready', '연결 완료', 1), true);
  assert.equal(feed.update('transport', 'ready', '연결 완료', 2), false);
  feed.update('transport', 'stale', '수신 지연', 3);
  feed.update('terrain', 'error', '지형 지연', 4);
  feed.update('transport', 'ready', '연결 복구', 5);
  assert.deepEqual(feed.entries.map(e => e.message), ['연결 복구', '지형 지연', '수신 지연']);
});

test('clock is explicit UTC and advances independently of last data snapshot', () => {
  assert.equal(typeof hud.formatUtcClock, 'function');
  assert.equal(hud.formatUtcClock(Date.UTC(2026,8,8,23,59,59)), '2026-09-08 23:59:59 UTC');
  assert.equal(hud.formatUtcClock(Date.UTC(2026,8,9)), '2026-09-09 00:00:00 UTC');
});
