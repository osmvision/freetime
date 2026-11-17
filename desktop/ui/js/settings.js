// City, interests, Steam and YouTube connections. API keys are write-only: the UI never sees them.

import { api } from './api.js';
import { emptyState, errText, h, pageHead, toast } from './dom.js';

const INTEREST_IDEAS = [
  'speedrunning',
  'space',
  'chess',
  'football highlights',
  'lo-fi music',
  'game dev',
  'street food',
  'documentaries',
  'science explained',
  'history',
  'travel',
  'cooking',
];

const head = () => pageHead('Settings', 'Everything here is optional: freetime works offline too.');

export async function render(root, ctx) {
  root.replaceChildren(head(), h('div', { class: 'skeleton block' }));
  try {
    draw(root, ctx, await api.settings());
  } catch (e) {
    root.replaceChildren(head(), emptyState({ emoji: '😵', title: "Couldn't load your settings", text: errText(e) }));
  }
}

function draw(root, ctx, s) {
  const form = {
    city: s.city ?? '',
    interests: [...s.interests],
    steam_key: '',
    clear_steam_key: false,
    steam_profile: s.steam_id ?? '',
    youtube_key: '',
    clear_youtube_key: false,
    channels: [...s.channels],
  };
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

  async function submit() {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const report = await api.saveSettings(form);
      for (const m of report.messages) toast(m.text, m.ok ? 'ok' : 'error', 4500);
      ctx.settingsSaved?.();
      draw(root, ctx, report.settings);
    } catch (e) {
      toast(errText(e), 'error', 6000);
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  }

  root.replaceChildren(
    head(),
    h(
      'form',
      {
        class: 'settings-form',
        onsubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      h(
        'div',
        { class: 'settings' },
        locationSection(s, form),
        interestsSection(form),
        steamSection(s, form),
        youtubeSection(s, form),
        dataSection(s),
      ),
      h('div', { class: 'save-bar' }, h('span', { class: 'save-hint' }, 'Your picks refresh right after saving.'), save),
    ),
  );
}

// ---------------------------------------------------------------- sections

function locationSection(s, form) {
  return section(
    '📍',
    'Location',
    'Used to check the weather, so outdoor ideas only rank high when it’s nice out.',
    pill(Boolean(s.city), s.city ? `${s.city} · ${s.country.toUpperCase()}` : 'Not set'),
    labeled(
      'City',
      input({
        value: form.city,
        placeholder: 'e.g. Lyon, Montréal, Tokyo',
        'aria-label': 'City',
        oninput: (e) => (form.city = e.target.value),
      }),
    ),
  );
}

function interestsSection(form) {
  const ideas = h('div', { class: 'chips' });
  const tags = tagInput(form.interests, 'Add a topic, press Enter', () => drawIdeas());
  function drawIdeas() {
    const taken = new Set(form.interests.map((i) => i.toLowerCase()));
    ideas.replaceChildren(
      ...INTEREST_IDEAS.filter((i) => !taken.has(i))
        .slice(0, 8)
        .map((i) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip small',
              onclick: () => {
                form.interests.push(i);
                tags.redraw();
                drawIdeas();
              },
            },
            `+ ${i}`,
          ),
        ),
    );
  }
  drawIdeas();
  return section(
    '💡',
    'Interests',
    'Topics used to find YouTube videos for you.',
    null,
    tags,
    h('div', { class: 'sub-label' }, 'Ideas'),
    ideas,
  );
}

function steamSection(s, form) {
  const connected = s.steam_key_set && Boolean(s.steam_id);
  const status = connected ? 'Connected' : s.steam_key_set ? 'Add your profile' : 'Not connected';
  return section(
    '🎮',
    'Steam',
    'Connect your library to get picks from games you already own: your backlog, old favorites and comfort games.',
    pill(connected, status),
    keyField({
      label: 'Web API key',
      isSet: s.steam_key_set,
      fromEnv: s.steam_key_from_env,
      envName: 'STEAM_API_KEY',
      getUrl: 'https://steamcommunity.com/dev/apikey',
      onInput: (v) => (form.steam_key = v),
      onClear: (v) => (form.clear_steam_key = v),
    }),
    labeled(
      'Your profile',
      input({
        value: form.steam_profile,
        placeholder: 'Profile URL, custom URL name or SteamID64',
        'aria-label': 'Steam profile',
        oninput: (e) => (form.steam_profile = e.target.value),
      }),
      'Your Steam profile’s Privacy → Game details must be Public.',
    ),
  );
}

