// Shareable cards (phase D): "my month / my year on freetime", and a ticket for an idea with an
// invite link. Drawn here on a canvas from local data, then copied or saved to Downloads: nothing
// is uploaded. Only built-in idea photos (same origin) are drawn; other artwork would taint the
// canvas, so those cards get the category poster instead.

import { api } from './api.js';
import { btn, errText, h, icon, toast } from './dom.js';
import { currentLang, locale, t } from './i18n.js';
import { photoFor } from './photos.js';

const SITE = 'osmvision.github.io/freetime';
const INVITE = (tag) => `https://${SITE}/invite.html?tag=${encodeURIComponent(tag)}`;

const C = {
  navy: '#0d1b3d',
  navy2: '#162a55',
  ink: '#0d1b3d',
  paper: '#f2f2f0',
  white: '#ffffff',
  purple: '#4b2e83',
  lavender: '#e6dff1',
  lilac: '#cdbff0',
  red: '#d7262d',
  cream: '#f4f1ea',
  muted: '#5b6782',
};
const KIND = { game: '#4b2e83', video: '#3b4866', sport: '#1f6b4a', learn: '#1f4fa3', create: '#8a5a00', chill: '#0f5e63', social: '#7a2e5e', food: '#9a3f1c' };

const TEXT = {
  en: {
    my: (period) => `My ${period}`,
    on: 'on freetime',
    things: 'things done',
    hours: 'hours of free time',
    newIdeas: 'new things tried',
    days: 'active days',
    kinds: 'What I did',
    favourite: 'My favourite',
    quiz: (right, n) => `Quiz: ${right} right answers in ${n} ${n === 1 ? 'quiz' : 'quizzes'}`,
    yourTurn: 'Your turn:',
    admit: 'Admit one',
    withMe: 'Do it with me?',
    addMe: (tag) => `Add me on freetime: ${tag}`,
    cost: { free: 'Free', cheap: 'Cheap', paid: 'Paid' },
  },
  fr: {
    my: (period) => `Mon ${period}`,
    on: 'sur freetime',
    things: 'idées faites',
    hours: 'heures de temps libre',
    newIdeas: 'nouveautés essayées',
    days: 'jours actifs',
    kinds: 'Ce que j’ai fait',
    favourite: 'Mon idée préférée',
    quiz: (right, n) => `Quiz : ${right} bonnes réponses en ${n} quiz`,
    yourTurn: 'Et toi ?',
    admit: 'Bon pour un',
    withMe: 'On le fait ensemble ?',
    addMe: (tag) => `Ajoute-moi sur freetime : ${tag}`,
    cost: { free: 'Gratuit', cheap: 'Petit budget', paid: 'Payant' },
  },
};
const L = () => TEXT[currentLang() === 'fr' ? 'fr' : 'en'];

// ---------------------------------------------------------------- drawing helpers

async function fontsReady() {
  await Promise.all(
    ['800 80px "Barlow Condensed"', '700 40px "Barlow Condensed"', '500 30px "Barlow"', '700 28px "Courier Prime"'].map((f) => document.fonts.load(f).catch(() => null)),
  );
}

function rounded(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, hgt, r);
}

/** Writes text on up to `lines` lines within `width`, shrinking the font if needed. Returns the
 *  baseline of the last line written. */
function fitText(ctx, text, x, y, width, { size, weight = 800, family = 'Barlow Condensed', lineHeight = 0.95, lines = 2, color, upper = true }) {
  const s = upper ? text.toUpperCase() : text;
  for (let px = size; px >= size * 0.55; px -= 4) {
    ctx.font = `${weight} ${px}px "${family}"`;
    const words = s.split(/\s+/);
    const out = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width <= width) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
    if (out.length <= lines && out.every((l) => ctx.measureText(l).width <= width)) {
      ctx.fillStyle = color;
      out.forEach((l, i) => ctx.fillText(l, x, y + i * px * lineHeight));
      return y + (out.length - 1) * px * lineHeight;
    }
  }
  ctx.font = `${weight} ${Math.round(size * 0.55)}px "${family}"`;
  ctx.fillStyle = color;
  ctx.fillText(s.slice(0, 60), x, y);
  return y;
}

