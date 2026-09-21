// Turning a decision into a picture.
//
// The charts arrive as nodes that name their branches - "yes goes here, no goes
// there" - which is the truthful way to write a decision down and useless for
// drawing, because it says nothing about where anything sits. This works out
// the where: which row each node is on, in what order across that row, and the
// path of every line between them.
//
// Two things make the difference between a chart that can be read and one that
// cannot. The first is that a box belongs under whatever leads to it: if a
// question's "yes" leaves to the left, the box it leads to has to be the left
// one, or the two answers swap over on the way down and the drawing says the
// opposite of what it means. The second is that no line may cross a box it has
// nothing to do with, because a line across a box reads as though it touches
// it. Everything below is in service of those two.
//
// Kept apart from the drawing so the arithmetic can be checked without a
// browser, and because the shape of a decision is worth reading on its own.

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 46;
export const ROW_GAP = 30;
// How many characters fit across a box. A diamond is narrower where the text
// sits than a rectangle of the same width, so it gets fewer.
export const WRAP = 25;
export const WRAP_DECISION = 22;
export const COLUMN_GAP = 26;
// Room above the first row for a returning line to come back in over it, and
// below the last for the drawing not to touch its own edge.
export const PADDING = 30;
// How far a line keeps from a box it is only passing, and the width of the
// lane beside the drawing that a line uses when nothing nearer is free.
export const CLEARANCE = 11;
export const LANE = 14;

const OUTS = [['yes', '예'], ['no', '아니오'], ['next', '']];
const branchesOf = node => OUTS.map(([key]) => node[key]).filter(Boolean);
// Which of a node's exits this branch leaves from, as a fraction of its width.
// One exit leaves from the middle; two leave from a third and two thirds, so
// which line is which can be read without following either of them.
const shareOf = (node, key, live) => {
  const kept = OUTS.filter(([other]) => node[other] && live.has(node[other]));
  return kept.length > 1 ? (kept.findIndex(([other]) => other === key) + 1) / (kept.length + 1) : 0.5;
};

// The branches that genuinely return - the ones that make the chart a loop
// rather than a list. Found by walking the chart and noticing a branch that
// points at something the walk has not finished with yet: that is the only kind
// of edge that can lead back to where it came from.
//
// This has to be told apart from a branch that merely reaches something by a
// longer road than another branch did, and telling the two apart is the whole
// difficulty. Treat a long road as a loop and the box it leads to gets stranded
// above the boxes that lead into it, with lines climbing back up the page to
// reach it - which is exactly how a chart ends up looking like plumbing.
export function returning(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const back = new Set();
  const state = new Map();          // unset · 1 open · 2 finished
  for (const start of nodes) {
    if (state.has(start.id)) continue;
    const stack = [[start.id, 0]];
    state.set(start.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const outs = branchesOf(byId.get(top[0])).filter(id => byId.has(id));
      if (top[1] >= outs.length) { state.set(top[0], 2); stack.pop(); continue; }
      const next = outs[top[1]++];
      if (state.get(next) === 1) back.add(`${top[0]}>${next}`);
      else if (!state.has(next)) { state.set(next, 1); stack.push([next, 0]); }
    }
  }
  return back;
}

// Which row each node belongs on: one below the furthest thing that leads to
// it, ignoring the branches that return. A box that can be reached both early
// and late belongs below everything that can reach it, or a line has to climb
// back up the page to get to it.
export function depths(nodes, entry) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const back = returning(nodes);
  const depth = new Map(nodes.map(node => [node.id, 0]));
  // Without the returning branches this is a chart with a bottom, so relaxing
  // it settles: every pass moves at least one box down or it is finished, and
  // no box can be further down than there are boxes.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const node of nodes)
      for (const next of branchesOf(node)) {
        if (!byId.has(next) || back.has(`${node.id}>${next}`)) continue;
        if (depth.get(next) < depth.get(node.id) + 1) {
          depth.set(next, depth.get(node.id) + 1); moved = true;
        }
      }
    if (!moved) break;
  }
  // Anything nothing leads to sits at the top with the entry - except that the
  // entry is the top, and a stranded box is a fact about the logic worth
  // seeing, so it goes below everything rather than beside the first step.
  const reached = new Set([entry]);
  const walk = [entry];
  while (walk.length) {
    for (const next of branchesOf(byId.get(walk.pop()) ?? {}))
      if (byId.has(next) && !reached.has(next)) { reached.add(next); walk.push(next); }
  }
  let orphan = Math.max(0, ...[...depth].filter(([id]) => reached.has(id)).map(([, d]) => d)) + 1;
  for (const node of nodes) if (!reached.has(node.id)) depth.set(node.id, orphan++);
  return depth;
}

