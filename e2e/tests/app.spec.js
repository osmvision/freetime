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

/** Opens the app as a new user and skips the welcome window. */
async function openDiscover(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('.coupon')).toBeVisible();
}

const leadTitle = (page) => page.locator('.coupon').getByRole('heading').first();

test('a new user sees the welcome window, then a lead idea and the rest of the book', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set me up' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.locator('.coupon')).toBeVisible();
  await expect(leadTitle(page)).not.toBeEmpty();
  await expect(page.locator('.leaf').first()).toBeVisible();
  expect(errors).toEqual([]);
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
