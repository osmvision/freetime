// The puzzles of the day: their rules, a solver for each, and how they are made. Shared by the
// puzzle screen, the generator (desktop/scripts/make-puzzles.mjs) and the tests. No DOM here.
//
// Path:  { kind: 'path', n, hints: [cell, ...] }. Draw one line through every square of the n × n
//        grid, moving across or down, passing the numbered squares in order (hints[0] is 1 and
//        the last hint ends the line).
// Zones: { kind: 'zones', n, regions: [region of each cell] }. Put one star in every row, column
//        and zone, and no two stars may touch, not even at a corner.

export const KINDS = ['path', 'zones'];

// ---------------------------------------------------------------- seeded random numbers

/** A random number generator that gives the same numbers for the same text (mulberry32). */
export function seeded(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, rand) => list[Math.floor(rand() * list.length)];

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------------------------------------------------------------- grids

/** The squares next to `c` across and down (not diagonally). */
export function sides(n, c) {
  const r = Math.floor(c / n);
  const k = c % n;
  const out = [];
  if (r > 0) out.push(c - n);
  if (r < n - 1) out.push(c + n);
  if (k > 0) out.push(c - 1);
  if (k < n - 1) out.push(c + 1);
  return out;
}

/** True when squares `a` and `b` touch, corners included. */
export const touching = (n, a, b) => a !== b && Math.abs(Math.floor(a / n) - Math.floor(b / n)) <= 1 && Math.abs((a % n) - (b % n)) <= 1;

// ---------------------------------------------------------------- path

/** True when `line` (squares in order) solves the path puzzle `p`. */
export function pathSolved(p, line) {
  const total = p.n * p.n;
  if (line.length !== total || new Set(line).size !== total) return false;
  if (line[0] !== p.hints[0] || line[total - 1] !== p.hints[p.hints.length - 1]) return false;
  for (let i = 1; i < total; i++) if (!sides(p.n, line[i - 1]).includes(line[i])) return false;
  const order = line.filter((c) => p.hints.includes(c));
  return order.every((c, i) => c === p.hints[i]);
}

/** Up to `limit` solutions of the path puzzle `p` (each a list of squares). */
export function pathSolutions(p, limit = 2) {
  const { n, hints } = p;
  const total = n * n;
  const number = new Map(hints.map((c, i) => [c, i]));
  const end = hints[hints.length - 1];
  const seen = new Uint8Array(total);
  const line = [hints[0]];
  const found = [];
  seen[hints[0]] = 1;

  // Every square still free needs two ways in and out (the end square one), and they must all be
  // reachable from the head of the line.
  function hopeless(head) {
    for (let c = 0; c < total; c++) {
      if (seen[c]) continue;
      let ways = 0;
      for (const x of sides(n, c)) if (!seen[x] || x === head) ways++;
      if (ways < (c === end ? 1 : 2)) return true;
    }
    const stack = [head];
    const reached = new Uint8Array(total);
    reached[head] = 1;
    let count = 0;
    while (stack.length) {
      const c = stack.pop();
      for (const x of sides(n, c)) {
        if (!seen[x] && !reached[x]) {
          reached[x] = 1;
          count++;
          stack.push(x);
        }
      }
    }
    return count !== total - line.length;
  }

  function go(next) {
    if (found.length >= limit) return;
    const head = line[line.length - 1];
    if (line.length === total) {
      if (head === end) found.push(line.slice());
      return;
    }
    if (hopeless(head)) return;
    for (const x of sides(n, head)) {
      if (seen[x]) continue;
      const k = number.get(x);
      if (k !== undefined && k !== next) continue;
      if (x === end && line.length !== total - 1) continue;
      seen[x] = 1;
      line.push(x);
      go(k === undefined ? next : next + 1);
      line.pop();
      seen[x] = 0;
    }
  }
  go(1);
  return found;
}

/** A random line through every square of an n × n grid ("backbite" moves from a zigzag). */
export function randomLine(n, rand) {
  let line = [];
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) line.push(r * n + (r % 2 ? n - 1 - k : k));
  for (let step = 0; step < 60 * n * n; step++) {
    if (rand() < 0.5) line.reverse();
    const last = line[line.length - 1];
    const before = line[line.length - 2];
    const x = pick(sides(n, last).filter((c) => c !== before), rand);
    if (x === undefined) continue;
    const i = line.indexOf(x);
    line = line.slice(0, i + 1).concat(line.slice(i + 1).reverse());
  }
  return line;
}

/**
 * A path puzzle with one solution: as few numbers as it takes, then more for an easier day so
 * that no two numbers are more than `gap` squares apart.
 */
