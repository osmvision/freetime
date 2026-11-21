// Guess the activity: five photos of built-in ideas a day, the same for everyone (chosen by the
// core, core/src/guess.rs). Each photo starts zoomed in on one detail and slowly pulls back; the
// sooner you find which idea it shows, the more it scores (10 at most a photo). The round ends on
// the five ideas, each one a "Try it" away, with the photo credits their licences ask for.

import { api } from '../api.js';
import { btn, errText, fill, h, icon, toast } from '../dom.js';
import { gameWindow } from '../game-window.js';
import { t } from '../i18n.js';
import { photoCredits } from '../photos.js';
import { tryIdea } from '../play/screen.js';
import { sound } from '../play/sound.js';

export const GUESS_MAX = 50;
const REVEAL_MS = 10000; // from the detail to the whole photo
const ZOOM = 6;

const reduced = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Where the zoom starts, the same for everyone: a point in the middle part of the photo. */
function focus(text) {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
  const a = ((x >>> 0) % 1000) / 1000;
  const b = ((Math.imul(x, 2654435761) >>> 0) % 1000) / 1000;
  return [30 + a * 40, 30 + b * 40];
}

const photoId = (idea) => idea.id.replace(/^idea:/, '');

/** Points for a right answer after `ms`: 10 in the first second, down to 1. */
export const points = (ms) => Math.max(1, 10 - Math.floor(ms / 1000));

