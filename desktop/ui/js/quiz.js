// The daily quiz: 5 questions, the same for everyone today, in French or English. Questions ship
// with the app (core/data/quiz.toml), so it works offline; results stay on this PC.
// After it, a bonus quiz from Open Trivia DB (English only, CC BY-SA 4.0), fetched only on request.

import { api } from './api.js';
import { btn, errText, fill, h, icon, reducedMotion, toast } from './dom.js';
import { currentLang } from './i18n.js';

const LETTERS = ['A', 'B', 'C', 'D'];

/** The question's text in the app's language. Marked translate="no": it's already translated. */
function pick(q) {
  if (q.bonus) return { text: q.question, choices: q.choices, why: null };
  const fr = currentLang() === 'fr';
  return { text: fr ? q.fr : q.en, choices: fr ? q.fr_choices : q.en_choices, why: fr ? q.fr_why : q.en_why };
}

/** The small ticket on Discover and in the book. */
export function quizCard(data, onOpen) {
  if (!data) return null;
  const done = data.result;
  return h(
    'div',
    { class: `mini-ticket quiz${done ? ' done' : ''}` },
    h('span', { class: 'mini-icon' }, icon('graduation-cap')),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, 'Quiz of the day'),
      h('strong', {}, done ? `${done.score}/${done.total} today` : '5 questions · 2 min'),
      h('span', { class: 'mini-sub' }, data.streak >= 2 ? `${data.streak} days in a row` : done ? 'A new quiz tomorrow' : 'The same for everyone today'),
    ),
    done
      ? btn({ label: 'Bonus quiz (in English)', icon: 'sparkles', square: true, onclick: openBonus })
      : btn({ label: 'Play', icon: 'play', kind: 'primary', square: true, onclick: onOpen }),
  );
}

/** Fetches 5 Open Trivia DB questions and opens them as a bonus round (nothing is saved). */
export async function openBonus() {
  let list;
  try {
    list = await api.bonusQuiz();
  } catch (e) {
    toast(errText(e), 'error', 5000);
    return;
  }
  openQuiz({ questions: list.map((q) => ({ ...q, bonus: true })) }, () => {}, { bonus: true });
}

