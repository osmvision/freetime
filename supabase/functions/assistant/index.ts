// The free assistant: signed-in users chat with Mistral on freetime's key.
//
//   GET  /functions/v1/assistant                 → { "model", "limit", "used" } for today
//   POST /functions/v1/assistant { "messages" }  → Mistral's answer, streamed (server-sent events)
//
// Both need the user's session (Authorization: Bearer <access token>), checked here.
// The Mistral key is the function secret MISTRAL_API_KEY: it never reaches the app.
// ASSISTANT_DAILY_MESSAGES caps messages per account and UTC day (50 by default);
// ASSISTANT_MODEL picks the model (mistral-small-latest by default). The model, the answer length
// and the size of the conversation are set here, whatever the app asks for, so the cost stays known.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const MISTRAL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-small-latest';
const DEFAULT_DAILY_MESSAGES = 50;
/** The app sends a system message and the last 20 turns at most. */
const MAX_MESSAGES = 44;
/** The system message (with today's ideas) plus the conversation, in characters. */
const MAX_CHARS = 60_000;
const MAX_TOKENS = 900;
const ROLES = new Set(['system', 'user', 'assistant']);

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(405, { error: 'method', message: 'GET or POST only' });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const user = auth?.user;
  if (!user) return reply(401, { error: 'sign_in', message: 'Sign in to use the free assistant.' });

  const model = Deno.env.get('ASSISTANT_MODEL')?.trim() || DEFAULT_MODEL;
  const limit = Number(Deno.env.get('ASSISTANT_DAILY_MESSAGES')) || DEFAULT_DAILY_MESSAGES;
  const key = Deno.env.get('MISTRAL_API_KEY')?.trim();

  try {
    if (req.method === 'GET') {
      const { data: used, error } = await db.rpc('assistant_used', { who: user.id });
      if (error) throw error;
      return reply(200, { model, limit, used: Number(used) || 0, available: Boolean(key) });
    }

    if (!key) return reply(503, { error: 'unavailable', message: 'The free assistant is not set up.' });
    const messages = checkMessages(await req.json().catch(() => null));
    if (!messages) return reply(400, { error: 'too_long', message: 'The conversation is too long or malformed.' });

    const { data: left, error } = await db.rpc('assistant_take', { who: user.id, daily_cap: limit });
    if (error) throw error;
    if (left < 0) return reply(429, { error: 'daily_limit', limit, message: `All ${limit} free messages of today are used.` });

    const res = await fetch(MISTRAL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.6, max_tokens: MAX_TOKENS }),
    });
    if (!res.ok || !res.body) {
      // Not the user's fault: the message is given back. Only the status is logged.
      await db.rpc('assistant_refund', { who: user.id });
      console.error('mistral failed', res.status);
      await res.body?.cancel();
      const busy = res.status === 429;
      return reply(busy ? 503 : 502, { error: busy ? 'busy' : 'upstream', message: 'Mistral is not answering right now.' });
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-assistant-left': String(left),
      },
    });
  } catch (e) {
    console.error('assistant failed', e instanceof Error ? e.message : e);
    return reply(502, { error: 'upstream', message: 'The free assistant is having trouble.' });
  }
});

/** The messages to forward, or null when they're malformed or too big. */
function checkMessages(body: unknown): { role: string; content: string }[] | null {
  const list = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null;
  let chars = 0;
  const out = [];
  for (const m of list) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (typeof role !== 'string' || !ROLES.has(role) || typeof content !== 'string') return null;
    chars += content.length;
    out.push({ role, content });
  }
  // Only the first message may give instructions; the last one is the user's.
  if (out.slice(1).some((m) => m.role === 'system') || out[out.length - 1].role !== 'user') return null;
  return chars <= MAX_CHARS ? out : null;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
