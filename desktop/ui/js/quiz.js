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

/** Topic names, in the app's language (the i18n dictionary would turn "History" into the tab name). */
const TOPICS = {
  art: ['Art', 'Art'],
  food: ['Food', 'Cuisine'],
  games: ['Games', 'Jeux'],
  geography: ['Geography', 'Géographie'],
  history: ['History', 'Histoire'],
  life: ['Everyday life', 'Vie quotidienne'],
  logic: ['Logic', 'Logique'],
  nature: ['Nature', 'Nature'],
  science: ['Science', 'Sciences'],
  space: ['Space', 'Espace'],
  sport: ['Sport', 'Sport'],
  words: ['Words', 'Mots'],
};

function topicName(t) {
  const names = TOPICS[t];
  if (!names) return t;
  return currentLang() === 'fr' ? names[1] : names[0];
}

/** The Games menu dot: on while today's quiz waits or a duel is your turn. */
const waiting = { quiz: false, duels: 0 };

function showDot() {
  const dot = document.getElementById('quiz-dot');
  if (dot) dot.hidden = !(waiting.quiz || waiting.duels > 0);
}

export function setQuizDot(pending) {
  waiting.quiz = pending;
  showDot();
}

/** How many duels wait for you. */
export function setDuelDot(count) {
  waiting.duels = count;
  showDot();
}

