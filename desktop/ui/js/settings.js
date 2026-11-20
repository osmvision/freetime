// Display, city, interests, language, updates, your data, help. Nothing here needs an account,
// except "On all your devices" (shown signed in, and only sends when you press it).

import { profileSection } from './account.js';
import { api, inTauri } from './api.js';
import { cityPicker, openMeteoCredit } from './city.js';
import { btn, emptyState, errText, h, icon, pageHead, toast } from './dom.js';
import { openProblemReport } from './problem.js';
import { photoCredits } from './photos.js';
import { locale, preferredLang, setLang } from './i18n.js';
import { updatesBody } from './updates.js';
import { supportBody } from './support.js';
import { TEXT_SIZES, THEMES, availableTextSizes, displayState, onDisplayChange, setHighContrast, setTextSize, setTheme } from './display.js';
import { applyExtra, localExtra } from './shortcuts.js';

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

export async function render(root, ctx, options = {}) {
  root.replaceChildren(head(), h('div', { class: 'ghost', style: 'height:420px' }));
  try {
    draw(root, ctx, await api.settings());
    if (options.focus === 'profile') root.querySelector('.profile-box')?.scrollIntoView({ block: 'start' });
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
    mistral_key: '',
    clear_mistral_key: false,
    assistant_model: s.assistant_model,
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

  const profileBox = h('div', { class: 'profile-box' });
  profileSection(profileBox, () => ctx.accountChanged?.());
  root.replaceChildren(
    head(),
    profileBox,
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
        displaySection(),
        locationSection(s, ctx, root, (box) => (cityBox = box)),
        interestsSection(form),
        languageSection(),
        section('download', 'Updates', inTauri ? 'New versions come from freetime’s GitHub releases and are signed: anything else is refused.' : 'The web version updates when you reopen it.', null, updatesBody()),
        dataSection(s),
        devicesSection(),
        problemSection(),
        supportSection(),
        creditsSection(),
      ),
      h('div', { class: 'save-bar' }, h('span', { class: 'hint' }, 'Your picks refresh right after saving.'), save),
    ),
  );
}

// ---------------------------------------------------------------- sections

/** Text size, night mode and high contrast: applied at once, no need to press Save. */
function displaySection() {
  const pct = (size) => `${Math.round(size.zoom * 100)}%`;
  const status = h('span', { class: 'status' });

  const sizes = TEXT_SIZES.map((size) =>
    h(
      'button',
      { type: 'button', class: 'size-choice', 'data-size': size.id, onclick: () => setTextSize(size.id) },
      h('span', { class: 'size-sample', 'aria-hidden': 'true' }, 'Aa'),
      h('span', {}, size.label),
      h('span', { class: 'size-pct' }, pct(size)),
    ),
  );
  const themes = THEMES.map((theme) =>
    h('button', { type: 'button', class: 'mode-choice', 'data-theme-id': theme.id, onclick: () => setTheme(theme.id) }, icon(theme.icon), theme.label),
  );
  const contrastBtn = h(
    'button',
    { type: 'button', class: 'mode-choice switch', role: 'switch', onclick: () => setHighContrast(!displayState().contrast) },
    icon('contrast'),
    h('span', { class: 'switch-label' }, 'High contrast'),
    h('span', { class: 'switch-state' }),
  );

  function show({ size, theme, dark, contrast }) {
    const notes = [size.id !== 'normal' ? `Text ${pct(size)}` : null, dark ? 'Night' : null, contrast ? 'High contrast' : null].filter(Boolean);
    status.className = notes.length ? 'status on' : 'status off';
    // One text node per note, so the translation layer can translate each one.
    status.replaceChildren(...(notes.length ? notes.flatMap((n, i) => (i ? [' · ', n] : [n])) : ['Default']));
    for (const b of sizes) {
      b.hidden = !availableTextSizes().some((s) => s.id === b.dataset.size);
      b.setAttribute('aria-pressed', String(b.dataset.size === size.id));
    }
    for (const b of themes) b.setAttribute('aria-pressed', String(b.dataset.themeId === theme.id));
    contrastBtn.setAttribute('aria-checked', String(contrast));
    contrastBtn.querySelector('.switch-state').textContent = contrast ? 'On' : 'Off';
  }
  show(displayState());
  const off = onDisplayChange((state) => {
    if (!status.isConnected) return off();
    show(state);
  });

  return section(
    'eye',
    'Display',
    'Bigger text, night mode and high contrast. Applied right away and kept on this computer.',
    status,
    h('span', { class: 'field-label' }, 'Low vision mode: text size'),
    h('div', { class: 'size-choices', role: 'group', 'aria-label': 'Text size' }, sizes),
    h('span', { class: 'hint' }, 'Shortcuts: Ctrl + Plus to enlarge, Ctrl + Minus to shrink, Ctrl + 0 to reset.'),
    h('span', { class: 'field-label' }, 'Colours'),
    h('div', { class: 'mode-choices', role: 'group', 'aria-label': 'Theme' }, themes),
    contrastBtn,
    h('span', { class: 'hint' }, 'High contrast uses pure black and white with solid outlines, by day or by night.'),
  );
}

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

