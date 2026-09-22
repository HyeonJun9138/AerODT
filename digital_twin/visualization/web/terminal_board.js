// The schedule on the wall, and the people it puts in the room.
//
// Both come from one answer. `terminal_board.board()` on the server reads the
// day as written plus whatever each flight is doing now, and every row carries
// its gate and its passenger count -- so the same rows that are painted onto
// the panel are what says four people are standing at G3 and nobody is at G6.
// Two readings of "who is waiting" would drift within a minute of each other.
//
// Nothing here decides anything about a flight. A status is a word the server
// already chose; this is a drawing of it.

// The panel is painted at a fixed pixel size and stretched onto the face, so
// the row height is in pixels and the board's metres never enter into it.
export const BOARD_W = 1024, BOARD_H = 384;
const ROW_H = 34, HEAD_H = 52, PAD_X = 22;
// Columns, as fractions of the width: time, flight, where, gate, status.
const COLUMNS = [0.0, 0.135, 0.30, 0.66, 0.78];
const INK = {
  back: '#0b1418', rule: '#1d2d36', head: '#7fe9f5', text: '#dbe8ee', dim: '#7d929d',
  scheduled: '#dbe8ee', boarding: '#7fd6a0', taxi: '#e8b552', airborne: '#8fb6e8',
  approach: '#8fb6e8', holding: '#e8b552', landing: '#7fd6a0', arrived: '#7d929d', late: '#e8746b',
};

/** Paint one deck's board onto a canvas. Answers how many rows were drawn. */
export function paintBoard(canvas, board, {title = '', now = ''} = {}) {
  if (!canvas) return 0;
  canvas.width = BOARD_W; canvas.height = BOARD_H;
  const ink = canvas.getContext('2d');
  if (!ink) return 0;
  ink.fillStyle = INK.back;
  ink.fillRect(0, 0, BOARD_W, BOARD_H);
  ink.textBaseline = 'middle';
  ink.font = 'bold 26px sans-serif';
  ink.fillStyle = INK.head;
  ink.fillText(title || '운항 시간표', PAD_X, HEAD_H / 2);
  if (now) {
    ink.textAlign = 'right';
    ink.fillText(now, BOARD_W - PAD_X, HEAD_H / 2);
    ink.textAlign = 'left';
  }
  ink.fillStyle = INK.rule;
  ink.fillRect(0, HEAD_H - 2, BOARD_W, 2);

  const rows = [...(board?.departures ?? []), ...(board?.arrivals ?? [])]
    .sort((first, second) => first.time_s - second.time_s);
  if (!rows.length) {
    ink.font = '22px sans-serif';
    ink.fillStyle = INK.dim;
    // A board that is blank is broken; a board that says it has nothing is a
    // board. The day is loaded from a file, so "none" is an ordinary state.
    ink.fillText(board ? '예정된 운항이 없습니다' : '운항 계획을 불러오는 중', PAD_X, HEAD_H + 30);
    return 0;
  }
  const fits = Math.floor((BOARD_H - HEAD_H - 8) / ROW_H);
  const shown = rows.slice(0, fits);
  ink.font = '21px sans-serif';
  shown.forEach((row, index) => {
    const y = HEAD_H + 8 + index * ROW_H + ROW_H / 2;
    if (index % 2) {
      ink.fillStyle = '#0f1b21';
      ink.fillRect(0, y - ROW_H / 2, BOARD_W, ROW_H);
    }
    const at = column => PAD_X + COLUMNS[column] * (BOARD_W - PAD_X * 2);
    ink.fillStyle = INK.text;
    ink.fillText(row.time ?? '', at(0), y);
    ink.fillStyle = INK.dim;
    ink.fillText(row.flight_id ?? '', at(1), y);
    ink.fillStyle = INK.text;
    // An arrow rather than a column of the word: which way a flight is going
    // is the first thing read, and it is read at a glance.
    const way = row.direction === 'arrival' ? '← ' : '→ ';
    ink.fillText(way + (row.counterpart_name || row.counterpart || ''), at(2), y);
    ink.fillStyle = INK.dim;
    ink.fillText(row.gate ?? '', at(3), y);
    ink.fillStyle = INK[row.status] ?? INK.text;
    ink.fillText(row.status_text ?? '', at(4), y);
  });
  return shown.length;
}