function youtubeSection(s, form) {
  const channelCount = s.channels.length;
  const status = s.youtube_key_set
    ? 'API connected'
    : channelCount
      ? `${channelCount} channel${channelCount > 1 ? 's' : ''}`
      : 'Not connected';
  return section(
    '📺',
    'YouTube',
    'Real videos that fit your free time, from your interests and the channels you follow.',
    pill(s.youtube_key_set || channelCount > 0, status),
    keyField({
      label: 'Data API key',
      isSet: s.youtube_key_set,
      fromEnv: s.youtube_key_from_env,
      envName: 'YOUTUBE_API_KEY',
      getUrl: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
      onInput: (v) => (form.youtube_key = v),
      onClear: (v) => (form.clear_youtube_key = v),
    }),
    labeled(
      'Channels you follow (no key needed)',
      tagInput(form.channels, 'Channel ID (starts with UC…), press Enter'),
      'On a channel page: About → Share channel → Copy channel ID.',
    ),
  );
}

function dataSection(s) {
  return section(
    '📁',
    'Your data',
    'Settings, history and caches stay on this computer. API keys are stored in plain text in the config file.',
    null,
    h(
      'div',
      { class: 'paths' },
      h('div', {}, h('span', { class: 'path-label' }, 'Config'), h('code', {}, s.config_path)),
      h('div', {}, h('span', { class: 'path-label' }, 'Data'), h('code', {}, s.data_dir)),
    ),
    h(
      'div',
      {},
      h(
        'button',
        { type: 'button', class: 'btn small', onclick: () => api.openDataDir().catch((e) => toast(errText(e), 'error')) },
        '📂 Open data folder',
      ),
    ),
  );
}

// ---------------------------------------------------------------- building blocks

function section(icon, title, desc, status, ...children) {
  return h(
    'section',
    { class: 'card section' },
    h('div', { class: 'section-head' }, h('h3', {}, h('span', { class: 'section-icon' }, icon), title), status),
    desc ? h('p', { class: 'section-desc' }, desc) : null,
    children,
  );
}

function pill(on, text) {
  return h('span', { class: on ? 'status-pill on' : 'status-pill off' }, text);
}

/** A field with a label; extra strings become hints underneath. */
function labeled(text, control, ...extras) {
  return h(
    'div',
    { class: 'lbl' },
    h('span', { class: 'lbl-text' }, text),
    control,
    extras.map((x) => (typeof x === 'string' ? h('span', { class: 'hint' }, x) : x)),
  );
}

function input(props) {
  return h('input', { class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off', ...props });
}

function keyField({ label, isSet, fromEnv, envName, getUrl, onInput, onClear }) {
  const field = input({
    type: 'password',
    placeholder: isSet ? '•••••••• saved (leave empty to keep it)' : 'Paste your key here',
    'aria-label': label,
    oninput: (e) => onInput(e.target.value),
  });
  return labeled(
    label,
    h(
      'div',
      { class: 'input-row' },
      field,
      h(
        'button',
        { type: 'button', class: 'btn small', onclick: () => api.open(getUrl).catch((e) => toast(errText(e), 'error')) },
        'Get a key ↗',
      ),
    ),
    fromEnv ? `Using ${envName} from your environment.` : null,
    isSet && !fromEnv
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => onClear(e.target.checked) }), 'Remove the saved key')
      : null,
  );
}

/** Chips you add with Enter (or a comma) and remove with × or Backspace. Edits `values` in place. */
function tagInput(values, placeholder, onChange = () => {}) {
  const box = h('div', { class: 'tags' });
  const field = h('input', { placeholder, 'aria-label': placeholder, spellcheck: 'false', autocomplete: 'off' });

  function draw() {
    box.replaceChildren(
      ...values.map((v, i) =>
        h(
          'span',
          { class: 'tag' },
          v,
          h(
            'button',
            {
              type: 'button',
              'aria-label': `Remove ${v}`,
              onclick: () => {
                values.splice(i, 1);
                draw();
                onChange();
              },
            },
            '×',
          ),
        ),
      ),
      field,
    );
  }

  function add(refocus) {
    const parts = field.value.split(',').map((p) => p.trim()).filter(Boolean);
    field.value = '';
    for (const p of parts) {
      if (!values.some((v) => v.toLowerCase() === p.toLowerCase())) values.push(p);
    }
    draw();
    onChange();
    if (refocus) field.focus();
  }

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (field.value.trim()) add(true);
    } else if (e.key === 'Backspace' && !field.value && values.length) {
      values.pop();
      draw();
      onChange();
      field.focus();
    }
  });
  // Typed but not confirmed when clicking Save: keep it.
  field.addEventListener('blur', () => {
    if (field.value.trim()) add(false);
  });
  box.addEventListener('click', (e) => {
    if (e.target === box) field.focus();
  });

  box.redraw = draw;
  draw();
  return box;
}
