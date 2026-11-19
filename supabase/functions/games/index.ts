// Turn-based games with friends: starts games and checks every move with the rules the app ships
// (rules.js, a copy of desktop/ui/js/play/rules.js), then saves them. The work is in handler.js;
// this file only checks the session and speaks HTTP.
//
//   POST /functions/v1/games { "action": "start" | "move", ... }   (Authorization: Bearer <token>)

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { GameError, MAX_BODY, handle } from './handler.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method', message: 'POST only' });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const user = auth?.user;
  if (!user) return reply(401, { error: 'sign_in', message: 'Sign in to play with friends.' });

  const text = await req.text();
  if (text.length > MAX_BODY) return reply(413, { error: 'too_big', message: 'That move is too big.' });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: 'bad_request', message: 'Send a JSON body.' });
  }

  try {
    return reply(200, await handle(db, user.id, body));
  } catch (e) {
    if (e instanceof GameError) return reply(e.status, { error: e.code, message: e.message });
    console.error('games failed', e instanceof Error ? e.message : e);
    return reply(502, { error: 'server', message: 'The game server is having trouble.' });
  }
});

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
