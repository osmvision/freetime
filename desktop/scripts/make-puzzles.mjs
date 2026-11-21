// Makes the puzzles of the day ahead of time, the same for everyone, into
// desktop/ui/js/puzzles/days.js. Each puzzle is checked to have exactly one solution.
// Run again to add more days (same seed: the days already made come out the same):
//   node desktop/scripts/make-puzzles.mjs [last day, default 2027-12-31]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode, makePath, makeZones, pathSolutions, seeded, zonesSolutions } from '../ui/js/puzzles/logic.js';

export const FIRST_DAY = '2026-11-16'; // a Monday: puzzle #1
const last = process.argv[2] ?? '2027-12-31';

// Easy at the start of the week, hardest at the weekend. getUTCDay: 0 Sunday … 6 Saturday.
const LEVELS = {
  easy: { path: { n: 6, gap: 4 }, zones: 6 },
  medium: { path: { n: 7, gap: 6 }, zones: 7 },
  hard: { path: { n: 7, gap: Infinity }, zones: 8 },
};
const levelOf = (weekday) => (weekday === 1 || weekday === 2 ? 'easy' : weekday === 0 || weekday === 6 ? 'hard' : 'medium');

const days = [];
const end = Date.parse(`${last}T00:00:00Z`);
for (let t = Date.parse(`${FIRST_DAY}T00:00:00Z`); t <= end; t += 86400000) {
  const date = new Date(t).toISOString().slice(0, 10);
  const level = LEVELS[levelOf(new Date(t).getUTCDay())];
  const path = makePath(level.path.n, seeded(`freetime-path-${date}`), { gap: level.path.gap });
  const zones = makeZones(level.zones, seeded(`freetime-zones-${date}`));
  if (pathSolutions(path, 2).length !== 1 || zonesSolutions(zones, 2).length !== 1) throw new Error(`${date}: not a single solution`);
  days.push([encode(path), encode(zones)]);
}

const out = join(import.meta.dirname, '..', 'ui', 'js', 'puzzles', 'days.js');
writeFileSync(
  out,
  '// Made by desktop/scripts/make-puzzles.mjs: do not edit. One path and one zones puzzle a day,\n' +
    `// from ${FIRST_DAY} (#1) to ${last}. Each has exactly one solution.\n` +
    `export const FIRST_DAY = '${FIRST_DAY}';\n` +
    `export const DAYS = [\n${days.map((d) => `  ${JSON.stringify(d)},`).join('\n')}\n];\n`,
);
console.log(`${days.length} days written to ${out}`);