/** The big banner on Discover while today's quiz is waiting. Once played, the small card takes over. */
export function quizBanner(data, onOpen) {
  if (!data || data.result) return null;
  const topics = [...new Set(data.questions.map((q) => q.topic))];
  const streak =
    data.streak >= 2 ? `Keep your ${data.streak}-day streak` : data.streak === 1 ? 'Played yesterday: keep it going' : 'Start a streak today';
  return h(
    'section',
    { class: 'quiz-banner', 'aria-label': 'Quiz of the day', onclick: (e) => !e.target.closest('button') && onOpen() },
    h('span', { class: 'quiz-banner-icon' }, icon('graduation-cap')),
    h(
      'div',
      { class: 'quiz-banner-text' },
      h('span', { class: 'quiz-banner-k' }, 'Quiz of the day'),
      h('strong', {}, '5 questions · 2 min'),
      h('span', { class: 'quiz-banner-sub' }, 'The same for everyone today. 1 ranking point per right answer.'),
      h('ul', { class: 'quiz-topics', translate: 'no', 'aria-label': 'Topics' }, topics.map((t) => h('li', {}, topicName(t)))),
    ),
    h(
      'div',
      { class: 'quiz-banner-side' },
      h('span', { class: 'quiz-banner-streak' }, icon('flame'), streak),
      btn({ label: 'Play the quiz', icon: 'play', kind: 'primary', onclick: onOpen }),
    ),
  );
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

/** Opens the quiz, or today's score if it's already played. `onDone(result)` runs after the
 *  score is saved; the "quiz-done" event tells the rest of the app. With `duel`, it's one side of a
 *  quiz duel: answers aren't revealed until the end, and the server scores them. */
export function openQuiz(data, onDone = () => {}, { bonus = false, duel = null } = {}) {
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
      duel ? h('span', {}, h('span', {}, 'Quiz duel vs'), ' ', h('span', { translate: 'no' }, duel.other)) : h('span', {}, bonus ? 'Bonus quiz · in English' : 'Quiz of the day'),
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
    duel?.onClose?.();
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
      if (duel) return answerDuel(k);
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

    /** In a duel the answer stays secret until the end: mark the pick and move on. */
    function answerDuel(k) {
      for (const [n, b] of choices.entries()) {
        b.disabled = true;
        if (n === k) b.classList.add('picked');
      }
      const dot = dots.children[i];
      dot.classList.remove('current');
      dot.classList.add('done');
      const last = i === data.questions.length - 1;
      setTimeout(() => {
        if (!backdrop.isConnected) return;
        if (last) finish();
        else {
          i += 1;
          showQuestion();
        }
      }, reducedMotion() ? 0 : 450);
    }
  }

  async function finish() {
    if (bonus) return finishBonus();
    if (duel) return finishDuel();
    let r;
    try {
      r = await api.finishQuiz(answers);
      api.syncPoints().catch(() => {});
    } catch (e) {
      toast(errText(e), 'error');
      return;
    }
    showEnd(r, true);
    setQuizDot(false);
    document.dispatchEvent(new CustomEvent('quiz-done', { detail: r }));
    onDone(r);
  }

  /** The score screen: right after the last answer (`fresh`), or when reopening a played quiz. */
  function showEnd(r, fresh) {
    counter.textContent = '';
    dots.hidden = !fresh;
    const message = !fresh
      ? 'Done for today!'
      : r.score === r.total
        ? 'Perfect score!'
        : r.score >= 3
          ? 'Well played!'
          : 'Good try. A new quiz tomorrow!';
    body.replaceChildren(
      h(
        'div',
        { class: 'quiz-end' },
        h('div', { class: 'quiz-score' }, h('span', { class: 'quiz-big' }, String(r.score)), h('span', { class: 'quiz-of' }, `/${r.total}`)),
        h('p', { class: 'quiz-message' }, message),
        r.streak >= 2 ? h('p', { class: 'quiz-streak' }, icon('flame'), `${r.streak} days in a row`) : null,
        h('p', { class: 'mini-sub' }, fresh ? 'Counted as a Learn pick: it helps your weekly challenge and badges.' : 'A new quiz tomorrow'),
        h(
          'div',
          { class: 'quiz-end-actions' },
          btn({ label: 'Close', kind: 'primary', onclick: close }),
          btn({ label: 'Bonus quiz (in English)', icon: 'sparkles', onclick: () => { close(); openBonus(); } }),
          btn({
            label: 'Share my score',
            icon: 'send',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                await api.sharePost({ kind: 'quiz', idea_id: `quiz:${data.date}`, title: "Today's quiz", category: 'learn', detail: `${r.score}/${r.total}` });
                toast('Shared with your friends', 'ok');
              } catch (err) {
                toast(errText(err), 'error');
              }
            },
          }),
        ),
        h('div', { class: `stamp validated${!fresh || reducedMotion() ? ' still' : ''}`, 'aria-hidden': 'true' }, 'Stamped'),
      ),
    );
    body.querySelector('.btn').focus();
  }

  /** A duel: the server scores it. Shows each answer, and who won if the other already played. */
  async function finishDuel() {
    counter.textContent = '';
    fill(body, h('div', { class: 'quiz-end' }, h('p', { class: 'quiz-message' }, 'Checking your answers…')));
    let r;
    try {
      r = await api.playDuel(duel.id, duel.ids, answers);
    } catch (e) {
      fill(
        body,
        h(
          'div',
          { class: 'quiz-end' },
          h('p', { class: 'quiz-message' }, 'Your answers didn’t go through'),
          h('p', { class: 'mini-sub' }, errText(e)),
          h('div', { class: 'quiz-end-actions' }, btn({ label: 'Try again', icon: 'refresh-cw', kind: 'primary', onclick: finishDuel }), btn({ label: 'Close', onclick: close })),
        ),
      );
      return;
    }
    for (const [n, dot] of [...dots.children].entries()) {
      dot.classList.remove('done');
      dot.classList.add(answers[n] === r.key[n] ? 'right' : 'wrong');
    }
    const other = h('span', { translate: 'no' }, duel.other);
    let outcome;
    if (r.other_score == null) {
      outcome = h('p', { class: 'mini-sub' }, h('span', {}, 'Now it’s up to'), ' ', other, '. ', h('span', {}, 'You’ll see who won when they play.'));
    } else {
      const text = r.score > r.other_score ? 'You won!' : r.score < r.other_score ? 'You lost this one' : 'Draw!';
      outcome = h('div', {}, h('p', { class: 'quiz-message' }, text), h('p', { class: 'duel-vs' }, other, ' ', h('span', { class: 'figures' }, `${r.other_score}/5`)));
    }
    const review = h(
      'ol',
      { class: 'duel-review' },
      data.questions.map((q, n) => {
        const t = pick(q);
        const right = answers[n] === r.key[n];
        return h(
          'li',
          { class: right ? 'right' : 'wrong' },
          icon(right ? 'check' : 'x'),
          h('span', { translate: 'no' }, t.text),
          right ? null : h('span', { class: 'duel-answer' }, h('span', {}, 'Answer: '), h('span', { translate: 'no' }, t.choices[r.key[n]])),
        );
      }),
    );
    fill(
      body,
      h(
        'div',
        { class: 'quiz-end' },
        h('div', { class: 'quiz-score' }, h('span', { class: 'quiz-big' }, String(r.score)), h('span', { class: 'quiz-of' }, '/5')),
        outcome,
        review,
        h('div', { class: 'quiz-end-actions' }, btn({ label: 'Close', kind: 'primary', onclick: close })),
      ),
    );
    body.querySelector('.btn').focus();
    document.dispatchEvent(new CustomEvent('duel-played'));
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
  if (data.result && !bonus) showEnd({ ...data.result, streak: data.streak }, false);
  else showQuestion();
}
