// City, interests, Steam and YouTube connections. API keys are write-only: the UI never sees them.

import { api } from './api.js';
import { cityPicker, openMeteoCredit } from './city.js';
import { emptyState, errText, h, icon, pageHead, toast } from './dom.js';
import { photoCredits } from './photos.js';

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
  root.replaceChildren(head(), h('div', { class: 'ghost', style: 'height:420px' }));
  try {
    draw(root, ctx, await api.settings());
  } catch (e) {
    root.replaceChildren(head(), emptyState({ icon: 'triangle-alert', title: 'Could not load your settings', text: errText(e) }));
  }
}

function draw(root, ctx, s) {
  const form = {
    interests: [...s.interests],
    steam_key: '',
    clear_steam_key: false,
    steam_profile: s.steam_id ?? '',
    youtube_key: '',
    clear_youtube_key: false,
    channels: [...s.channels],
  };
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

  let cityBox = null;

  async function submit() {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      // A city typed but not picked from the list: take the best match first, one write at a time.
      await cityBox?.resolve();
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
        locationSection(s, ctx, root, (box) => (cityBox = box)),
        interestsSection(form),
        steamSection(s, form, ctx, root),
        youtubeSection(s, form),
        dataSection(s),
        creditsSection(),
      ),
      h('div', { class: 'save-bar' }, h('span', { class: 'hint' }, 'Your picks refresh right after saving.'), save),
    ),
  );
}

// ---------------------------------------------------------------- sections

