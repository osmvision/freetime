// The first-run welcome: about 30 seconds to make the very first ticket a good one.
// Every step can be skipped; nothing leaves the PC except the city search and the Steam import,
// and only when the user uses them.

import { googleSignIn } from './account.js';
import { api, inTauri } from './api.js';
import { AVATAR_COLORS, AVATAR_ICONS, avatar } from './avatars.js';
import { cityPicker, openMeteoCredit } from './city.js';
import { btn, categoryIcon, errText, fill, h, icon, toast } from './dom.js';

const MOOD_KEY = 'freetime.mood.v2';
const TOPICS = ['speedrunning', 'space', 'chess', 'football highlights', 'lo-fi music', 'game dev', 'street food', 'documentaries', 'science explained', 'history', 'travel', 'cooking'];

/** Shows the welcome over the app. Resolves when finished or skipped; `then` is 'discover' or 'profile'. */
export function runWelcome(boot, ctx = {}) {
  return new Promise((resolve) => {
    const layer = h('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to freetime' });
    document.body.append(layer);
    const app = document.querySelector('.app');
    app.inert = true;

    const answers = {
      name: '',
      look: { icon: 0, color: 0 },
      city: boot.setup.city,
      categories: boot.categories.map((c) => c.id),
      topics: new Set(),
    };
    let step = 0;
    let account = null; // Set once the person signs in from the last step.

    const save = async (skipped = false) => {
      if (!skipped) saveCategories(answers.categories);
      await api.finishWelcome(skipped || !answers.topics.size ? null : [...answers.topics]);
    };

    const finish = async (then = 'discover', skipped = false) => {
      try {
        await save(skipped);
      } catch (e) {
        toast(errText(e), 'error');
      }
      app.inert = false;
      layer.remove();
      resolve(then);
    };

    const steps = [
      () => intro(next, () => finish('discover', true)),
      () => you(answers),
      () => where(answers),
      () => into(answers, boot.categories),
      () => games(),
      () =>
        done(answers, finish, account, {
          // On the web the page leaves for Google: the welcome is done before it does, or it would come back.
          before: inTauri ? null : () => save(),
          onSignedIn: (acc) => {
            account = acc;
            try {
              ctx.accountChanged?.();
            } catch {
              // The app catches up when the welcome closes.
            }
            draw();
          },
        }),
    ];
    const titles = ['Welcome', 'You', 'Where', 'Your mood', 'Your games', 'Ready'];

    async function next() {
      // Leaving "You": save the name and avatar into the friend code (local only).
      if (step === 1) {
        try {
          await api.myFriendCode(answers.name.trim() || 'Friend', answers.look);
        } catch (e) {
          toast(errText(e), 'error');
        }
      }
      if (step === 2 && !answers.city && !boot.setup.city) {
        api.setCity(null).catch(() => {});
      }
      step = Math.min(step + 1, steps.length - 1);
      draw();
    }

    function back() {
      step = Math.max(step - 1, 0);
      draw();
    }

    function draw() {
      const body = steps[step]();
      const first = step === 0;
      const last = step === steps.length - 1;
      fill(
        layer,
        h(
          'div',
          { class: 'welcome-ticket' },
          h(
            'div',
            { class: 'coupon-head' },
            h('span', {}, `Boarding · ${titles[step]}`),
            h('span', { class: 'figures' }, `${step + 1} / ${steps.length}`),
          ),
          h('div', { class: 'welcome-body' }, body),
          first || last
            ? null
            : h(
                'div',
                { class: 'welcome-nav' },
                btn({ label: 'Back', icon: 'chevron-left', kind: 'quiet', onclick: back }),
                h('span', { class: 'welcome-dots', 'aria-hidden': 'true' }, steps.map((_, i) => h('span', { class: i === step ? 'on' : '' }))),
                btn({ label: 'Next', icon: 'arrow-right', kind: 'primary', onclick: next }),
              ),
        ),
      );
      layer.scrollTop = 0;
      layer.querySelector('input, .btn.primary')?.focus({ preventScroll: true });
    }

    draw();
  });
}

function saveCategories(categories) {
  try {
    const saved = JSON.parse(localStorage.getItem(MOOD_KEY) ?? '{}') || {};
    localStorage.setItem(MOOD_KEY, JSON.stringify({ ...saved, categories }));
  } catch {
    // Storage unavailable: Discover starts with every kind of idea.
  }
}

