// "Signaler un problème" / "Report a problem": anyone sends a problem report from the app.
//
//   POST /functions/v1/support
//   { "category": "bug|account|idea|other", "message": "…", "contact"?, "appVersion"?,
//     "platform"?: "desktop|web", "lang"?, "screen"? }
//   → { "id": 42 }
//
// Public on purpose (deployed with verify_jwt = false): people who can't sign in must be able to
// say so. With "Authorization: Bearer <session>", the ticket is linked to that account.
// Rate limits live in the database (public.support_submit): 10 an hour per network address,
// 5 an hour per account, 300 a day in all. The address is stored only as a keyed hash, with a
// secret of its own (SUPPORT_IP_HASH_KEY); without it, or without an address the platform vouches
// for (see address.js), only the account and daily limits apply.
// Only the admins listed in private.admins can read the tickets (see the migration).

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { clientAddress, keyedHash } from './address.js';

const CATEGORIES = new Set(['bug', 'account', 'idea', 'other']);
const PLATFORMS = new Set(['desktop', 'web']);
const IP_HASH_KEY = Deno.env.get('SUPPORT_IP_HASH_KEY') ?? '';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

type Ticket = {
  category: string;
  message: string;
  contact: string | null;
  appVersion: string | null;
  platform: string | null;
  lang: string | null;
  screen: string | null;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method', message: 'POST only' });
  const ticket = clean(await req.json().catch(() => null));
  if (!ticket) {
    return reply(400, { error: 'invalid', message: 'Describe the problem in 10 to 4000 characters and pick a category.' });
  }

  try {
    // A session links the ticket to the account; a bad or expired one just sends it unlinked.
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const ip = clientAddress(req.headers);

    const { data: id, error } = await db.rpc('support_submit', {
      p_user: auth?.user?.id ?? null,
      p_ip_hash: ip ? await keyedHash(ip, IP_HASH_KEY) : null,
      p_category: ticket.category,
      p_message: ticket.message,
      p_contact: ticket.contact,
      p_app_version: ticket.appVersion,
      p_platform: ticket.platform,
      p_lang: ticket.lang,
      p_screen: ticket.screen,
    });
    if (error) {
      if (error.code === '54000') return reply(429, { error: 'too_many', message: error.message });
      // Only the code is logged: the message could quote what the person wrote.
      console.error('support_submit failed', error.code);
      return reply(502, { error: 'unavailable', message: 'The report could not be saved. Try again in a moment.' });
    }
    return reply(200, { id });
  } catch (e) {
    console.error('support failed', e instanceof Error ? e.name : 'unknown');
    return reply(502, { error: 'unavailable', message: 'The report could not be saved. Try again in a moment.' });
  }
});

/** The report to store, trimmed and checked, or null when it isn't valid. */
function clean(body: unknown): Ticket | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '';
  const category = text(b.category, 20);
  const message = typeof b.message === 'string' ? b.message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
  if (!CATEGORIES.has(category) || message.length < 10 || message.length > 4000) return null;
  const contact = text(b.contact, 200);
  const platform = text(b.platform, 10);
  const lang = text(b.lang, 10);
  const screen = text(b.screen, 40);
  return {
    category,
    message,
    contact: contact.length >= 3 ? contact : null,
    appVersion: text(b.appVersion, 40) || null,
    platform: PLATFORMS.has(platform) ? platform : null,
    lang: /^[a-zA-Z-]{2,10}$/.test(lang) ? lang : null,
    screen: /^[a-z0-9_-]{1,40}$/.test(screen) ? screen : null,
  };
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