function locationSection(s, ctx, root, keep) {
  const apply = async (place) => {
    try {
      const settings = await api.setCity(place);
      toast(place ? `City set to ${place.name}` : 'City removed: no weather', 'ok');
      ctx.settingsSaved?.();
      draw(root, ctx, settings);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  const region = s.region?.country
    ? `Prices and currency follow your Windows region: ${s.region.country}${s.region.currency ? ` · ${s.region.currency}` : ''}.`
    : 'Prices follow Steam’s own guess (no Windows region found).';
  return section(
    'map-pin',
    'Location',
    'Your city is only used to check the weather, so outdoor ideas rank high when it’s nice out.',
    pill(Boolean(s.city), s.city ?? 'Not set'),
    labeled(s.city ? 'Change city' : 'City', keepBox(cityPicker({ onPick: apply, placeholder: 'e.g. Lyon, Montréal, Tokyo' }), keep)),
    s.city ? h('div', {}, h('button', { type: 'button', class: 'btn small', onclick: () => apply(null) }, 'Remove city')) : null,
    h('span', { class: 'hint' }, region),
    openMeteoCredit(),
  );
}

function keepBox(box, keep) {
  keep(box);
  return box;
}

function interestsSection(form) {
  const ideas = h('div', { class: 'suggest' });
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
    'heart',
    'Interests',
    'Topics used to find YouTube videos for you.',
    null,
    tags,
    h('span', { class: 'field-label' }, 'Ideas'),
    ideas,
  );
}

function steamSection(s, form, ctx, root) {
  const st = s.steam;
  const day = (unix) => new Date(unix * 1000).toLocaleDateString();
  const picker = h('div', { class: 'row' });
  const label = st.imported ? 'Re-import my games from Steam on this PC' : 'Import my games from Steam on this PC';
  const importBtn = h('button', { type: 'button', class: 'btn', onclick: () => startImport() }, label);

  async function finish(steamId) {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      const done = await api.steamImport(steamId);
      toast(`${done.status.games} games imported (${done.status.installed} installed)`, 'ok', 4500);
      for (const note of done.notes) toast(note, 'error', 7000);
      ctx.settingsSaved?.();
      render(root, ctx);
    } catch (e) {
      toast(errText(e), 'error', 7000);
      importBtn.disabled = false;
      importBtn.textContent = label;
    }
  }

  // Only now are Steam's folder and the allowed files read.
  async function startImport() {
    try {
      const scan = await api.steamScan();
      if (scan.chosen) return finish(scan.chosen);
      if (!scan.found) {
        toast('Steam isn’t installed on this PC. Paste your SteamID and add a Web API key to import from your account.', 'error', 7000);
        return;
      }
      if (!scan.accounts.length) {
        toast('No Steam account has used this PC yet.', 'error');
        return;
      }
      if (scan.accounts.length === 1) return finish(scan.accounts[0].steam_id64);
      picker.replaceChildren(
        h('span', { class: 'field-label' }, 'Which account?'),
        ...scan.accounts.map((a) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              onclick: () => {
                picker.replaceChildren();
                finish(a.steam_id64);
              },
            },
            a.last_used ? `${a.steam_id64} · last used ${day(a.last_used)}` : a.steam_id64,
          ),
        ),
      );
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  async function forget() {
    try {
      await api.steamForget();
      toast('Imported games forgotten', 'ok');
      ctx.settingsSaved?.();
      render(root, ctx);
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  return section(
    'gamepad-2',
    'Steam',
    'freetime never reads Steam’s files on its own. Import your games once (installed games and playtime), and re-import after installing new ones.',
    pill(st.imported, st.imported ? `${st.games} games` : 'Not imported'),
    h(
      'div',
      { class: 'row' },
      importBtn,
      st.imported ? h('button', { type: 'button', class: 'btn small quiet', onclick: forget }, 'Forget imported games') : null,
    ),
    st.imported
      ? h(
          'span',
          { class: 'hint' },
          `Imported ${day(st.imported_at)} ${st.from_web_api ? 'from your Steam account' : 'from this PC'} · SteamID ${st.steam_id64}`,
        )
      : null,
    picker,
    labeled(
      'Or paste your SteamID64 or profile URL',
      input({
        value: form.steam_profile,
        placeholder: '7656119… or steamcommunity.com/profiles/7656119…',
        'aria-label': 'SteamID64 or profile URL',
        oninput: (e) => (form.steam_profile = e.target.value),
      }),
      'Saved with “Save changes”, then used by the import instead of asking.',
    ),
    keyField({
      label: 'Web API key (optional)',
      isSet: s.steam_key_set,
      fromEnv: s.steam_key_from_env,
      envName: 'STEAM_API_KEY',
      getUrl: 'https://steamcommunity.com/dev/apikey',
      onInput: (v) => (form.steam_key = v),
      onClear: (v) => (form.clear_steam_key = v),
    }),
    h('span', { class: 'hint' }, 'With a key, the import also lists every game on your account, with playtime. Game details must be public.'),
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
    'circle-play',
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
    'folder-open',
    'Your data',
    'Settings, history and caches stay on this computer. API keys are stored in plain text in the config file.',
    null,
    h(
      'div',
      { class: 'paths' },
      h('div', {}, h('span', { class: 'field-label' }, 'Config '), h('code', {}, s.config_path)),
      h('div', {}, h('span', { class: 'field-label' }, 'Data '), h('code', {}, s.data_dir)),
    ),
    h(
      'div',
      {},
      h(
        'button',
        { type: 'button', class: 'btn small', onclick: () => api.openDataDir().catch((e) => toast(errText(e), 'error')) },
        icon('folder-open'),
        'Open data folder',
      ),
    ),
  );
}

/** The bundled idea photos are free-licensed; their authors are credited here. */
function creditsSection() {
  const credits = Object.entries(photoCredits());
  if (!credits.length) return null;
  const nice = (id) => id.replace(/-/g, ' ');
  return section(
    'info',
    'Photo credits',
    'Idea photos come from Wikimedia Commons under free licenses. Steam and YouTube artwork belongs to its owners.',
    null,
    h(
      'ul',
      { class: 'credits' },
      credits.map(([id, c]) =>
        h(
          'li',
          {},
          h('button', { type: 'button', class: 'link', onclick: () => api.open(c.page).catch((e) => toast(errText(e), 'error')) }, nice(id)),
          `: ${c.author}, ${c.license}`,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- building blocks

function section(iconName, title, desc, status, ...children) {
  return h(
    'section',
    { class: 'panel section' },
    h('div', { class: 'section-top' }, icon(iconName), h('h2', {}, title), status),
    desc ? h('p', { class: 'section-desc' }, desc) : null,
    children,
  );
}

function pill(on, text) {
  return h('span', { class: on ? 'status on' : 'status off' }, text);
}

/** A field with a label; extra strings become hints underneath. */
function labeled(text, control, ...extras) {
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, text),
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
    placeholder: isSet ? 'Saved (leave empty to keep it)' : 'Paste your key here',
    'aria-label': label,
    oninput: (e) => onInput(e.target.value),
  });
  return labeled(
    label,
    h(
      'div',
      { class: 'row' },
      field,
      h(
        'button',
        { type: 'button', class: 'btn small', onclick: () => api.open(getUrl).catch((e) => toast(errText(e), 'error')) },
        icon('external-link'),
        'Get a key',
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
          { class: 'chip-tag' },
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
            icon('x'),
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
