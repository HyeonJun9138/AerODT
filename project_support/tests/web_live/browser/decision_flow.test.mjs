import test from 'node:test';
import assert from 'node:assert/strict';
import {depths, returning, orderRows, layout, gapAbove, crossings, swaps, tangles,
        parametersOf, readValue,
        isChanged, changedCount, NODE_HEIGHT, ROW_GAP, CLEARANCE,
        NODE_WIDTH} from '../../../../user_application/web/decision_flow.js';
import {rounded} from '../../../../user_application/web/domains/uam/operations/decision_panel.js';
import {CHARTS} from './decision_charts.mjs';

// A small chart with the shapes that matter: a branch that rejoins, a branch
// that goes back up, and a question whose two answers are listed in the
// opposite order to the boxes they lead to.
const CHART = {
  id: 'demo', entry: 'a',
  nodes: [
    {id: 'a', kind: 'start', text: '시작', next: 'b'},
    {id: 'b', kind: 'decision', text: '갈까?', yes: 'c', no: 'd'},
    {id: 'd', kind: 'action', text: '기다린다', next: 'e'},
    {id: 'c', kind: 'action', text: '간다', next: 'e'},
    {id: 'e', kind: 'decision', text: '끝인가?', yes: 'f', no: 'a'},
    {id: 'f', kind: 'end', text: '끝'},
  ],
  parameters: [
    {id: 'wait_s', label: '대기', unit: '초', node: 'd', min: 0, max: 100, step: 5, default: 20},
    {id: 'on', label: '켜기', kind: 'toggle', node: 'b', default: true},
  ],
};

const ALL = [CHART, ...CHARTS];

test('a node sits below everything that can reach it, by the longest way in', () => {
  const depth = depths(CHART.nodes, CHART.entry);
  assert.equal(depth.get('a'), 0);
  assert.equal(depth.get('b'), 1);
  assert.equal(depth.get('c'), 2);
  assert.equal(depth.get('d'), 2);
  // Reachable in two hops from b and in three via c or d. The longer way wins,
  // or the line from 'c' would point back up the page and read as a loop.
  assert.equal(depth.get('e'), 3);
  assert.equal(depth.get('f'), 4);
});

test('a branch back to the start does not push the start down', () => {
  // 'e' points back at 'a'. Following that would move 'a' below 'e', then 'b'
  // below that, forever. A chart that ticks has to settle.
  const depth = depths(CHART.nodes, CHART.entry);
  assert.equal(depth.get('a'), 0, 'the entry stays at the top');
  const edge = layout(CHART).edges.find(e => e.from === 'e' && e.to === 'a');
  assert.equal(edge.back, true, 'and the line that goes back says so');
});

test('a node nothing reaches is still drawn, below the rest', () => {
  const stranded = {...CHART, nodes: [...CHART.nodes, {id: 'z', kind: 'end', text: '못 닿음'}]};
  const depth = depths(stranded.nodes, stranded.entry);
  assert.equal(depth.get('z'), 5, 'an unreachable branch is a fact about the logic, not a thing to hide');
  const drawn = layout(stranded);
  assert.deepEqual(crossings(drawn), [], 'and it does not put a line through anything');
});

// ---- the two things that make a chart readable ----------------------------
test('a box is placed under whatever leads to it, whatever order it was written in', () => {
  // The chart lists 'd' before 'c', but 'b' sends its "yes" to 'c' from the
  // left-hand exit. Written order would put 'd' on the left and the two answers
  // would swap over on the way down.
  const row = orderRows(CHART.nodes, depths(CHART.nodes, CHART.entry)).get(2);
  assert.deepEqual(row.map(node => node.id), ['c', 'd']);
});

test('a longer road to the same box is not mistaken for a loop', () => {
  // 'e' is reached from 'b' in two hops and from 'c' or 'd' in three. Only the
  // branch from 'e' back to 'a' actually returns. Treat the long road as a loop
  // and 'e' is stranded above the boxes that lead into it, with lines climbing
  // back up the page to reach it - which is how a chart ends up as plumbing.
  assert.deepEqual([...returning(CHART.nodes)], ['e>a']);
  const depth = depths(CHART.nodes, CHART.entry);
  for (const chart of ALL) {
    const rows = depths(chart.nodes, chart.entry);
    const loops = returning(chart.nodes);
    for (const node of chart.nodes)
      for (const key of ['yes', 'no', 'next']) {
        if (!node[key] || loops.has(`${node.id}>${node[key]}`)) continue;
        assert.ok(rows.get(node[key]) > rows.get(node.id),
          `${chart.id}: ${node.id} → ${node[key]} points up the page without being a loop`);
      }
  }
  assert.equal(depth.get('e'), 3);
});