// The order across each row. A box is pulled towards whatever leads into it, so
// a question's left-hand answer lands on the left. Without this the boxes sit
// in the order somebody happened to write them and the two answers of every
// decision cross over on the way down - which is worse than untidy, because a
// reader following the "yes" line arrives at the "no" box.
export function orderRows(nodes, depth) {
  const live = new Set(nodes.map(node => node.id));
  const byRow = new Map();
  for (const node of nodes) {
    const row = depth.get(node.id);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(node);
  }
  // One box plus its gap is the unit; an exit a third of the way along a box is
  // that fraction of a box-width from its middle.
  const step = NODE_WIDTH / (NODE_WIDTH + COLUMN_GAP);
  const at = new Map();       // node id -> its distance from the middle of its row
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    const members = byRow.get(row);
    const pull = new Map();
    for (const node of members) {
      const pulls = [];
      for (const parent of nodes) {
        if (depth.get(parent.id) >= row || !at.has(parent.id)) continue;
        for (const [key] of OUTS) {
          if (parent[key] !== node.id) continue;
          pulls.push(at.get(parent.id) + (shareOf(parent, key, live) - 0.5) * step);
        }
      }
      // A box nothing above leads to has nothing pulling it; it keeps the
      // place the chart's author gave it, at the end of the row.
      pull.set(node.id, pulls.length ? pulls.reduce((a, b) => a + b, 0) / pulls.length : 1e9);
    }
    members.sort((a, b) => pull.get(a.id) - pull.get(b.id));
    members.forEach((node, index) => at.set(node.id, index - (members.length - 1) / 2));
  }
  return byRow;
}

// The clear line across the page just above a row. Every sideways run in the
// drawing happens on one of these, which is what keeps a line out of a box.
export function gapAbove(row) {
  return PADDING + row * (NODE_HEIGHT + ROW_GAP) - ROW_GAP / 2;
}

// Where each node sits, and the path of every line between them.
export function layout(chart) {
  const depth = depths(chart.nodes, chart.entry);
  const live = new Set(chart.nodes.map(node => node.id));
  const byRow = orderRows(chart.nodes, depth);
  const widest = Math.max(1, ...[...byRow.values()].map(row => row.length));
  const band = widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP;
  // Room outside the boxes for the lines that cannot find a way between them.
  const margin = PADDING + LANE * 2;
  const places = new Map();
  for (const [row, members] of byRow) {
    const span = members.length * NODE_WIDTH + (members.length - 1) * COLUMN_GAP;
    let x = margin + (band - span) / 2;
    for (const node of members) {
      places.set(node.id, {node, x, y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
                           width: NODE_WIDTH, height: NODE_HEIGHT, row});
      x += NODE_WIDTH + COLUMN_GAP;
    }
  }
  const branches = chart.nodes.flatMap(node => OUTS
    .filter(([key]) => node[key] && live.has(node[key]))
    .map(([key, label]) => ({node: node.id, to: node[key], label,
                             share: shareOf(node, key, live)})));
  return {width: margin * 2 + band, left: margin, right: margin,
          height: PADDING * 2 + byRow.size * NODE_HEIGHT + Math.max(0, byRow.size - 1) * ROW_GAP,
          places, rows: byRow.size,
          edges: routeEdges(branches, places, {left: margin, band, byRow})};
}

// Is a vertical line at `x` clear of every box in these rows?
function clearAt(x, rows, byRow, places) {
  for (const row of rows) {
    for (const node of byRow.get(row) ?? []) {
      const box = places.get(node.id);
      if (x > box.x - CLEARANCE && x < box.x + box.width + CLEARANCE) return false;
    }
  }
  return true;
}

