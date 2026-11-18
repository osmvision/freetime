// City search with autocomplete (Open-Meteo geocoding). Searches only while the user types.

import { api } from './api.js';
import { errText, h } from './dom.js';

/**
 * An input with a suggestion list. `onPick(place)` runs when a city is chosen: by clicking a
 * suggestion, by Enter (best match), or through `box.resolve()` when the surrounding form is
 * saved with a typed but unpicked city.
 */
export function cityPicker({ onPick, placeholder = 'Search your city', label = 'City' }) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder,
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
  });
  const list = h('div', { class: 'city-results', role: 'listbox', hidden: true });
  const status = h('div', { class: 'city-status', 'aria-live': 'polite' });
  let timer = null;
  let seq = 0;
  let results = [];
  let active = -1;
  let picked = false;

  const say = (text, kind = '') => {
    status.textContent = text;
    status.className = kind ? `city-status ${kind}` : 'city-status';
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const choose = (place) => {
    picked = true;
    input.value = place.name;
    close();
    say('');
    return onPick(place);
  };
  const render = () => {
    list.replaceChildren(
      ...results.map((p, i) =>
        h(
          'button',
          {
            type: 'button',
            class: i === active ? 'city-option active' : 'city-option',
            role: 'option',
            'aria-selected': String(i === active),
            // mousedown, not click: the input's blur would close the list first.
            onmousedown: (e) => {
              e.preventDefault();
              choose(p);
            },
          },
          h('strong', {}, p.name),
          h('span', {}, [p.admin1, p.country].filter(Boolean).join(', ')),
        ),
      ),
    );
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };

  async function search(query) {
    const mine = ++seq;
    say('Searching…');
    try {
      const found = await api.searchCities(query);
      if (mine !== seq) return null;
      results = Array.isArray(found) ? found : [];
      say(results.length ? 'Pick your city in the list, or press Enter for the first one.' : `No city called “${query}”. Check the spelling?`, results.length ? '' : 'warn');
    } catch (e) {
      if (mine !== seq) return null;
      results = [];
      say(`Couldn’t reach the city search: ${errText(e)}`, 'warn');
    }
    active = -1;
    render();
    return results;
  }

  input.addEventListener('input', () => {
    picked = false;
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      seq++;
      results = [];
      render();
      say(query ? 'Keep typing…' : '');
      return;
    }
    timer = setTimeout(() => search(query), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Never submit the surrounding form from here.
      e.preventDefault();
      if (results.length) choose(results[Math.max(active, 0)]);
      else resolve();
    } else if (list.hidden) {
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, results.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => {
    if (!picked && results.length) render();
  });

  /** A city was typed but not picked: take the best match. Resolves to the place, or null. */
  async function resolve() {
    const query = input.value.trim();
    if (picked || query.length < 2) return null;
    clearTimeout(timer);
    const found = await search(query);
    if (!found?.length) return null;
    await choose(found[0]);
    return found[0];
  }

  const box = h('div', { class: 'city-picker' }, h('div', { class: 'city-field' }, input, list), status);
  box.focusInput = () => input.focus();
  box.resolve = resolve;
  return box;
}

/** "Weather data by Open-Meteo.com", required attribution for the free API. */
export function openMeteoCredit() {
  return h(
    'div',
    { class: 'attribution' },
    'Weather data by ',
    h('button', { type: 'button', class: 'link', onclick: () => api.open('https://open-meteo.com/') }, 'Open-Meteo.com'),
  );
}