/** Automatic (follows Windows), English or French. Changing it reloads the window. */
function languageSection() {
  const current = preferredLang();
  const choices = [
    ['auto', 'Automatic'],
    ['en', 'English'],
    ['fr', 'Français'],
  ];
  return section(
    'graduation-cap',
    'Language',
    'The app’s language. “Automatic” follows Windows.',
    null,
    h(
      'div',
      { class: 'row', role: 'group', 'aria-label': 'Language' },
      choices.map(([id, label]) =>
        h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(current === id), onclick: () => { if (id !== current) setLang(id); } }, label),
      ),
    ),
  );
}

function dataSection(s) {
  return section(
    'folder-open',
    'Your data',
    inTauri ? 'Settings, history and caches stay on this computer. API keys are stored in plain text in the config file.' : 'Preferences and history stay in this browser. Personal API keys last for this tab session. Clearing browser data removes local data.',
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
        inTauri ? 'Open data folder' : 'Export local data',
      ),
    ),
  );
}

/**
 * "On all your devices": your Discover shortcuts, usual context and what tunes your picks (ratings
 * and "not now" answers), saved to your account and brought to another device, only on a click.
 * Hidden when signed out.
 */
function devicesSection() {
  const status = h('p', { class: 'hint', role: 'status' }, 'Checking…');
  const when = (iso) => new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const showSaved = (at) => {
    status.textContent = at ? `Last saved to your account: ${when(at)}` : 'Nothing saved to your account yet.';
    bring.disabled = !at;
    forget.disabled = !at;
  };
  const run = async (button, work) => {
    button.disabled = true;
    try {
      await work();
    } catch (e) {
      toast(errText(e), 'error', 6000);
    } finally {
      button.disabled = false;
    }
  };
  const save = btn({
    label: 'Save to my account',
    icon: 'upload',
    kind: 'primary',
    small: true,
    onclick: () =>
      run(save, async () => {
        showSaved(await api.savePreferences(localExtra()));
        toast('Saved: open freetime on another device and bring them there', 'ok', 5000);
      }),
  });
  const bring = btn({
    label: 'Bring them here',
    icon: 'download',
    small: true,
    onclick: () =>
      run(bring, async () => {
        const got = await api.loadPreferences();
        if (!got) return showSaved(null);
        applyExtra(got.extra);
        showSaved(got.saved_at);
        toast(got.added ? `Brought here, with ${got.added} new things learned about your tastes` : 'Brought here: shortcuts and context updated', 'ok', 5000);
      }),
  });
  const forget = btn({
    label: 'Delete the saved copy',
    icon: 'trash-2',
    kind: 'quiet',
    small: true,
    onclick: () =>
      run(forget, async () => {
        await api.forgetPreferences();
        showSaved(null);
        toast('The copy in your account is deleted. This device keeps its own.', 'ok');
      }),
  });
  const box = section(
    'cloud',
    'On all your devices',
    'Your Discover shortcuts, your usual context and what freetime learned about your tastes, carried from Windows to the browser, a phone or Linux. Nothing is sent unless you press a button.',
    null,
    h('div', { class: 'row' }, save, bring, forget),
    status,
  );
  box.hidden = true;
  api
    .accountStatus()
    .then(async (st) => {
      if (!st.signed_in) return;
      box.hidden = false;
      try {
        showSaved((await api.preferencesStatus())?.saved_at ?? null);
      } catch {
        status.textContent = 'Can’t reach your account right now.';
      }
    })
    .catch(() => {});
  return box;
}

/** "Report a problem": a short form to the freetime team, signed in or not. */
function problemSection() {
  return section(
    'flag',
    'Report a problem',
    'Something doesn’t work, or you can’t sign in? Tell the freetime team: every report is read.',
    null,
    h('div', { class: 'row' }, btn({ label: 'Report a problem', icon: 'flag', kind: 'primary', onclick: () => openProblemReport('settings') })),
  );
}

/** Donations: shown only once a Ko-fi or GitHub Sponsors page is set in support.json. */
function supportSection() {
  const body = supportBody();
  if (!body) return null;
  return section('heart', 'Support freetime', 'freetime is free, with no ads and no tracking. If it gives you good hours, you can help keep it that way.', null, body);
}

/** The bundled idea photos are free-licensed; their authors are credited here. */
function creditsSection() {
  const credits = Object.entries(photoCredits());
  if (!credits.length) return null;
  const nice = (id) => id.replace(/-/g, ' ');
  return section(
    'info',
    'Photo credits',
    'Idea photos come from Flickr and Wikimedia Commons (found with Openverse) under free licenses. Steam and YouTube artwork belongs to its owners.',
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
