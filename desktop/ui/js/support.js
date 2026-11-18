// "Support freetime": donation links (support.json). Nothing is sent anywhere: the buttons only
// open the page in the browser, and freetime never learns who gave or how much.

import { api } from './api.js';
import { errText, h, icon, toast } from './dom.js';

let links = [];

export async function loadSupport() {
  try {
    const res = await fetch('support.json');
    const s = res.ok ? await res.json() : {};
    links = [
      s.kofi && { label: 'Buy us a coffee on Ko-fi', icon: 'coffee', url: `https://ko-fi.com/${encodeURIComponent(s.kofi)}` },
      s.github_sponsors && { label: 'Sponsor on GitHub', icon: 'heart', url: `https://github.com/sponsors/${encodeURIComponent(s.github_sponsors)}` },
    ].filter(Boolean);
  } catch {
    links = [];
  }
}

/** The Settings section body, or null when no donation link is set up. */
export function supportBody() {
  if (!links.length) return null;
  return [
    h(
      'div',
      { class: 'row support-links' },
      links.map((l, i) =>
        h(
          'button',
          {
            type: 'button',
            class: i === 0 ? 'btn primary small' : 'btn small',
            onclick: () => api.open(l.url).catch((e) => toast(errText(e), 'error')),
          },
          icon(l.icon),
          l.label,
        ),
      ),
    ),
    h('p', { class: 'hint' }, 'Opens in your browser. freetime never knows who gives or how much.'),
  ];
}