test('the four real charts have no tangle left in them at all', () => {
  // Two lines stepping over each other is not the lie a line through a box is,
  // but it is still something to trace past. With the boxes laid out under
  // whatever leads to them, none of the four needs one.
  for (const chart of CHARTS) {
    const crossed = tangles(layout(chart));
    assert.deepEqual(crossed, [], `${chart.id}: ${crossed.join(' | ')}`);
  }
});

test("a decision's two answers never swap over on the way down", () => {
  // The one tangle a reader cannot recover from: they follow "yes" and arrive
  // at the "no" box.
  for (const chart of ALL) {
    const crossed = swaps(layout(chart));
    assert.deepEqual(crossed, [], `${chart.id}: ${crossed.map(c => c.node).join(', ')}`);
  }
});

test('no line is drawn through a box it has nothing to do with', () => {
  // A line across a box reads as though it touches it, and on a chart whose
  // job is to say what leads to what, that is a lie.
  for (const chart of ALL) {
    const through = crossings(layout(chart));
    assert.deepEqual(through, [], `${chart.id}: ${through.map(t => `${t.edge} cuts ${t.through}`).join(', ')}`);
  }
});

test('every sideways run happens in the gap between two rows', () => {
  for (const chart of ALL) {
    const drawn = layout(chart);
    const gaps = [];
    for (let row = 0; row <= drawn.rows; row += 1) gaps.push(gapAbove(row));
    for (const edge of drawn.edges) {
      for (let i = 1; i < edge.points.length; i += 1) {
        const [x1, y1] = edge.points[i - 1], [x2, y2] = edge.points[i];
        if (y1 !== y2 || x1 === x2) continue;
        const nearest = gaps.reduce((best, gap) => Math.abs(gap - y1) < Math.abs(best - y1) ? gap : best);
        assert.ok(Math.abs(nearest - y1) <= ROW_GAP / 2 - 6,
          `${chart.id}: a sideways run at y=${y1} is not in a gap (nearest ${nearest})`);
      }
    }
  }
});

test('a line takes the nearest way past what is in its way, not the long way round', () => {
  // Going out to the edge of the drawing when there is a clear channel two
  // boxes away is what makes a chart look like plumbing.
  for (const chart of ALL) {
    const drawn = layout(chart);
    for (const edge of drawn.edges.filter(e => e.long)) {
      const xs = edge.points.map(([x]) => x);
      const detour = Math.max(...xs) - Math.min(...xs);
      assert.ok(detour <= NODE_WIDTH * 2.5,
        `${chart.id}: ${edge.from}→${edge.to} wanders ${Math.round(detour)}px sideways`);
    }
  }
});

test('a long line still keeps its distance from the boxes it passes', () => {
  for (const chart of ALL) {
    const drawn = layout(chart);
    for (const edge of drawn.edges) {
      for (let i = 1; i < edge.points.length; i += 1) {
        const [x1, y1] = edge.points[i - 1], [x2, y2] = edge.points[i];
        if (x1 !== x2) continue;              // only the vertical runs travel
        for (const place of drawn.places.values()) {
          if (place.node.id === edge.from || place.node.id === edge.to) continue;
          const overlaps = Math.min(y1, y2) < place.y + place.height && Math.max(y1, y2) > place.y;
          if (!overlaps) continue;
          assert.ok(x1 <= place.x - CLEARANCE || x1 >= place.x + place.width + CLEARANCE,
            `${chart.id}: ${edge.from}→${edge.to} runs ${x1} past ${place.node.id}`);
        }
      }
    }
  }
});