/** Opens the quiz. `onDone(result)` runs after the score is saved. */
export function openQuiz(data, onDone = () => {}, { bonus = false } = {}) {
  if (data.result && !bonus) return;
  const answers = [];
  let i = 0;
  const previousFocus = document.activeElement;

  const dots = h('div', { class: 'quiz-dots', 'aria-hidden': 'true' }, data.questions.map(() => h('span', { class: 'quiz-dot' })));
  const counter = h('span', { class: 'figures' });
  const body = h('div', { class: 'quiz-body' });
  const card = h(
    'section',
    { class: 'quiz', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'quiz-question' },
    h(
      'div',
      { class: 'coupon-head' },
      h('span', {}, bonus ? 'Bonus quiz · in English' : 'Quiz of the day'),
      h('span', { class: 'quiz-head-end' }, counter, h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close the quiz', onclick: close }, icon('x'))),
    ),
    dots,
    body,
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') return close();
    const n = '1234'.indexOf(e.key) >= 0 ? '1234'.indexOf(e.key) : 'abcd'.indexOf(e.key.toLowerCase());
    const choice = body.querySelectorAll('.quiz-choice')[n];
    if (n >= 0 && choice && !choice.disabled && e.key.length === 1) choice.click();
  }

  function showQuestion() {
    const q = data.questions[i];
    const t = pick(q);
    counter.textContent = `${i + 1}/${data.questions.length}`;
    dots.children[i]?.classList.add('current');
    const next = h('div', { class: 'quiz-next' });
    const why = h('div', { class: 'quiz-why', hidden: true });
    const choices = t.choices.map((c, k) =>
      h(
        'button',
        { type: 'button', class: 'quiz-choice', onclick: () => answer(k) },
        h('span', { class: 'quiz-letter' }, LETTERS[k]),
        h('span', { translate: 'no' }, c),
      ),
    );
    body.replaceChildren(h('h2', { id: 'quiz-question', class: 'quiz-question', translate: 'no' }, t.text), h('div', { class: 'quiz-choices' }, choices), why, next);
    choices[0].focus();

    function answer(k) {
      answers.push(k);
      const right = k === q.answer;
      for (const [n, b] of choices.entries()) {
        b.disabled = true;
        if (n === q.answer) b.classList.add('right');
        else if (n === k) b.classList.add('wrong');
      }
      const dot = dots.children[i];
      dot.classList.remove('current');
      dot.classList.add(right ? 'right' : 'wrong');
      why.hidden = false;
      fill(
        why,
        h('strong', { class: right ? 'quiz-verdict right' : 'quiz-verdict wrong' }, icon(right ? 'check' : 'x'), right ? 'Right!' : 'Not quite'),
        t.why ? h('p', { translate: 'no' }, t.why) : right ? null : h('p', {}, h('span', {}, 'Answer: '), h('span', { translate: 'no' }, t.choices[q.answer])),
      );
      const last = i === data.questions.length - 1;
      const go = btn({ label: last ? 'See my score' : 'Next question', icon: last ? 'award' : 'arrow-right', kind: 'primary', onclick: last ? finish : () => { i += 1; showQuestion(); } });
      next.replaceChildren(go);
      go.focus();
    }
  }

  async function finish() {
    if (bonus) return finishBonus();
    let r;
    try {
      r = await api.finishQuiz(answers);
      api.syncPoints().catch(() => {});
    } catch (e) {
      toast(errText(e), 'error');
      return;
    }
    counter.textContent = '';
    const message = r.score === r.total ? 'Perfect score!' : r.score >= 3 ? 'Well played!' : 'Good try. A new quiz tomorrow!';
    body.replaceChildren(
      h(
        'div',
        { class: 'quiz-end' },
        h('div', { class: 'quiz-score' }, h('span', { class: 'quiz-big' }, String(r.score)), h('span', { class: 'quiz-of' }, `/${r.total}`)),
        h('p', { class: 'quiz-message' }, message),
        r.streak >= 2 ? h('p', { class: 'quiz-streak' }, icon('flame'), `${r.streak} days in a row`) : null,
        h('p', { class: 'mini-sub' }, 'Counted as a Learn pick: it helps your weekly challenge and badges.'),
        h(
          'div',
          { class: 'quiz-end-actions' },
          btn({ label: 'Close', kind: 'primary', onclick: close }),
          btn({ label: 'Bonus quiz (in English)', icon: 'sparkles', onclick: () => { close(); openBonus(); } }),
        ),
        h('div', { class: `stamp validated${reducedMotion() ? ' still' : ''}`, 'aria-hidden': 'true' }, 'Stamped'),
      ),
    );
    body.querySelector('.btn').focus();
    onDone(r);
  }

  /** Bonus round: scored here, saved nowhere, with the credit Open Trivia DB's license asks for. */
  function finishBonus() {
    counter.textContent = '';
    const score = answers.filter((a, n) => a === data.questions[n].answer).length;
    const total = data.questions.length;
    body.replaceChildren(
      h(
        'div',
        { class: 'quiz-end' },
        h('div', { class: 'quiz-score' }, h('span', { class: 'quiz-big' }, String(score)), h('span', { class: 'quiz-of' }, `/${total}`)),
        h('p', { class: 'quiz-message' }, score === total ? 'Perfect score!' : score >= 3 ? 'Well played!' : 'Good try!'),
        h(
          'div',
          { class: 'quiz-end-actions' },
          btn({ label: 'Close', kind: 'primary', onclick: close }),
          btn({ label: 'Another round', icon: 'refresh-cw', onclick: () => { close(); openBonus(); } }),
        ),
        h(
          'p',
          { class: 'quiz-credit' },
          'Questions: ',
          h('button', { type: 'button', class: 'link', onclick: () => api.open('https://opentdb.com/').catch(() => {}) }, 'Open Trivia Database'),
          ', CC BY-SA 4.0',
        ),
      ),
    );
    body.querySelector('.btn').focus();
  }

  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  showQuestion();
}
