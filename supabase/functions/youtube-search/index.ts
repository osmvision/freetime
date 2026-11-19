// YouTube search for the app, without a key on the user's side.
//
//   GET /functions/v1/youtube-search?q=origami
//   → { "items": [{ "id", "title", "channel", "seconds", "views", "likes" }], "cached": bool }
//
// One topic per call, so each topic is cached on its own and shared by everyone who likes it.
// The YouTube Data API key is the function secret YOUTUBE_API_KEY: it never reaches the app.
// A search costs 101 quota units (search + video details); YOUTUBE_DAILY_SEARCHES caps them.
//
// Public on purpose (deployed with verify_jwt = false): the app also searches when signed out.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

/**
 * Results stay fresh this long: one real search per topic a day at most. Results are ranked by
 * relevance over the past year, so they hardly change within a day; the quota is what is scarce.
 */
const FRESH_SECS = 24 * 3600;
/** 90 × 101 = 9,090 of the 10,000 free daily units. */
const DEFAULT_DAILY_SEARCHES = 90;
const MAX_QUERY = 60;
const PER_TOPIC = 6;

type Video = { id: string; title: string; channel: string; seconds: number; views: number; likes: number };

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== 'GET') return reply(405, { error: 'GET only' });
  const query = normalize(new URL(req.url).searchParams.get('q') ?? '');
  if (!query) return reply(400, { error: `q must be 1 to ${MAX_QUERY} characters` });

  try {
    const { data: rows, error } = await db.rpc('youtube_cache_get', { q: query });
    if (error) throw error;
    const cached = rows?.[0] as { items: Video[]; fetched_at: string } | undefined;
    const age = cached ? (Date.now() - Date.parse(cached.fetched_at)) / 1000 : Infinity;
    if (cached && age < FRESH_SECS) return reply(200, { items: cached.items, cached: true }, FRESH_SECS - age);

    const key = Deno.env.get('YOUTUBE_API_KEY');
    const cap = Number(Deno.env.get('YOUTUBE_DAILY_SEARCHES')) || DEFAULT_DAILY_SEARCHES;
    const { data: allowed, error: quotaError } = key
      ? await db.rpc('youtube_take_search', { daily_cap: cap })
      : { data: false, error: null };
    if (quotaError) throw quotaError;
    if (!allowed) {
      // Out of searches for today: an older copy is still better than nothing.
      if (cached) return reply(200, { items: cached.items, cached: true }, 3600);
      return reply(429, { error: 'daily search limit reached' });
    }

    const items = await search(key!, query);
    const { error: putError } = await db.rpc('youtube_cache_put', { q: query, found: items });
    if (putError) console.error('cache write failed', putError.message);
    return reply(200, { items, cached: false }, FRESH_SECS);
  } catch (e) {
    console.error('youtube-search failed', e instanceof Error ? e.message : e);
    return reply(502, { error: 'YouTube search unavailable' });
  }
});

/** Same topic, same cache entry: trimmed, single spaces, lowercase. */
function normalize(q: string): string {
  const clean = q.trim().replace(/\s+/g, ' ').toLowerCase();
  return clean.length <= MAX_QUERY ? clean : '';
}

/** Videos from the last year that match `query`, with their length and stats. */
async function search(key: string, query: string): Promise<Video[]> {
  const after = new Date(Date.now() - 365 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const found = await youtube('search', {
    part: 'snippet',
    type: 'video',
    maxResults: String(PER_TOPIC),
    order: 'relevance',
    q: query,
    publishedAfter: after,
    key,
  });
  const hits = (found.items ?? [])
    .filter((it: any) => it?.id?.videoId)
    .map((it: any) => ({
      id: it.id.videoId as string,
      title: unescape(it.snippet?.title ?? ''),
      channel: unescape(it.snippet?.channelTitle ?? ''),
    }));
  if (!hits.length) return [];

  const details = await youtube('videos', { part: 'contentDetails,statistics', id: hits.map((h) => h.id).join(','), key });
  const stats = new Map<string, any>((details.items ?? []).map((it: any) => [it.id, it]));
  return hits.flatMap((h) => {
    const it = stats.get(h.id);
    if (!it) return [];
    return [{
      ...h,
      seconds: isoSeconds(it.contentDetails?.duration ?? ''),
      views: Number(it.statistics?.viewCount ?? 0),
      likes: Number(it.statistics?.likeCount ?? 0),
    }];
  });
}

async function youtube(endpoint: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(8000),
  });
  // The body would echo the request; only the status is logged, so the key never shows up.
  if (!res.ok) throw new Error(`YouTube ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

/** `PT1H2M3S` → 3723. */
function isoSeconds(d: string): number {
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, days, h, min, s] = m.map((x) => Number(x ?? 0));
  return days * 86_400 + h * 3600 + min * 60 + s;
}

function unescape(s: string): string {
  return s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function reply(status: number, body: unknown, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge > 0 ? `public, max-age=${Math.floor(maxAge)}` : 'no-store',
    },
  });
}