// Somewhere to run down. The best place is straight above the box being pointed
// at, so the line arrives without a detour; failing that, any gap between the
// boxes in the way; failing that, beside the drawing. Going out to the edge
// when there is a clear channel two boxes away is what makes a chart look like
// plumbing.
function column(want, rows, byRow, places, {left, band}) {
  const candidates = [...want];
  for (const row of rows) {
    const boxes = (byRow.get(row) ?? []).map(node => places.get(node.id)).sort((a, b) => a.x - b.x);
    for (let i = 1; i < boxes.length; i += 1)
      candidates.push((boxes[i - 1].x + boxes[i - 1].width + boxes[i].x) / 2);
    if (boxes.length) {
      candidates.push(boxes[0].x - CLEARANCE - 3);
      candidates.push(boxes[boxes.length - 1].x + boxes[boxes.length - 1].width + CLEARANCE + 3);
    }
  }
  candidates.push(left - LANE, left + band + LANE, left - LANE * 2, left + band + LANE * 2);
  // Nearest to where the line wants to be, so a detour is only ever as big as
  // it has to be.
  const target = want[0];
  return candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))
    .find(x => clearAt(x, rows, byRow, places)) ?? left + band + LANE * 2;
}

export function routeEdges(branches, places, {left, band, byRow}) {
  // Several lines can share one gap or one column. Nudging them apart keeps two
  // that run the same way from being drawn on top of each other.
  const crowd = new Map();
  const used = [];
  const taken = (x, y1, y2) => used.some(run =>
    Math.abs(run.x - x) < 9 && Math.min(run.y2, y2) - Math.max(run.y1, y1) > 4);
  return branches.map(branch => {
    const from = places.get(branch.node), to = places.get(branch.to);
    if (!from || !to) return null;
    const exitX = Math.round(from.x + from.width * branch.share);
    const bottom = from.y + from.height;
    const enterX = Math.round(to.x + to.width / 2);
    const back = to.row <= from.row;
    const long = to.row !== from.row + 1;
    const arriveGap = gapAbove(to.row);
    const seen = crowd.get(arriveGap) ?? 0;
    crowd.set(arriveGap, seen + 1);
    const nudge = (seen % 3) * 5 - 5;
    const points = [[exitX, bottom]];
    if (!long) {
      // One row down: the gap between the two rows is the only place the line
      // needs, and it is empty by construction.
      const lane = arriveGap + nudge;
      if (exitX !== enterX) points.push([exitX, lane], [enterX, lane]);
    } else {
      // Further than that, so something is in the way. The rows it has to get
      // past are the ones strictly between - or, going back up, every row from
      // the target down to this one.
      const rows = [];
      if (back) for (let r = to.row; r <= from.row; r += 1) rows.push(r);
      else for (let r = from.row + 1; r < to.row; r += 1) rows.push(r);
      const leaveGap = gapAbove(from.row + 1) + nudge;
      const arrive = arriveGap + nudge;
      const [low, high] = leaveGap < arrive ? [leaveGap, arrive] : [arrive, leaveGap];
      const place = want => column(want, rows, byRow, places, {left, band});
      let channel = place([enterX, exitX]);
      // Two lines down the same channel at the same height would read as one.
      for (let tries = 0; taken(channel, low, high) && tries < 8; tries += 1)
        channel = place([channel + (tries % 2 ? -1 : 1) * 10 * (tries + 1)]);
      used.push({x: channel, y1: low, y2: high});
      if (channel !== exitX) points.push([exitX, leaveGap]);
      points.push([channel, leaveGap], [channel, arrive]);
      if (channel !== enterX) points.push([enterX, arrive]);
    }
    points.push([enterX, to.y]);
    return {from: branch.node, to: branch.to, label: branch.label, back, long,
            points: prune(points), labelAt: [exitX + 5, bottom + 13]};
  }).filter(Boolean);
}

// Drop the corners that are not corners: three points in a line are one line,
// and a zero-length leg confuses the rounding into drawing a spur.
function prune(points) {
  const kept = [points[0]];
  for (const point of points.slice(1)) {
    const last = kept[kept.length - 1];
    if (point[0] === last[0] && point[1] === last[1]) continue;
    const before = kept[kept.length - 2];
    if (before && ((before[0] === last[0] && point[0] === last[0]) ||
                   (before[1] === last[1] && point[1] === last[1]))) kept.pop();
    kept.push(point);
  }
  return kept;
}

// The parameters that belong to one node, so clicking a box says which numbers
// that decision turns on.
export function parametersOf(chart, nodeId) {
  return chart.parameters.filter(parameter => parameter.node === nodeId);
}

