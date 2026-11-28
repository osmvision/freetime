// What a new user does in the first minutes, signed out. Each test checks that the page shows its
// real content, not only that nothing threw: a page that catches its own error and shows
// "Could not load…" passes a no-error check but fails here.

import { test, expect } from '@playwright/test';

/** Errors thrown in the page. Signed-out requests answered 400 are expected and not counted. */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/**
 * The first idea of a new user. Alone, it shows in under a second; right after the server starts,
 * with every worker opening a browser at once, it has been seen to take up to 12 s. Only this first
 * appearance gets the extra time: every other check keeps the default 5 s.
 */
const FIRST_IDEA = { timeout: 20000 };

/** Opens the app as a new user and skips the welcome window. */
async function openDiscover(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('.coupon')).toBeVisible(FIRST_IDEA);
}

const leadTitle = (page) => page.locator('.coupon').getByRole('heading').first();

test('a new user sees the welcome window, then a lead idea and the rest of the book', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set me up' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.locator('.coupon')).toBeVisible(FIRST_IDEA);
  await expect(leadTitle(page)).not.toBeEmpty();
  await expect(page.locator('.leaf').first()).toBeVisible();
  expect(errors).toEqual([]);
});

// The best pick leads: its Start button is on screen when Discover opens, without scrolling, on a
// small laptop and on a phone (where the context folds into one line that opens on a tap).
for (const [device, viewport] of [['a small laptop', { width: 1280, height: 720 }], ['a phone', { width: 390, height: 844 }]]) {
  test(`Start is on screen without scrolling on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openDiscover(page);
    const start = page.locator('.coupon').getByRole('button', { name: 'Start' }).first();
    // Nearly all of it: a long idea can leave its bottom edge a pixel short on a 720 px screen.
    await expect(start).toBeInViewport({ ratio: 0.9 });
    // Not hidden under the bottom navigation on a phone either.
    const nav = await page.locator('.nav').boundingBox();
    const box = await start.boundingBox();
    if (nav && nav.y > box.y) expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
  });
}

// The top bar fits on laptops, in French (the longest tab names), with the sign-in chip in view.
test.describe('in French', () => {
  test.use({ locale: 'fr-FR' });

  test('the top bar fits from 1101 to 1440 px wide', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Plus tard' }).click();
    await expect(page.locator('.coupon')).toBeVisible(FIRST_IDEA);
    await expect(page.locator('.tag-sync')).toBeVisible();
    for (const view of ['discover', 'history']) {
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      for (const width of [1101, 1180, 1280, 1366, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        const overflow = await page.locator('.topbar').evaluate((bar) => bar.scrollWidth - bar.clientWidth);
        expect(overflow, `${view} at ${width} px`).toBe(0);
        await expect(page.locator('#me-chip')).toBeInViewport({ ratio: 1 });
      }
    }
  });
});

test('the bar asks for the city only where Discover does not already ask', async ({ page }) => {
  await openDiscover(page);
  await expect(page.getByText('Where are you?')).toBeVisible();
  const cityTag = page.locator('.topbar').getByRole('button', { name: 'Set your city' });
  await expect(page.locator('.tag-sync')).toBeVisible();
  await expect(cityTag).toBeHidden();
  await page.locator('.nav-item[data-view="history"]').click();
  await expect(cityTag).toBeVisible();
  await cityTag.click();
  await expect(page.locator('#view-settings')).toBeVisible();
});

// When the online sources arrive, the picks refresh by themselves. The ticket the user is reading
// stays put; a new best pick opens the book below instead. The first answer is made partial (as
// before Steam, YouTube and the weather are in) and the second one puts another idea on top.
test('the automatic refresh keeps the ticket on screen', async ({ page }) => {
  let calls = 0;
  // The refresh answers only once the test has looked at the first ticket.
  let looked;
  const lookedAt = new Promise((resolve) => { looked = resolve; });
  await page.route('**/api/invoke', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.cmd !== 'suggest') return route.continue();
    calls += 1;
    if (calls > 1) await lookedAt;
    const response = await route.fetch();
    const json = await response.json();
    const res = json.value;
    if (calls === 1) res.partial = true;
    else if (res.best && res.groups[0]?.items.length) {
      const next = res.groups[0].items.shift();
      res.groups[0].items.unshift(res.best);
      res.best = next;
    }
    await route.fulfill({ response, json });
  });
  await openDiscover(page);
  const title = await leadTitle(page).textContent();
  await page.locator('.coupon').first().evaluate((el) => { el.dataset.seen = 'yes'; });
  await expect(page.locator('.partial-note')).toBeVisible();
  looked();

  await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.partial-note')).toHaveCount(0);
  // The same ticket, not a new one with the same title.
  await expect(page.locator('.coupon[data-seen="yes"]')).toBeVisible();
  await expect(leadTitle(page)).toHaveText(title);
  // The new best pick opens the rest of the book.
  await expect(page.locator('.leaf').first()).not.toContainText(title);
});

// After Start, the idea is in progress: "I'm done" asks how it was right away, not next time.
test('Start, then "I’m done" and one tap to say how it was', async ({ page }) => {
  page.on('popup', (popup) => popup.close().catch(() => {}));
  await openDiscover(page);
  const title = await leadTitle(page).textContent();
  await page.locator('.coupon').getByRole('button', { name: 'Start' }).first().click();

  const strip = page.locator('.now-strip');
  await expect(strip).toContainText('In progress:');
  await expect(strip).toContainText(title);
  // The ticket can't be started twice.
  await expect(page.locator('.coupon').getByRole('button', { name: 'In progress' })).toBeDisabled();

  // Still there after a reload: people leave to do the thing and come back.
  await page.reload();
  await expect(strip).toContainText(title);

  await strip.getByRole('button', { name: 'I’m done' }).click();
  const rate = page.locator('#view-discover .strip').filter({ hasText: `How was ${title}?` });
  await expect(rate.getByRole('button', { name: 'Loved it' })).toBeFocused();
  await rate.getByRole('button', { name: 'Loved it' }).click();
  await expect(page.getByText('Noted: more ideas like that')).toBeVisible();
  await expect(rate).toHaveCount(0);
  await expect(strip).toHaveCount(0);

  // Answered once: a reload doesn't ask again.
  await page.reload();
  await expect(page.locator('.coupon')).toBeVisible(FIRST_IDEA);
  await expect(page.locator('#view-discover .strip').filter({ hasText: title })).toHaveCount(0);
});

test('on a phone, the context folds into one line that opens on a tap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDiscover(page);
  const summary = page.locator('.filters-summary');
  await expect(summary).toBeVisible();
  await expect(page.locator('.context')).toBeHidden();

  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.context').getByRole('button', { name: /^Time:/ }).click();
  await page.locator('.menu .option', { hasText: '30 min' }).click();
  await expect(summary).toContainText('30 min');
});

test('every main page opens without an error', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  for (const name of ['Games', 'Friends', 'Messages', 'History', 'Settings', 'Discover']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByText(/^Could not load/)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('"Not this one" replaces the lead idea and asks why', async ({ page }) => {
  await openDiscover(page);
  const before = (await leadTitle(page).textContent()).trim();

  await page.locator('.coupon').getByRole('button', { name: 'Not this one' }).click();

  const why = page.locator('.not-now');
  await expect(why).toContainText(before);
  await expect(why.getByRole('button', { name: 'Too long' })).toBeVisible();
  await expect(leadTitle(page)).not.toHaveText(before);

  await why.getByRole('button', { name: 'Another time' }).click();
  await expect(page.getByText('Noted: it will come back in a few days')).toBeVisible();
  await expect(why).toHaveCount(0);
});

test('"Not now" on an idea of the book removes it and asks why', async ({ page }) => {
  await openDiscover(page);
  const leaf = page.locator('.leaf').first();
  const title = (await leaf.getByRole('heading').textContent()).trim();

  await leaf.getByRole('button', { name: `Not now: ${title}` }).click();

  await expect(page.locator('.leaf', { hasText: title })).toHaveCount(0);
  await expect(page.locator('.not-now')).toContainText(title);
});

test('"Never suggest" hides an idea, and Settings brings it back', async ({ page }) => {
  await openDiscover(page);
  const leaf = page.locator('.leaf').first();
  const title = (await leaf.getByRole('heading').textContent()).trim();

  await leaf.getByRole('button', { name: `Never suggest: ${title}` }).click();
  await expect(page.locator('.leaf', { hasText: title })).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const hidden = page.locator('section', { has: page.getByRole('heading', { name: 'Hidden ideas' }) });
  const entry = hidden.locator('.entry', { hasText: title });
  await expect(entry).toBeVisible();

  await entry.getByRole('button', { name: 'Show again' }).click();
  await expect(hidden.locator('.entry', { hasText: title })).toHaveCount(0);
});

test('Settings: add your own idea, then remove it', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const mine = page.locator('section', { has: page.getByRole('heading', { name: 'Your own ideas' }) });
  await mine.getByPlaceholder('e.g. Feed the ducks at the lake').fill('Feed the ducks at the lake');
  await mine.getByRole('button', { name: 'Add this idea' }).click();

  const entry = mine.locator('.my-ideas .entry', { hasText: 'Feed the ducks at the lake' });
  await expect(entry).toBeVisible();

  await entry.getByRole('button', { name: 'Remove: Feed the ducks at the lake' }).click();
  await expect(entry).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the app speaks French when the browser does', async ({ browser }) => {
  const page = await browser.newPage({ locale: 'fr-FR' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Plus tard' })).toBeVisible();
  await page.close();
});

test('a game against the computer: your turn is marked, a win ends on an idea to try', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  // A Four in a row game saved one move before your win: three of yours along the bottom row.
  await page.evaluate(() => {
    const board = Array(42).fill(-1);
    for (const cell of [35, 36, 37]) board[cell] = 0;
    for (const cell of [28, 29, 30]) board[cell] = 1;
    const state = { game: 'four', board, last: 30, line: null, turn: 0, winner: null, plies: 6 };
    localStorage.setItem('freetime.play.four', JSON.stringify({ state, secrets: [null, null], level: 1, humanFirst: true }));
  });
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.locator('.game-tile-four').getByRole('button', { name: 'Computer' }).click();

  const game = page.getByRole('dialog', { name: 'Four in a row' });
  await expect(game.locator('.game-status.mine')).toContainText('Your turn');
  await expect(game.getByRole('button', { name: 'Game sounds' })).toHaveAttribute('aria-pressed', 'false');

  await game.getByRole('button', { name: 'Column 4' }).click();
  await expect(game.locator('.game-status')).toContainText('You won!');
  await expect(game.locator('.game-status.mine')).toHaveCount(0);
  const idea = game.locator('.game-idea');
  await expect(idea).toBeVisible();
  await expect(idea.locator('strong')).not.toBeEmpty();
  await expect(idea.getByRole('button', { name: 'Try it' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the puzzles of the day: solve both, and they stay solved with their time', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const section = page.locator('.puzzles');
  await expect(section.getByRole('heading', { name: 'Games of the day' })).toBeVisible();
  const number = Number((await section.locator('.puzzle-card .mini-sub').first().textContent()).replace('#', ''));

  // The answers, from the puzzles the app ships (their solver is the generator's).
  const answers = await page.evaluate(async (n) => {
    const { DAYS } = await import('/js/puzzles/days.js');
    const L = await import('/js/puzzles/logic.js');
    const [path, zones] = DAYS[(n - 1) % DAYS.length];
    return { path: L.pathSolutions(L.decode('path', path), 1)[0], zones: L.zonesSolutions(L.decode('zones', zones), 1)[0] };
  }, number);

  await section.getByRole('button', { name: 'Play: Zones of the day' }).click();
  const zones = page.getByRole('dialog', { name: 'Zones of the day' });
  for (const c of answers.zones) {
    const cell = zones.locator(`[data-cell="${c}"]`);
    await cell.click(); // a cross
    await cell.click(); // a star
  }
  await expect(zones.locator('.game-status')).toContainText('Solved in');
  await zones.getByRole('button', { name: 'Close', exact: true }).last().click();

  await section.getByRole('button', { name: 'Play: Path of the day' }).click();
  const path = page.getByRole('dialog', { name: 'Path of the day' });
  for (const c of answers.path) await path.locator(`[data-cell="${c}"]`).click();
  await expect(path.locator('.game-status')).toContainText('Solved in');
  await path.getByRole('button', { name: 'Close', exact: true }).last().click();

  await expect(section.locator('.puzzle-card.done')).toHaveCount(2);
  await expect(section.getByRole('button', { name: 'Share my time' })).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await expect(page.locator('.puzzles .puzzle-card.done')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('guess the activity: five photos, the right titles score, and the round is kept', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const section = page.locator('.puzzles');
  await section.getByRole('button', { name: 'Play: Guess the activity' }).click();
  const game = page.getByRole('dialog', { name: 'Guess the activity' });
  await expect(game.locator('.guess-choice')).toHaveCount(4);
  // Today's answers, from the same command the window used.
  const answers = await page.evaluate(async () => {
    const { api } = await import('/js/api.js');
    const { photoCredits } = await import('/js/photos.js');
    return (await api.guessRound(Object.keys(photoCredits()))).map((r) => r.choices[r.answer]);
  });
  for (const [i, title] of answers.entries()) {
    await game.locator('.guess-choice', { hasText: title }).click();
    await expect(game.locator('.guess-verdict')).toContainText('+');
    await game.getByRole('button', { name: i === answers.length - 1 ? 'See my score' : 'Next photo' }).click();
  }
  await expect(game.locator('.game-status')).toContainText('/50');
  await expect(game.locator('.guess-recap-row')).toHaveCount(5);
  await game.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(section.locator('.puzzle-card.done')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the problem of the day: a wrong move is undone, the winning line solves it', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const section = page.locator('.puzzles');
  const number = Number((await section.locator('.puzzle-card .mini-sub').first().textContent()).replace('#', ''));
  // The winning line against the computer's defence, worked out with the app's own modules.
  const plan = await page.evaluate(async (n) => {
    const { problemOf } = await import('/js/puzzles/problem.js');
    const P = await import('/js/puzzles/problems.js');
    const { play } = await import('/js/play/rules.js');
    const p = problemOf(n);
    let state = p.state;
    const mine = [];
    for (let left = p.n; left > 0 && state.winner === null; left--) {
      const m = P.winningMoves(state, p.player, left, 1)[0];
      mine.push(m);
      state = play(state, p.player, m).state;
      if (state.winner !== null) break;
      state = play(state, state.turn, P.bestDefence(state, p.player, left - 1)).state;
    }
    const wrong = P.winningMoves(p.state, p.player, p.n);
    const { legalMoves } = await import('/js/play/rules.js');
    const bad = legalMoves(p.state, p.player).find((m) => !wrong.some((w) => JSON.stringify(w) === JSON.stringify(m)));
    return { game: p.game, mine, bad };
  }, number);
  await section.getByRole('button', { name: 'Play: Problem of the day' }).click();
  const game = page.getByRole('dialog', { name: 'Problem of the day' });
  const playMove = async (m) => {
    if (plan.game === 'four') await game.getByRole('button', { name: `Column ${m.col + 1}`, exact: true }).click();
    else {
      await game.locator(`[data-cell="${m.from}"]`).click();
      await game.locator(`[data-cell="${m.to}"]`).click();
      if (m.promo) await game.getByRole('button', { name: { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[m.promo] }).click();
    }
  };
  if (plan.bad) {
    await playMove(plan.bad);
    await expect(game.locator('.game-status')).toContainText('Not the winning move');
    await expect(game.locator('.game-status.mine')).toBeVisible({ timeout: 5000 });
  }
  for (const m of plan.mine) {
    await expect(game.locator('.game-status.mine')).toBeVisible({ timeout: 5000 });
    await playMove(m);
  }
  await expect(game.locator('.game-status')).toContainText('Solved in', { timeout: 5000 });
  await game.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(section.locator('.puzzle-card.done')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the classics: reversi, awalé and ultimate tic-tac-toe play against the computer', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  for (const [id, name] of [['reversi', 'Reversi'], ['awale', 'Awalé'], ['ultimate', 'Ultimate tic-tac-toe']]) {
    await page.locator(`.game-tile-${id}`).getByRole('button', { name: 'Computer' }).click();
    const game = page.getByRole('dialog', { name });
    for (let i = 0; i < 3; i++) {
      await expect(game.locator('.game-status.mine')).toBeVisible({ timeout: 8000 });
      await game.locator('button:not([disabled])[data-cell]').first().click();
    }
    await expect(game.locator('.game-status.mine')).toBeVisible({ timeout: 8000 });
    await game.getByRole('button', { name: 'Close', exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test('variants: a smaller dots and boxes, and the swap opening of giant tic-tac-toe', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscover(page);
  await page.getByRole('button', { name: 'Games', exact: true }).click();

  await page.locator('.game-tile-dots').getByRole('button', { name: 'Computer' }).click();
  const dots = page.getByRole('dialog', { name: 'Dots and boxes' });
  await dots.getByRole('radio', { name: '3 × 3' }).click();
  await expect(dots.locator('.dot-line')).toHaveCount(24);
  await expect(dots.getByRole('radio', { name: '3 × 3' })).toHaveAttribute('aria-checked', 'true');
  await dots.getByRole('button', { name: 'Close', exact: true }).click();

  await page.locator('.game-tile-gomoku').getByRole('button', { name: 'Computer' }).click();
  const go = page.getByRole('dialog', { name: 'Giant tic-tac-toe' });
  await go.getByRole('radio', { name: 'Swap' }).click();
  // Whoever opens, the three stones get placed and someone chooses; then the game goes on.
  await expect(go.locator('.game-status.mine')).toBeVisible({ timeout: 8000 });
  for (let i = 0; i < 6 && !(await go.locator('.go-choose').count()); i++) {
    if (await go.locator('.game-status.mine').count()) await go.locator('.go-cell:not([disabled])').nth(40 + i).click();
    await page.waitForTimeout(700);
  }
  if (await go.locator('.go-choose').count()) await go.getByRole('button', { name: 'Take the two stones' }).click();
  await expect(go.locator('.go-choose')).toHaveCount(0, { timeout: 8000 });
  expect(errors).toEqual([]);
});