function perforation(ctx, x1, x2, y, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function dots(ctx, w, hgt, color) {
  ctx.fillStyle = color;
  for (let y = 18; y < hgt; y += 36) for (let x = 18; x < w; x += 36) ctx.fillRect(x, y, 2, 2);
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Draws `img` covering the box (like CSS object-fit: cover). */
function cover(ctx, img, x, y, w, hgt) {
  const scale = Math.max(w / img.width, hgt / img.height);
  const sw = w / scale;
  const sh = hgt / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, hgt);
}

// ---------------------------------------------------------------- the recap card

async function drawRecap(r, year) {
  await fontsReady();
  const tx = L();
  const W = 1080;
  const H = 1350;
  const canvas = h('canvas', { width: W, height: H });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.navy;
  ctx.fillRect(0, 0, W, H);
  dots(ctx, W, H, 'rgba(255,255,255,0.06)');

  // Head: wordmark and the period.
  ctx.font = '800 46px "Barlow Condensed"';
  ctx.fillStyle = C.cream;
  ctx.fillText('FREETIME', 70, 110);
  const from = new Date(`${r.from}T12:00:00`);
  const period = year ? String(from.getFullYear()) : from.toLocaleDateString(locale(), { month: 'long' });
  ctx.font = '700 26px "Courier Prime"';
  ctx.fillStyle = C.lilac;
  const stamp = `${tx.admit} · ${year ? from.getFullYear() : r.from.slice(0, 7)}`.toUpperCase();
  ctx.fillText(stamp, W - 70 - ctx.measureText(stamp).width, 106);

  // Title.
  let y = fitText(ctx, tx.my(period), 70, 250, W - 140, { size: 150, color: C.white, lines: 1 });
  ctx.font = '500 40px "Barlow"';
  ctx.fillStyle = C.lilac;
  ctx.fillText(tx.on, 74, y + 62);
  y += 102;

  // Four figures on white tickets.
  const hours = Math.round(r.minutes / 60);
  const figures = [
    [r.picks, tx.things],
    [hours, tx.hours],
    [r.new_ideas, tx.newIdeas],
    [r.days_active, tx.days],
  ];
  const gw = (W - 140 - 30) / 2;
  const gh = 170;
  figures.forEach(([n, label], i) => {
    const x = 70 + (i % 2) * (gw + 30);
    const top = y + Math.floor(i / 2) * (gh + 30);
    rounded(ctx, x, top, gw, gh, 22);
    ctx.fillStyle = C.white;
    ctx.fill();
    ctx.font = '800 110px "Barlow Condensed"';
    ctx.fillStyle = C.purple;
    ctx.fillText(String(n), x + 34, top + 108);
    ctx.font = '700 26px "Courier Prime"';
    ctx.fillStyle = C.muted;
    ctx.fillText(label.toUpperCase(), x + 36, top + 146);
  });
  y += 2 * gh + 30 + 54;

  // What I did: top kinds as bars.
  ctx.font = '700 26px "Courier Prime"';
  ctx.fillStyle = C.lilac;
  ctx.fillText(tx.kinds.toUpperCase(), 70, y);
  y += 26;
  const kinds = r.kinds.slice(0, 4);
  const max = Math.max(1, ...kinds.map((k) => k.picks));
  for (const k of kinds) {
    const bw = Math.max(60, ((W - 140 - 260) * k.picks) / max);
    rounded(ctx, 70, y, bw, 40, 10);
    ctx.fillStyle = KIND[k.category] ?? C.purple;
    ctx.fill();
    ctx.font = '700 28px "Barlow Condensed"';
    ctx.fillStyle = C.white;
    ctx.fillText(t(k.label).toUpperCase(), 86, y + 29);
    ctx.font = '700 28px "Courier Prime"';
    ctx.fillStyle = C.cream;
    ctx.fillText(`×${k.picks}`, 70 + bw + 16, y + 29);
    y += 52;
  }
  y += 24;

  // Favourite idea, and the quiz.
  if (r.top) {
    ctx.font = '700 26px "Courier Prime"';
    ctx.fillStyle = C.lilac;
    ctx.fillText(tx.favourite.toUpperCase(), 70, y + 10);
    fitText(ctx, `${t(r.top.title, true)}${r.top.times > 1 ? `  ×${r.top.times}` : ''}`, 70, y + 64, W - 140, { size: 52, color: C.white, lines: 1 });
    y += 100;
  }
  if (r.quizzes && y + 20 < H - 160) {
    ctx.font = '500 30px "Barlow"';
    ctx.fillStyle = C.cream;
    ctx.fillText(tx.quiz(r.quiz_right, r.quizzes), 70, y + 16);
  }

  // Foot: perforation and the site.
  perforation(ctx, 70, W - 70, H - 140, 'rgba(255,255,255,0.35)');
  ctx.font = '800 44px "Barlow Condensed"';
  ctx.fillStyle = C.red;
  ctx.fillText(tx.yourTurn.toUpperCase(), 70, H - 70);
  const yt = ctx.measureText(tx.yourTurn.toUpperCase()).width;
  ctx.font = '700 32px "Courier Prime"';
  ctx.fillStyle = C.cream;
  ctx.fillText(SITE, 70 + yt + 20, H - 74);
  return canvas;
}

// ---------------------------------------------------------------- the ticket card

async function drawTicket(c, tag) {
  await fontsReady();
  const tx = L();
  const W = 1080;
  const H = 1080;
  const canvas = h('canvas', { width: W, height: H });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.navy;
  ctx.fillRect(0, 0, W, H);
  dots(ctx, W, H, 'rgba(255,255,255,0.06)');

  const x = 60;
  const w = W - 120;
  const top = 60;
  const photoH = 430;
  rounded(ctx, x, top, w, H - 120, 28);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = C.white;
  ctx.fillRect(x, top, w, H - 120);

  // Photo (built-in ideas only) or the category poster.
  const p = photoFor(c);
  let drawn = false;
  if (p && !p.remote) {
    try {
      cover(ctx, await loadImage(p.src), x, top, w, photoH);
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  if (!drawn) {
    ctx.fillStyle = KIND[c.category] ?? C.purple;
    ctx.fillRect(x, top, w, photoH);
    ctx.font = '800 220px "Barlow Condensed"';
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillText(t(c.category_label ?? '').toUpperCase(), x + 30, top + photoH - 40);
  }
  // Head strip.
  ctx.fillStyle = C.navy;
  ctx.fillRect(x, top + photoH, w, 66);
  ctx.font = '700 28px "Barlow Condensed"';
  ctx.fillStyle = C.cream;
  const head = `${tx.admit} · ${t(c.category_label ?? '')}`.toUpperCase();
  ctx.fillText(head, x + 36, top + photoH + 44);
  ctx.font = '700 26px "Courier Prime"';
  ctx.fillStyle = C.lilac;
  const dur = c.duration ?? '';
  ctx.fillText(dur, x + w - 36 - ctx.measureText(dur).width, top + photoH + 43);
  ctx.restore();

  // Title and details.
  let y = top + photoH + 66 + 100;
  y = fitText(ctx, t(c.title, true), x + 36, y, w - 72, { size: 92, color: C.ink, lines: 2 });
  ctx.font = '700 28px "Courier Prime"';
  ctx.fillStyle = C.purple;
  ctx.fillText([dur, tx.cost[c.cost] ?? ''].filter(Boolean).join(' · ').toUpperCase(), x + 38, y + 62);

  // Invite.
  const py = H - 60 - 170;
  perforation(ctx, x + 30, x + w - 30, py, 'rgba(13,27,61,0.35)');
  ctx.font = '800 44px "Barlow Condensed"';
  ctx.fillStyle = C.red;
  ctx.fillText(tx.withMe.toUpperCase(), x + 36, py + 66);
  ctx.font = '700 28px "Courier Prime"';
  ctx.fillStyle = C.ink;
  ctx.fillText(tag ? tx.addMe(tag) : SITE, x + 38, py + 112);
  if (tag) {
    ctx.fillStyle = C.muted;
    ctx.fillText(`${SITE}/invite.html`, x + 38, py + 148);
  }
  return canvas;
}

// ---------------------------------------------------------------- the share window

async function myTag() {
  try {
    const a = await api.account();
    return a?.signed_in ? (a.profile?.friend_tag ?? null) : null;
  } catch {
    return null;
  }
}

function toBase64Url(canvas) {
  return canvas.toDataURL('image/png').split(',')[1].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shareWindow(title, canvas, name, tag) {
  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  canvas.classList.add('share-canvas');
  const actions = [
    btn({
      label: 'Copy image',
      icon: 'copy',
      kind: 'primary',
      small: true,
      onclick: () =>
        canvas.toBlob(async (blob) => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toast('Image copied: paste it in Discord, WhatsApp…', 'ok');
          } catch {
            toast('Couldn’t copy the image here: save it instead', 'error');
          }
        }, 'image/png'),
    }),
    btn({
      label: 'Save image',
      icon: 'download',
      small: true,
      onclick: async () => {
        try {
          await api.saveCard(name, toBase64Url(canvas));
          toast('Saved in your Downloads folder', 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      },
    }),
    tag
      ? btn({
          label: 'Copy invite link',
          icon: 'user-plus',
          small: true,
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(INVITE(tag));
              toast('Invite link copied', 'ok');
            } catch (e) {
              toast(errText(e), 'error');
            }
          },
        })
      : null,
  ];
  const card = h(
    'section',
    { class: 'quiz share-window', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'coupon-head' }, h('span', {}, title), h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'quiz-body' }, canvas, h('div', { class: 'quiz-end-actions share-actions' }, actions), h('p', { class: 'hint' }, 'Made on your PC: nothing is uploaded.')),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('.btn').focus();
}

/** "Share as an image" on a ticket. */
export async function shareTicket(c) {
  try {
    const tag = await myTag();
    const canvas = await drawTicket(c, tag);
    shareWindow('Share this idea', canvas, `ticket-${(c.id ?? 'idea').split(':').pop()}`, tag);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

/** "Share my month" / "Share my year". */
export async function shareRecap(year = false) {
  try {
    const r = await api.periodRecap(year);
    if (!r.picks) {
      toast(year ? 'Nothing done this year yet: start with a pick!' : 'Nothing done this month yet: start with a pick!');
      return;
    }
    const [canvas, tag] = await Promise.all([drawRecap(r, year), myTag()]);
    shareWindow(year ? 'My year on freetime' : 'My month on freetime', canvas, year ? `year-${r.from.slice(0, 4)}` : `month-${r.from.slice(0, 7)}`, tag);
  } catch (e) {
    toast(errText(e), 'error');
  }
}