export async function openGuess(today, onDone = () => {}) {
  let rounds;
  try {
    rounds = await api.guessRound(Object.keys(photoCredits()));
  } catch (e) {
    toast(errText(e), 'error', 5000);
    return;
  }
  if (!rounds.length) {
    toast('No photos to guess today.', 'error');
    return;
  }
  let i = 0;
  let score = 0;
  let total = 0; // ms spent looking
  const results = [];
  let timers = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const ui = gameWindow({
    name: 'Guess the activity',
    iconName: 'image',
    head: h('span', { class: 'figures' }, `#${today.number}`),
    rule: 'Which idea is in the photo? It starts on a detail and pulls back: the sooner you know, the more it scores.',
    className: 'guess-window',
    onClose: clear,
  });
  const { status, area, tools, close } = ui;
  const step = h('span', { class: 'figures' });
  const tally = h('span', { class: 'figures guess-score' });
  status.append(step, tally);

  function show() {
    clear();
    const r = rounds[i];
    const credit = photoCredits()[photoId(r.idea)];
    step.textContent = `${i + 1}/${rounds.length}`;
    tally.textContent = `${score} pts`;
    const [fx, fy] = focus(`${today.date}-${r.idea.id}`);
    const img = h('img', { class: 'guess-img', src: `img/ideas/${photoId(r.idea)}.jpg`, alt: '', draggable: 'false' });
    img.style.transformOrigin = `${fx}% ${fy}%`;
    img.style.transform = `scale(${ZOOM})`;
    const frame = h('div', { class: 'guess-photo' }, img);
    const verdict = h('p', { class: 'guess-verdict', 'aria-live': 'polite' });
    let started = 0;
    let answered = false;

    // The pull-back starts once the photo is there, so a slow disk doesn't cost points.
    const start = () => {
      if (started) return;
      started = performance.now();
      if (reduced()) {
        // Three still steps instead of a moving zoom.
        [[3500, 2.6], [7000, 1.5], [REVEAL_MS, 1]].forEach(([ms, s]) => timers.push(setTimeout(() => !answered && (img.style.transform = `scale(${s})`), ms)));
      } else {
        requestAnimationFrame(() => {
          img.style.transition = `transform ${REVEAL_MS}ms cubic-bezier(0.3, 0, 0.7, 1)`;
          img.style.transform = 'scale(1)';
        });
      }
    };
    if (img.complete) start();
    else {
      img.addEventListener('load', start, { once: true });
      img.addEventListener('error', start, { once: true });
    }

    const choices = r.choices.map((title, k) =>
      h(
        'button',
        { type: 'button', class: 'guess-choice', onclick: () => answer(k) },
        h('span', { translate: 'no' }, title),
      ),
    );

    function answer(k) {
      if (answered) return;
      answered = true;
      clear();
      const ms = started ? performance.now() - started : REVEAL_MS;
      total += ms;
      const right = k === r.answer;
      const got = right ? points(ms) : 0;
      score += got;
      results.push({ idea: r.idea, got });
      sound(right ? 'box' : 'miss');
      // The whole photo, at once.
      img.style.transition = reduced() ? 'none' : 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
      img.style.transform = 'scale(1)';
      choices.forEach((b, j) => {
        b.disabled = true;
        if (j === r.answer) b.prepend(icon('check'));
        if (j === k && !right) b.prepend(icon('x'));
        b.classList.toggle('right', j === r.answer);
        b.classList.toggle('wrong', j === k && !right);
      });
      tally.textContent = `${score} pts`;
      fill(verdict, right ? h('strong', {}, h('span', { class: 'figures' }, `+${got}`), ' ', h('span', {}, got === 1 ? 'point' : 'points')) : h('strong', {}, 'Not this one'));
      const last = i === rounds.length - 1;
      const next = btn({ label: last ? 'See my score' : 'Next photo', icon: 'arrow-right', small: true, kind: 'primary', onclick: () => (last ? end() : (i++, show())) });
      fill(tools, next, btn({ label: 'Close', small: true, onclick: close }));
      next.focus();
    }

    fill(
      area,
      frame,
      credit ? h('p', { class: 'guess-credit credit' }, `Photo: ${credit.author} · ${credit.license}`) : null,
      h('div', { class: 'guess-choices', role: 'group', 'aria-label': 'Which idea is it?' }, choices),
      verdict,
    );
    fill(tools, btn({ label: 'Close', small: true, onclick: close }));
    choices[0].focus();
  }

  async function end() {
    clear();
    const secs = Math.round(total / 1000);
    sound(score >= GUESS_MAX / 2 ? 'win' : 'draw');
    let done = { secs, score };
    try {
      const view = await api.finishPuzzle('guess', secs, score);
      done = view.solved.guess ?? done;
      api.syncPoints().catch(() => {});
    } catch (e) {
      toast(errText(e), 'error', 5000);
    }
    fill(status, h('strong', { class: 'game-result won' }, h('span', { class: 'figures' }, `${done.score}/${GUESS_MAX}`), ' ', h('span', {}, 'points')));
    fill(
      area,
      h('p', { class: 'guess-end-hint' }, 'All five are real ideas. One of them for later?'),
      h(
        'ul',
        { class: 'guess-recap' },
        results.map(({ idea, got }) =>
          h(
            'li',
            { class: 'guess-recap-row' },
            h('img', { src: `img/ideas/${photoId(idea)}.jpg`, alt: '', loading: 'lazy' }),
            h('strong', { translate: 'no' }, idea.title),
            h('span', { class: `figures guess-got${got ? '' : ' none'}` }, `+${got}`),
            btn({ label: 'Try it', icon: 'arrow-right', small: true, onclick: () => tryIdea(idea, close) }),
          ),
        ),
      ),
    );
    fill(
      tools,
      btn({ label: 'Share my score', icon: 'share-2', small: true, kind: 'primary', onclick: () => shareGuess(today.number, done.score) }),
      btn({ label: 'Close', small: true, onclick: close }),
    );
    onDone();
  }

  show();
}

/** A spoiler-free line: the round and the score. */
export async function shareGuess(number, score) {
  const text = `freetime · ${t('Guess the activity')} #${number} · ${score}/${GUESS_MAX}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`${t('Copied')}: ${text}`, 'ok', 3500);
  } catch {
    toast(text, 'ok', 8000);
  }
}