/** What each gate's own sign should read, from the board's rows.
 *
 * A gate that says only its number is a number. The flight it is boarding
 * is on the wall a hundred metres away, and the whole point of standing at
 * G4 is knowing that G4 is the 07:26 to 상암.
 */
export function gateSigns(board) {
  const signs = new Map();
  for (const row of board?.departures ?? []) {
    if (!row?.gate || signs.has(row.gate)) continue;   // the soonest wins; rows arrive in time order
    signs.set(row.gate, `${row.gate} · ${row.time} ${row.counterpart_name || row.counterpart || ''}`
      + ` · ${row.status_text ?? ''}`);
  }
  return signs;
}

// Where people stand and sit, and how many of them. Seated first, because a
// lounge fills from its seats; anybody left over stands behind the back row.
const STAND_BACK_M = 1.5, QUEUE_PITCH_M = 1.1, STAFF_OUT_M = 1.6;
export const CROWD_LIMIT = 44;

const facingOf = vector => (Math.atan2(vector?.[0] ?? 0, vector?.[1] ?? 1) * 180 / Math.PI + 360) % 360;

/** Everybody on the floor right now, in local metres, from the plan and the board.
 *
 * `waiting` is gate -> people, from `terminal_board.waiting_by_gate`. Staff do
 * not come from the schedule: a shop has somebody in it whether or not a flight
 * is boarding, and a screening lane that is open has an officer at it.
 */
export function peopleOn(plan, {waiting = {}, crowd = CROWD_LIMIT, staff = true} = {}) {
  if (!plan) return [];
  const people = [];
  const add = (at, facing, kind, seated = false) => {
    if (people.length < crowd) people.push({at: [+at[0].toFixed(3), +at[1].toFixed(3)],
      heading: +facingOf(facing).toFixed(1), kind, seated});
  };
  // Passengers, at the gate their flight was called from.
  for (const lounge of plan.lounges ?? []) {
    let left = Math.max(0, Math.round(waiting[lounge.gate] ?? 0));
    if (!left) continue;
    for (const row of lounge.rows ?? []) {
      for (const seat of row.seats_m ?? []) {
        if (left <= 0) break;
        add(seat, row.facing_m, 'passenger', true);
        left -= 1;
      }
    }
    // The ones who do not get a seat stand behind the back row, facing the
    // stair they are waiting for rather than the seats.
    const back = lounge.rows?.at(-1);
    const face = back?.facing_m ?? [0, 1];
    for (let index = 0; index < left; index += 1) {
      const across = (index - (left - 1) / 2) * QUEUE_PITCH_M;
      add([lounge.center_m[0] - face[0] * STAND_BACK_M - face[1] * across,
        lounge.center_m[1] - face[1] * STAND_BACK_M + face[0] * across], face, 'passenger');
    }
  }
  if (!staff) return people;
  // Somebody at every screening lane, and somebody in every shop that is open.
  for (const lane of plan.security?.lanes ?? []) {
    const face = plan.entry?.facing_m ?? [0, 1];
    add([lane.center_m[0] + face[1] * 1.3, lane.center_m[1] - face[0] * 1.3],
      [-face[0], -face[1]], 'officer');
  }
  for (const unit of plan.units ?? []) {
    if (unit.kind === 'toilet') continue;
    const face = unit.facing_m ?? [0, 1];
    add([unit.center_m[0] + face[0] * (unit.size_m?.[1] ?? 10) / 2 - face[0] * STAFF_OUT_M,
      unit.center_m[1] + face[1] * (unit.size_m?.[1] ?? 10) / 2 - face[1] * STAFF_OUT_M],
      face, 'staff');
  }
  return people;
}