test("a decision's two answers leave from different places along its edge", () => {
  const drawn = layout(CHART);
  const yes = drawn.edges.find(e => e.from === 'b' && e.label === '예');
  const no = drawn.edges.find(e => e.from === 'b' && e.label === '아니오');
  assert.notEqual(yes.points[0][0], no.points[0][0],
    'so which line is which can be read without following either of them');
  const box = drawn.places.get('b');
  for (const edge of [yes, no]) {
    assert.ok(edge.points[0][0] > box.x && edge.points[0][0] < box.x + box.width);
    assert.equal(edge.points[0][1], box.y + box.height, 'both leave the bottom');
  }
  assert.ok(yes.points[0][0] < no.points[0][0], '예 to the left of 아니오, as they are written');
});

test('every line ends at the top of the box it points at', () => {
  for (const chart of ALL) {
    const drawn = layout(chart);
    for (const edge of drawn.edges) {
      const to = drawn.places.get(edge.to);
      const [x, y] = edge.points[edge.points.length - 1];
      assert.equal(y, to.y, `${chart.id} ${edge.from}→${edge.to} must arrive at the top`);
      assert.equal(x, Math.round(to.x + to.width / 2));
    }
  }
});

test('a line straight down is two points, not four', () => {
  // Three points in a line are one line. Left in, they confuse the rounding
  // into drawing a spur at a corner that is not there.
  const drawn = layout(CHART);
  const straight = drawn.edges.find(e => e.from === 'a');
  assert.equal(straight.points.length, 2, 'a → b is directly below');
  for (const chart of ALL)
    for (const edge of layout(chart).edges)
      for (let i = 2; i < edge.points.length; i += 1) {
        const [a, b, c] = [edge.points[i - 2], edge.points[i - 1], edge.points[i]];
        assert.ok(!((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])),
          `${chart.id} ${edge.from}→${edge.to} has a corner that is not a corner`);
      }
});

test('rows are centred, and a row of one sits over the middle of a row of two', () => {
  const drawn = layout(CHART);
  const c = drawn.places.get('c'), d = drawn.places.get('d');
  const a = drawn.places.get('a');
  assert.equal(c.y, d.y, 'the two branches share a row');
  assert.equal(a.x + a.width / 2, (c.x + c.width / 2 + d.x + d.width / 2) / 2);
  assert.equal(drawn.rows, 5);
  assert.equal(drawn.places.get('b').y - a.y, NODE_HEIGHT + ROW_GAP);
  // Tall and narrow beats short and wide here: the window has a column for the
  // drawing and a column for the numbers, and the drawing is the one that can
  // scroll.
  assert.ok(drawn.width <= 700, 'the drawing fits the pane it is given');
  assert.ok(drawn.width > 0 && drawn.height > 0);
});

test('corners are taken off without eating the leg they sit on', () => {
  const path = rounded([[0, 0], [0, 40], [60, 40], [60, 80]]);
  assert.match(path, /^M0,0/);
  assert.match(path, / L60,80$/, 'and it still ends where it was told to');
  assert.ok(path.includes('Q'), 'a turn is drawn as a turn');
  // The radius never takes more than half of the shorter of the two legs, so a
  // short jog cannot round past the corner it was meant to soften.
  assert.match(rounded([[0, 0], [0, 4], [40, 4]]), /L0,2 Q0,4 2,4/);
  assert.equal(rounded([[5, 5]]), '');
});

test('a parameter belongs to the decision it turns on', () => {
  assert.deepEqual(parametersOf(CHART, 'd').map(p => p.id), ['wait_s']);
  assert.deepEqual(parametersOf(CHART, 'c'), []);
});

test('a value reads as what it is, and says when it has been moved', () => {
  const [wait, toggle] = CHART.parameters;
  assert.equal(readValue(wait, 45), '45 초');
  assert.equal(readValue(toggle, false), '끔');
  assert.equal(readValue(wait, 'nonsense'), '—');
  assert.equal(readValue({...wait, step: 0.05, unit: ''}, 0.35), '0.35');
  assert.equal(isChanged(wait, 20), false);
  assert.equal(isChanged(wait, 25), true);
  assert.equal(isChanged(toggle, true), false);
  assert.equal(isChanged(toggle, false), true);
  assert.equal(changedCount(CHART, {wait_s: 25, on: true}), 1);
  assert.equal(changedCount(CHART, {wait_s: 20, on: true}), 0);
});
