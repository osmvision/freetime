// City search with autocomplete (Open-Meteo geocoding). Searches only while the user types.

import { api } from './api.js';
import { h } from './dom.js';

/** An input with a suggestion list. `onPick(place)` runs when a city is chosen. */
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
  let timer = null;
  let seq = 0;
  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const choose = (place) => {
    input.value = place.name;
    close();
    onPick(place);
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

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      results = [];
      render();
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const found = await api.searchCities(query);
        if (mine !== seq) return;
        results = found;
      } catch {
        if (mine !== seq) return;
        results = [];
      }
      active = -1;
      render();
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Never submit the surrounding form from here.
      e.preventDefault();
      if (results.length) choose(results[Math.max(active, 0)]);
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

  const box = h('div', { class: 'city-picker' }, input, list);
  box.focusInput = () => input.focus();
  return box;
}

/** "Weather data by Open-Meteo.com", required attribution for the free API. */
export function openMeteoCredit() {
  return h(
    'div',
    { class: 'attribution' },
    'Weather data by ',
    h('button', { type: 'button', class: 'link-btn', onclick: () => api.open('https://open-meteo.com/') }, 'Open-Meteo.com'),
  );
}