// How a value reads on the chart. A toggle is a word, a number carries its
// unit, and a value the operator has moved says so - the difference between
// "this is the rule" and "this is the rule I set" is the whole point of the
// window.
export function readValue(parameter, value) {
  if (parameter.kind === 'toggle') return value ? '켬' : '끔';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const step = Number(parameter.step) || 1;
  const text = step < 1 ? number.toFixed(String(step).split('.')[1]?.length ?? 2)
                        : String(Math.round(number));
  return parameter.unit ? `${text} ${parameter.unit}` : text;
}

export function isChanged(parameter, value) {
  return parameter.kind === 'toggle' ? Boolean(value) !== Boolean(parameter.default)
                                     : Number(value) !== Number(parameter.default);
}

// How many of a chart's parameters have been moved, for the tab to say so
// without the operator having to open it.
export function changedCount(chart, values) {
  return chart.parameters.filter(p => isChanged(p, values?.[p.id])).length;
}

// ---- what the drawing must never do ---------------------------------------
// Does any line pass through a box it has nothing to do with?
export function crossings(drawn) {
  const found = [];
  for (const edge of drawn.edges) {
    for (const place of drawn.places.values()) {
      if (place.node.id === edge.from || place.node.id === edge.to) continue;
      for (let i = 1; i < edge.points.length; i += 1) {
        const [x1, y1] = edge.points[i - 1], [x2, y2] = edge.points[i];
        if (segmentHitsBox(x1, y1, x2, y2, place))
          found.push({edge: `${edge.from}→${edge.to}`, through: place.node.id});
      }
    }
  }
  return found;
}

// Do two lines leaving the same decision swap over on the way down? They cross
// when the one leaving further left arrives further right, which is the one
// tangle a reader cannot recover from: they follow "yes" and reach the "no" box.
export function swaps(drawn) {
  const byNode = new Map();
  for (const edge of drawn.edges) {
    if (!byNode.has(edge.from)) byNode.set(edge.from, []);
    byNode.get(edge.from).push(edge);
  }
  const found = [];
  for (const [node, edges] of byNode) {
    if (edges.length < 2) continue;
    const ends = edges.map(edge => ({out: edge.points[0][0],
                                     in: edge.points[edge.points.length - 1][0],
                                     row: drawn.places.get(edge.to).row}));
    for (let i = 0; i < ends.length; i += 1)
      for (let j = i + 1; j < ends.length; j += 1) {
        // Only meaningful when both answers land on the same row: one that
        // carries on down the page is not crossing its sibling, it is leaving.
        if (ends[i].row !== ends[j].row) continue;
        if ((ends[i].out - ends[j].out) * (ends[i].in - ends[j].in) < 0)
          found.push({node, of: edges.map(e => e.to)});
      }
  }
  return found;
}

// Where two lines that have nothing to do with each other step over one
// another. Not the lie a line through a box is - nobody reads a crossing as a
// connection - but still something to trace past, so it is worth counting. Two
// lines that share a box are not tangled: they are meeting, which is the point.
export function tangles(drawn) {
  const legs = [];
  for (const edge of drawn.edges)
    for (let i = 1; i < edge.points.length; i += 1)
      legs.push({edge, a: edge.points[i - 1], b: edge.points[i]});
  const found = new Set();
  for (let i = 0; i < legs.length; i += 1)
    for (let j = i + 1; j < legs.length; j += 1) {
      const one = legs[i], two = legs[j];
      if (one.edge === two.edge) continue;
      if (one.edge.from === two.edge.from || one.edge.to === two.edge.to ||
          one.edge.from === two.edge.to || one.edge.to === two.edge.from) continue;
      const upright = leg => leg.a[0] === leg.b[0];
      if (upright(one) === upright(two)) continue;      // parallel; never cross
      const [down, across] = upright(one) ? [one, two] : [two, one];
      const x = down.a[0], y = across.a[1];
      if (y > Math.min(down.a[1], down.b[1]) + 1 && y < Math.max(down.a[1], down.b[1]) - 1 &&
          x > Math.min(across.a[0], across.b[0]) + 1 && x < Math.max(across.a[0], across.b[0]) - 1)
        found.add(`${down.edge.from}→${down.edge.to} × ${across.edge.from}→${across.edge.to}`);
    }
  return [...found];
}

function segmentHitsBox(x1, y1, x2, y2, {x, y, width, height}) {
  const [lowX, highX] = x1 <= x2 ? [x1, x2] : [x2, x1];
  const [lowY, highY] = y1 <= y2 ? [y1, y2] : [y2, y1];
  return lowX < x + width && highX > x && lowY < y + height && highY > y;
}