// ---------------------------------------------------------------- the steps

function intro(start, skip) {
  return [
    h('h1', { class: 'welcome-title' }, 'Your free time, one ticket at a time'),
    h('p', { class: 'welcome-lead' }, 'Tell freetime how long you have and how you feel. It hands you the best thing to do right now: a game, a video, a run, a recipe, something new.'),
    h(
      'ul',
      { class: 'inside' },
      h('li', {}, icon('ticket'), 'One clear pick, with the reasons it fits'),
      h('li', {}, icon('thumbs-up'), 'Rate what you did, and the next picks get better'),
      h('li', {}, icon('users'), 'Find things to do with friends'),
      h('li', {}, icon('check'), 'Works offline. No account needed'),
    ),
    h('div', { class: 'row welcome-cta' }, btn({ label: 'Set me up', icon: 'arrow-right', kind: 'primary', onclick: start }), btn({ label: 'Skip for now', kind: 'quiet', onclick: skip })),
    h('p', { class: 'hint' }, 'About 30 seconds. Everything can be changed later in Settings.'),
  ];
}

function you(answers) {
  const name = h('input', { class: 'input', type: 'text', value: answers.name, maxlength: 24, placeholder: 'What friends call you', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Your name' });
  name.addEventListener('input', () => (answers.name = name.value));
  const preview = h('div', {});
  const icons = h('div', { class: 'look-icons', role: 'group', 'aria-label': 'Avatar icon' });
  const colors = h('div', { class: 'look-colors', role: 'group', 'aria-label': 'Avatar color' });
  const paint = () => {
    fill(preview, avatar(answers.look, 'lg'));
    fill(icons, AVATAR_ICONS.map((n, i) => h('button', { type: 'button', class: 'look-icon', 'aria-pressed': String(answers.look.icon === i), 'aria-label': n.replace(/-\d+$/, '').replace(/-/g, ' '), onclick: () => { answers.look.icon = i; paint(); } }, icon(n))));
    fill(colors, AVATAR_COLORS.map((c, i) => h('button', { type: 'button', class: 'look-color', vars: { '--av': c.hex }, 'aria-pressed': String(answers.look.color === i), 'aria-label': c.name, title: c.name, onclick: () => { answers.look.color = i; paint(); } }, answers.look.color === i ? icon('check') : null)));
  };
  paint();
  return [
    h('h2', { class: 'welcome-step' }, 'Who’s holding the ticket?'),
    h('div', { class: 'look' }, preview, h('label', { class: 'field look-name' }, h('span', { class: 'field-label' }, 'Your name'), name)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pick an icon'), icons),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'And a color'), colors),
    h('p', { class: 'hint' }, 'Stays on this PC. Friends see it only if you share your friend code or sign in.'),
  ];
}

function where(answers) {
  const chosen = h('div', { class: 'city-status' }, answers.city ? `Weather for ${answers.city}` : '');
  return [
    h('h2', { class: 'welcome-step' }, 'Where are you?'),
    h('p', { class: 'welcome-lead' }, 'Only for the weather: outdoor ideas show up when it’s nice out, indoor ones when it rains.'),
    cityPicker({
      onPick: async (place) => {
        try {
          await api.setCity(place);
          answers.city = place.name;
          chosen.textContent = `Weather for ${place.name}`;
          chosen.className = 'city-status ok';
        } catch (e) {
          chosen.textContent = errText(e);
          chosen.className = 'city-status warn';
        }
      },
      placeholder: 'Your city, e.g. Marseille',
    }),
    chosen,
    openMeteoCredit(),
  ];
}

function into(answers, categories) {
  const kinds = h('div', { class: 'welcome-kinds', role: 'group', 'aria-label': 'Kinds of ideas' });
  const paintKinds = () =>
    fill(
      kinds,
      categories.map((c) =>
        h(
          'button',
          {
            type: 'button',
            class: 'kind',
            'aria-pressed': String(answers.categories.includes(c.id)),
            onclick: () => {
              const on = answers.categories.includes(c.id);
              if (on && answers.categories.length === 1) return toast('Keep at least one kind of idea');
              answers.categories = on ? answers.categories.filter((x) => x !== c.id) : [...answers.categories, c.id];
              paintKinds();
            },
          },
          icon(categoryIcon(c.id)),
          h('span', {}, c.label),
        ),
      ),
    );
  paintKinds();
  const topics = h('div', { class: 'suggest', role: 'group', 'aria-label': 'Video topics' });
  const paintTopics = () =>
    fill(
      topics,
      TOPICS.map((t) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(answers.topics.has(t)),
            onclick: () => {
              if (answers.topics.has(t)) answers.topics.delete(t);
              else answers.topics.add(t);
              paintTopics();
            },
          },
          t,
        ),
      ),
    );
  paintTopics();
  return [
    h('h2', { class: 'welcome-step' }, 'What are you usually in the mood for?'),
    kinds,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Video topics you like (optional)'), topics),
  ];
}

function games() {
  if (!inTauri) return [
    h('h2', { class: 'welcome-step' }, 'Your Steam games'),
    h('p', { class: 'welcome-lead' }, 'You can import your public Steam library in Settings with your profile and a Web API key. Built-in ideas are ready now.'),
  ];
  const status = h('div', { class: 'city-status', 'aria-live': 'polite' });
  const pick = h('div', { class: 'row' });
  const finishImport = async (id, button) => {
    if (button) button.disabled = true;
    status.className = 'city-status';
    status.textContent = 'Importing…';
    try {
      const done = await api.steamImport(id);
      status.className = 'city-status ok';
      status.textContent = `${done.status.games} games imported (${done.status.installed} installed)`;
      pick.replaceChildren();
    } catch (e) {
      status.className = 'city-status warn';
      status.textContent = errText(e);
      if (button) button.disabled = false;
    }
  };
  const go = btn({
    label: 'Import my games from Steam on this PC',
    icon: 'gamepad-2',
    onclick: async () => {
      try {
        const scan = await api.steamScan();
        if (scan.chosen) return finishImport(scan.chosen, go);
        if (!scan.found) {
          status.className = 'city-status warn';
          status.textContent = 'Steam isn’t installed on this PC. You can connect your account later in Settings.';
          return;
        }
        if (!scan.accounts.length) {
          status.className = 'city-status warn';
          status.textContent = 'No Steam account has used this PC yet.';
          return;
        }
        if (scan.accounts.length === 1) return finishImport(scan.accounts[0].steam_id64, go);
        fill(pick, h('span', { class: 'field-label' }, 'Which account?'), scan.accounts.map((a) => btn({ label: a.steam_id64, small: true, onclick: () => finishImport(a.steam_id64, null) })));
      } catch (e) {
        status.className = 'city-status warn';
        status.textContent = errText(e);
      }
    },
  });
  return [
    h('h2', { class: 'welcome-step' }, 'Your Steam games'),
    h('p', { class: 'welcome-lead' }, 'freetime can suggest games you already own, and find the ones you share with friends.'),
    h(
      'ul',
      { class: 'inside' },
      h('li', {}, icon('check'), 'Only when you click: freetime never reads Steam’s files on its own'),
      h('li', {}, icon('check'), 'Reads your game list and playtime, nothing else (no login data)'),
    ),
    h('div', { class: 'row' }, go),
    pick,
    status,
  ];
}

function done(answers, finish, account, google) {
  return [
    h('h1', { class: 'welcome-title' }, answers.name.trim() ? `You’re all set, ${answers.name.trim()}` : 'You’re all set'),
    h('p', { class: 'welcome-lead' }, 'Your first ticket is waiting. Rate what you do, and freetime learns what you like.'),
    h('div', { class: 'row welcome-cta' }, btn({ label: 'Show my first ticket', icon: 'ticket', kind: 'primary', onclick: () => finish('discover') })),
    account
      ? h('p', { class: 'welcome-account done' }, icon('check'), `Signed in as ${account.profile?.display_name ?? 'you'}`)
      : h(
          'div',
          { class: 'welcome-account' },
          h('strong', {}, 'Create your account'),
          h('p', { class: 'hint' }, 'Optional: with a Google account, add friends by tag, send them messages and play games together. Your email stays private.'),
          googleSignIn({ kind: '', before: google.before, onSignedIn: google.onSignedIn }),
        ),
  ];
}