export function makePath(n, rand, { gap = Infinity } = {}) {
  const line = randomLine(n, rand);
  const total = n * n;
  const at = new Set([0, total - 1]);
  for (let i = 8; i < total - 1; i += 8) at.add(i);
  const puzzle = () => ({ kind: 'path', n, hints: [...at].sort((a, b) => a - b).map((i) => line[i]) });
  for (;;) {
    const found = pathSolutions(puzzle(), 2);
    const other = found.find((s) => s.some((c, i) => c !== line[i]));
    if (!other) break;
    // Pin down the first square where the other solution goes its own way. (Numbers fix the order
    // of their squares, not the step they're reached at, so skip the steps already numbered; two
    // different lines always differ somewhere else too.)
    const i = other.findIndex((c, k) => c !== line[k] && !at.has(k));
    at.add(i);
  }
  // Take away every number the solution doesn't need...
  for (const i of shuffle([...at].filter((i) => i !== 0 && i !== total - 1), rand)) {
    at.delete(i);
    if (pathSolutions(puzzle(), 2).length !== 1) at.add(i);
  }
  // ...then give some back on easier days (more numbers never make a second solution).
  const sorted = [...at].sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) {
    for (let i = sorted[k - 1] + gap; i < sorted[k]; i += gap) at.add(Math.min(sorted[k] - 1, i - Math.floor(rand() * 2)));
  }
  return { ...puzzle(), solution: line };
}

// ---------------------------------------------------------------- zones

/** The stars that break a rule: same row, column or zone as another, or touching another. */
export function zonesConflicts(p, stars) {
  const bad = new Set();
  const list = [...stars];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (Math.floor(a / p.n) === Math.floor(b / p.n) || a % p.n === b % p.n || p.regions[a] === p.regions[b] || touching(p.n, a, b)) {
        bad.add(a);
        bad.add(b);
      }
    }
  }
  return bad;
}

/** True when `stars` (squares) solve the zones puzzle `p`. */
export const zonesSolved = (p, stars) => [...stars].length === p.n && zonesConflicts(p, stars).size === 0;

/** Up to `limit` solutions of the zones puzzle `p` (each a list of squares, one per row). */
export function zonesSolutions(p, limit = 2) {
  const { n, regions } = p;
  const cols = new Uint8Array(n);
  const zones = new Uint8Array(n);
  const stars = [];
  const found = [];
  function go(r) {
    if (found.length >= limit) return;
    if (r === n) {
      found.push(stars.slice());
      return;
    }
    for (let k = 0; k < n; k++) {
      const c = r * n + k;
      const z = regions[c];
      if (cols[k] || zones[z]) continue;
      if (r > 0 && Math.abs((stars[r - 1] % n) - k) <= 1) continue;
      cols[k] = zones[z] = 1;
      stars.push(c);
      go(r + 1);
      stars.pop();
      cols[k] = zones[z] = 0;
    }
  }
  go(0);
  return found;
}

/** One star per row and column, none touching: a random answer to build zones around. */
function randomStars(n, rand) {
  const cols = [];
  const used = new Set();
  const go = (r) => {
    if (r === n) return true;
    for (const k of shuffle([...Array(n).keys()], rand)) {
      if (used.has(k) || (r > 0 && Math.abs(cols[r - 1] - k) <= 1)) continue;
      used.add(k);
      cols.push(k);
      if (go(r + 1)) return true;
      cols.pop();
      used.delete(k);
    }
    return false;
  };
  go(0);
  return cols.map((k, r) => r * n + k);
}

/** A zones puzzle with one solution: zones grown at random around a hidden answer. */
export function makeZones(n, rand) {
  for (;;) {
    const stars = randomStars(n, rand);
    // Zone numbers (and so colours) in random order: never "zone k has its star in row k".
    const label = shuffle([...Array(n).keys()], rand);
    for (let attempt = 0; attempt < 400; attempt++) {
      const regions = Array(n * n).fill(-1);
      stars.forEach((c, r) => (regions[c] = label[r]));
      let open = n * n - n;
      while (open > 0) {
        const c = Math.floor(rand() * n * n);
        if (regions[c] !== -1) continue;
        const near = sides(n, c).filter((x) => regions[x] !== -1);
        if (!near.length) continue;
        regions[c] = regions[pick(near, rand)];
        open--;
      }
      const p = { kind: 'zones', n, regions };
      if (zonesSolutions(p, 2).length === 1) return { ...p, solution: stars };
    }
  }
}

// ---------------------------------------------------------------- the stored form

/** "6|0,13,22" for a path, "7|0011…" for zones: small enough to ship a year of them. */
export function encode(p) {
  return p.kind === 'path' ? `${p.n}|${p.hints.join(',')}` : `${p.n}|${p.regions.join('')}`;
}

export function decode(kind, text) {
  const [size, body] = text.split('|');
  const n = Number(size);
  return kind === 'path' ? { kind, n, hints: body.split(',').map(Number) } : { kind, n, regions: [...body].map(Number) };
}
