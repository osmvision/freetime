// Proves the permission rules of the migrations: each test signs in as someone and checks what
// they can and cannot see or change. Run: cd supabase/tests && npm install && npm test
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';

const here = import.meta.dirname;
const migrations = join(here, '..', 'migrations');

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const CAROL = '00000000-0000-4000-8000-00000000000c';

let db;

before(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrations, file), 'utf8'));
  }
});

/**
 * Creates three test accounts (each gets a profile from the trigger) in a transaction that is
 * rolled back at the end. `step(user, fn)` runs `fn` signed in as `user` (null = signed out,
 * the "anon" role) inside a savepoint.
 */
async function withPeople(fn) {
  await db.exec('begin');
  try {
    await db.query('insert into auth.users (id, email) values ($1, $4), ($2, $5), ($3, $6)', [ALICE, BOB, CAROL, 'a@test', 'b@test', 'c@test']);
    const tags = Object.fromEntries((await db.query('select id, friend_tag from public.profiles')).rows.map((r) => [r.id, r.friend_tag]));
    const step = async (user, fn2) => {
      await db.exec('savepoint s');
      await db.exec(user ? 'set local role authenticated' : 'set local role anon');
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user ? { sub: user } : {})]);
      try {
        return await fn2({
          rows: async (sql, params) => (await db.query(sql, params)).rows,
          one: async (sql, params) => (await db.query(sql, params)).rows[0],
        });
      } finally {
        await db.exec('reset role');
        await db.exec('release savepoint s');
      }
    };
    return await fn({ tags, step });
  } finally {
    await db.exec('rollback');
  }
}

const fails = async (promise, pattern) => {
  await assert.rejects(promise, pattern);
  await db.exec('rollback to savepoint s');
};

test('a new account gets a neutral profile with a friend tag', async () => {
  await withPeople(async ({ tags, step }) => {
    const me = await step(ALICE, (q) => q.one('select display_name, avatar_icon, friend_tag from public.profiles where id = $1', [ALICE]));
    assert.equal(me.display_name, 'Friend');
    assert.equal(me.avatar_icon, 0);
    assert.match(me.friend_tag, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
    assert.equal(new Set(Object.values(tags)).size, 3, 'tags are unique');
  });
});

test('strangers and signed-out visitors see nothing', async () => {
  await withPeople(async ({ step }) => {
    assert.deepEqual(await step(ALICE, (q) => q.rows('select id from public.profiles')), [{ id: ALICE }], 'only herself');
    await step(null, async (q) => {
      await fails(q.rows('select * from public.profiles'), /permission denied/);
    });
    await step(null, async (q) => {
      await fails(q.rows('select * from public.friendships'), /permission denied/);
    });
  });
});

test('you can edit your own profile, within limits, and nobody else’s', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, (q) => q.rows("update public.profiles set display_name = 'Alice', avatar_icon = 4, bio = 'hi' where id = $1", [ALICE]));
    const changed = await step(BOB, (q) => q.rows("update public.profiles set display_name = 'Hacked' where id = $1 returning id", [ALICE]));
    assert.equal(changed.length, 0, "Bob can't edit Alice");
    await step(ALICE, async (q) => {
      await fails(q.rows('update public.profiles set avatar_icon = 99 where id = $1', [ALICE]), /check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("update public.profiles set friend_tag = 'AAAAA-AAAAA' where id = $1", [ALICE]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("update public.profiles set display_name = 'a' || chr(10) || 'b' where id = $1", [ALICE]), /check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows('insert into public.profiles (id) values ($1)', [CAROL]), /permission denied/);
    });
  });
});

test('friend requests: by tag, accepted by the other person, then profiles are visible', async () => {
  await withPeople(async ({ tags, step }) => {
    assert.equal(await step(ALICE, (q) => q.one('select public.send_friend_request($1) as s', [tags[BOB].toLowerCase()])).then((r) => r.s), 'pending');
    // Carol sees neither the request nor their profiles.
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.friendships'))).length, 0);
    assert.equal((await step(CAROL, (q) => q.rows('select id from public.profiles where id in ($1, $2)', [ALICE, BOB]))).length, 0);
    // Alice can't accept her own request.
    const self = await step(ALICE, (q) => q.rows("update public.friendships set status = 'accepted' where requester = $1 returning *", [ALICE]));
    assert.equal(self.length, 0);
    // Bob accepts.
    const ok = await step(BOB, (q) => q.rows("update public.friendships set status = 'accepted' where requester = $1 returning accepted_at", [ALICE]));
    assert.equal(ok.length, 1);
    assert.ok(ok[0].accepted_at);
    const seen = await step(ALICE, (q) => q.rows('select id from public.profiles order by id'));
    assert.deepEqual(seen.map((r) => r.id), [ALICE, BOB]);
  });
});

test('nobody can write friendships directly or fake who asked', async () => {
  await withPeople(async ({ step }) => {
    await step(CAROL, async (q) => {
      await fails(q.rows("insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')", [ALICE, BOB]), /permission denied/);
    });
    await step(CAROL, async (q) => {
      await fails(q.rows("insert into public.friendships (requester, addressee) values ($1, $2)", [CAROL, ALICE]), /permission denied/);
    });
  });
});

test('asking back accepts; your own or unknown tags get the same answer', async () => {
  await withPeople(async ({ tags, step }) => {
    await step(ALICE, (q) => q.one('select public.send_friend_request($1)', [tags[BOB]]));
    assert.equal((await step(BOB, (q) => q.one('select public.send_friend_request($1) as s', [tags[ALICE]]))).s, 'accepted');
    await step(ALICE, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', [tags[ALICE]]), /no one has that friend tag/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', ['00000-00000']), /no one has that friend tag/);
    });
    await step(null, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', [tags[BOB]]), /permission denied/);
    });
  });
});

test('blocking ends the friendship, hides profiles and stops new requests', async () => {
  await withPeople(async ({ tags, step }) => {
    await step(ALICE, (q) => q.one('select public.send_friend_request($1)', [tags[BOB]]));
    await step(BOB, (q) => q.rows("update public.friendships set status = 'accepted' where requester = $1", [ALICE]));
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.friendships'))).length, 0);
    assert.equal((await step(ALICE, (q) => q.rows('select id from public.profiles where id = $1', [BOB]))).length, 0);
    await step(ALICE, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', [tags[BOB]]), /no one has that friend tag/);
    });
    // Alice can't see Bob's block list, nor block on Bob's behalf.
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.blocks'))).length, 0);
    await step(ALICE, async (q) => {
      await fails(q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [CAROL, ALICE]), /row-level security/);
    });
  });
});

test('internal helpers are not callable through the API', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(q.one('select public.is_blocked($1, $2)', [BOB, CAROL]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.new_friend_tag()'), /permission denied/);
    });
  });
});

test('a leaked tag can be reset and the old one stops working', async () => {
  await withPeople(async ({ tags, step }) => {
    const fresh = (await step(BOB, (q) => q.one('select public.reset_friend_tag() as t'))).t;
    assert.notEqual(fresh, tags[BOB]);
    await step(ALICE, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', [tags[BOB]]), /no one has that friend tag/);
    });
    assert.equal((await step(ALICE, (q) => q.one('select public.send_friend_request($1) as s', [fresh]))).s, 'pending');
  });
});

test('too many unanswered requests are refused', async () => {
  await withPeople(async ({ step }) => {
    // 21 extra accounts for Alice to send requests to (created as the database owner).
    const ids = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`);
    for (const id of ids) await db.query('insert into auth.users (id) values ($1)', [id]);
    const extra = (await db.query('select friend_tag from public.profiles where id = any($1)', [ids])).rows.map((r) => r.friend_tag);
    for (const tag of extra.slice(0, 20)) await step(ALICE, (q) => q.one('select public.send_friend_request($1)', [tag]));
    await step(ALICE, async (q) => {
      await fails(q.one('select public.send_friend_request($1)', [extra[20]]), /too many friend requests/);
    });
  });
});

// ---------------------------------------------------------------- direct messages

/** Makes two people friends directly (as the database owner, outside the API). */
async function befriend(a, b) {
  await db.query("insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')", [a, b]);
}

test('only friends can open a direct chat, and a pair has exactly one', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(q.one('select public.open_direct($1)', [BOB]), /only message your friends/);
    });
    await befriend(ALICE, BOB);
    const a = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    const again = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    const fromBob = (await step(BOB, (q) => q.one('select public.open_direct($1) as id', [ALICE]))).id;
    assert.equal(a, again);
    assert.equal(a, fromBob);
    await step(ALICE, async (q) => {
      await fails(q.one('select public.open_direct($1)', [ALICE]), /only message your friends/);
    });
    await step(null, async (q) => {
      await fails(q.one('select public.open_direct($1)', [BOB]), /permission denied/);
    });
  });
});

test('members read and post; nobody else can read, post or pose as someone', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    const sent = await step(ALICE, (q) => q.one('insert into public.messages (conversation_id, body) values ($1, $2) returning sender', [conv, 'hi Bob']));
    assert.equal(sent.sender, ALICE, 'the database sets the sender');
    assert.deepEqual((await step(BOB, (q) => q.rows('select body from public.messages'))).map((r) => r.body), ['hi Bob']);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.messages'))).length, 0);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.conversations'))).length, 0);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.conversation_members'))).length, 0);
    await step(CAROL, async (q) => {
      await fails(q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'let me in']), /row-level security/);
    });
    await step(BOB, async (q) => {
      await fails(q.rows('insert into public.messages (conversation_id, sender, body) values ($1, $2, $3)', [conv, ALICE, 'fake']), /permission denied/);
    });
    // Bob can't delete Alice's message.
    assert.equal((await step(BOB, (q) => q.rows('delete from public.messages returning id'))).length, 0);
    assert.equal((await step(ALICE, (q) => q.rows('delete from public.messages returning id'))).length, 1);
    await step(null, async (q) => {
      await fails(q.rows('select * from public.messages'), /permission denied/);
    });
  });
});

test('unfriending or blocking stops new messages; the history stays readable', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'before']));
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    for (const who of [ALICE, BOB]) {
      await step(who, async (q) => {
        await fails(q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'after']), /row-level security/);
      });
    }
    assert.equal((await step(BOB, (q) => q.rows('select body from public.messages'))).length, 1);
  });
});

test('messages are text within limits', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    for (const bad of ['', '   \n ', 'x'.repeat(2001), 'bell\u0007']) {
      await step(ALICE, async (q) => {
        await fails(q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, bad]), /check constraint/);
      });
    }
    await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'two\nlines\tok']));
  });
});

test('at most 30 messages a minute', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    for (let i = 0; i < 30; i++) {
      await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, `m${i}`]));
    }
    await step(ALICE, async (q) => {
      await fails(q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'one more']), /too many messages/);
    });
  });
});

test('your lists show only your own friends, requests and chats', async () => {
  await withPeople(async ({ tags, step }) => {
    await befriend(ALICE, BOB);
    await step(CAROL, (q) => q.one('select public.send_friend_request($1)', [tags[ALICE]]));
    const alice = await step(ALICE, (q) => q.rows('select user_id, state from public.my_friends() order by state'));
    assert.deepEqual(alice, [{ user_id: BOB, state: 'friend' }, { user_id: CAROL, state: 'incoming' }]);
    assert.deepEqual(await step(CAROL, (q) => q.rows('select user_id, state from public.my_friends()')), [{ user_id: ALICE, state: 'outgoing' }]);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.my_conversations()'))).length, 0);

    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    for (const body of ['one', 'two']) await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, body]));
    const bobView = await step(BOB, (q) => q.one('select friend, last_body, unread from public.my_conversations()'));
    assert.deepEqual(bobView, { friend: ALICE, last_body: 'two', unread: 2 });
    assert.equal((await step(ALICE, (q) => q.one('select unread from public.my_conversations()'))).unread, 0, 'your own messages are read');

    const lastId = (await step(BOB, (q) => q.one('select max(id) as id from public.messages'))).id;
    await step(BOB, (q) => q.rows('update public.conversation_members set last_read_id = $1 where conversation_id = $2 and user_id = $3', [lastId, conv, BOB]));
    assert.equal((await step(BOB, (q) => q.one('select unread from public.my_conversations()'))).unread, 0);
    const meddled = await step(BOB, (q) => q.rows('update public.conversation_members set last_read_id = 0 where user_id = $1 returning *', [ALICE]));
    assert.equal(meddled.length, 0, "Bob can't change Alice's read marker");
    await step(null, async (q) => {
      await fails(q.rows('select * from public.my_friends()'), /permission denied/);
    });
  });
});

// ---------------------------------------------------------------- your data, and reports

test('export contains your data and nobody else’s', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'from alice']));
    await step(BOB, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'from bob']));
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.account.id, ALICE);
    assert.equal(data.account.email, 'a@test');
    assert.equal(data.profile.id, ALICE);
    assert.deepEqual(data.messages_you_sent.map((m) => m.body), ['from alice']);
    assert.equal(data.friendships.length, 1);
    await step(null, async (q) => {
      await fails(q.one('select public.export_my_data()'), /permission denied/);
    });
  });
});

test('deleting your account removes your login and everything linked to it', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const conv = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    await step(ALICE, (q) => q.rows('insert into public.messages (conversation_id, body) values ($1, $2)', [conv, 'bye']));
    await step(ALICE, (q) => q.one('select public.delete_my_account()'));
    const left = (await db.query('select (select count(*) from auth.users where id = $1)::int as users, (select count(*) from public.profiles where id = $1)::int as profiles, (select count(*) from public.friendships)::int as friendships, (select count(*) from public.messages where sender = $1)::int as messages', [ALICE])).rows[0];
    assert.deepEqual(left, { users: 0, profiles: 0, friendships: 0, messages: 0 });
    assert.equal((await db.query('select count(*)::int as n from public.profiles where id = $1', [BOB])).rows[0].n, 1, 'Bob is untouched');
    await step(null, async (q) => {
      await fails(q.one('select public.delete_my_account()'), /permission denied/);
    });
  });
});

test('reports: only about people you know, with their messages from your chats', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason) values ($1, 'spam')", [CAROL]), /only report people you are connected with/);
    });
    await befriend(ALICE, BOB);
    await befriend(BOB, CAROL);
    const ab = (await step(ALICE, (q) => q.one('select public.open_direct($1) as id', [BOB]))).id;
    const bc = (await step(BOB, (q) => q.one('select public.open_direct($1) as id', [CAROL]))).id;
    const bobToAlice = (await step(BOB, (q) => q.one('insert into public.messages (conversation_id, body) values ($1, $2) returning id', [ab, 'rude']))).id;
    const bobToCarol = (await step(BOB, (q) => q.one('insert into public.messages (conversation_id, body) values ($1, $2) returning id', [bc, 'private']))).id;
    const aliceOwn = (await step(ALICE, (q) => q.one('insert into public.messages (conversation_id, body) values ($1, $2) returning id', [ab, 'mine']))).id;

    const filed = await step(ALICE, (q) => q.one("insert into public.reports (target, reason, details, message_ids) values ($1, 'harassment', 'see message', $2) returning reporter, status", [BOB, [bobToAlice]]));
    assert.deepEqual(filed, { reporter: ALICE, status: 'open' });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason, message_ids) values ($1, 'spam', $2)", [BOB, [bobToCarol]]), /can't be attached/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason, message_ids) values ($1, 'spam', $2)", [BOB, [aliceOwn]]), /can't be attached/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason, reporter) values ($1, 'spam', $2)", [BOB, CAROL]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason, status) values ($1, 'spam', 'dismissed')", [BOB]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason) values ($1, 'because')", [BOB]), /check constraint/);
    });
    assert.equal((await step(BOB, (q) => q.rows('select * from public.reports'))).length, 0, 'the reported person never sees it');
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.reports'))).length, 1);
    await step(ALICE, async (q) => {
      await fails(q.rows("update public.reports set status = 'dismissed'"), /permission denied/);
    });
  });
});

test('at most 10 reports an hour', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    for (let i = 0; i < 10; i++) await step(ALICE, (q) => q.rows("insert into public.reports (target, reason) values ($1, 'spam')", [BOB]));
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.reports (target, reason) values ($1, 'spam')", [BOB]), /too many reports/);
    });
  });
});
// ---------------------------------------------------------------- free now and invites

const invite = (q, to, extra = {}) =>
  q.one(
    'insert into public.invites (to_user, idea_id, title, category, starts_at, note) values ($1, $2, $3, $4, $5, $6) returning id, from_user, status',
    [to, extra.idea ?? 'steam:570', extra.title ?? 'Dota 2', extra.category ?? 'game', extra.at ?? new Date(Date.now() + 3600e3).toISOString(), extra.note ?? ''],
  );

test('free now: friends see it, others do not, and it can be cleared', async () => {
  await withPeople(async ({ tags, step }) => {
    await befriend(ALICE, BOB);
    await step(CAROL, (q) => q.one('select public.send_friend_request($1)', [tags[ALICE]]));
    const until = (await step(ALICE, (q) => q.one('select public.set_free(90) as u'))).u;
    assert.ok(until);
    const seenByBob = await step(BOB, (q) => q.one('select free_until from public.my_friends() where user_id = $1', [ALICE]));
    assert.ok(seenByBob.free_until, 'a friend sees it');
    const seenByCarol = await step(CAROL, (q) => q.one('select free_until from public.my_friends() where user_id = $1', [ALICE]));
    assert.equal(seenByCarol.free_until, null, 'a pending request does not');
    await step(ALICE, (q) => q.one('select public.set_free(0)'));
    assert.equal((await step(BOB, (q) => q.one('select free_until from public.my_friends() where user_id = $1', [ALICE]))).free_until, null);
    await step(null, async (q) => {
      await fails(q.one('select public.set_free(30)'), /permission denied/);
    });
  });
});

test('invites: only to friends, sent as yourself, seen by the two people only', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB), /row-level security/);
    });
    await befriend(ALICE, BOB);
    const sent = await step(ALICE, (q) => invite(q, BOB));
    assert.deepEqual({ from: sent.from_user, status: sent.status }, { from: ALICE, status: 'pending' });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.invites (from_user, to_user, idea_id, title, category, starts_at) values ($1, $2, 'steam:1', 'x', 'game', now())", [BOB, ALICE]), /permission denied/);
    });
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.invites'))).length, 0);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.my_invites()'))).length, 0);
    const bobView = await step(BOB, (q) => q.one('select direction, other, other_name, title from public.my_invites()'));
    assert.deepEqual(bobView, { direction: 'incoming', other: ALICE, other_name: 'Friend', title: 'Dota 2' });
  });
});

test('invites: the invited person answers, the sender can only cancel', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const { id } = await step(ALICE, (q) => invite(q, BOB));
    await step(ALICE, async (q) => {
      // The sender can't accept for them: the row is theirs to cancel, so this is refused outright.
      await fails(q.rows("update public.invites set status = 'accepted' where id = $1 returning id", [id]), /row-level security/);
    });
    assert.equal((await step(CAROL, (q) => q.rows("update public.invites set status = 'declined' where id = $1 returning id", [id]))).length, 0);
    const answered = await step(BOB, (q) => q.one("update public.invites set status = 'accepted' where id = $1 returning status, answered_at", [id]));
    assert.equal(answered.status, 'accepted');
    assert.ok(answered.answered_at);
    assert.equal((await step(BOB, (q) => q.rows("update public.invites set status = 'declined' where id = $1 returning id", [id]))).length, 0, 'answered once');
    assert.equal((await step(ALICE, (q) => q.rows("update public.invites set status = 'cancelled' where id = $1 returning id", [id]))).length, 1);
    await step(BOB, async (q) => {
      await fails(q.rows("update public.invites set title = 'changed' where id = $1", [id]), /permission denied/);
    });
  });
});

test('invites: blocked people, bad times and text are refused; 30 an hour at most', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB, { at: new Date(Date.now() + 30 * 86400e3).toISOString() }), /between now and next week/);
    });
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB, { title: 'bad\u0007title' }), /check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB, { idea: 'javascript:alert(1)' }), /check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB, { category: 'nope' }), /check constraint/);
    });
    for (let i = 0; i < 30; i++) await step(ALICE, (q) => invite(q, BOB));
    await step(ALICE, async (q) => {
      await fails(invite(q, BOB), /too many invites/);
    });
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    assert.equal((await step(BOB, (q) => q.rows('select * from public.my_invites()'))).length, 0, 'invites from blocked people disappear');
  });
});
// ---------------------------------------------------------------- shared game lists

test('game lists: shared only on request, readable by friends only, removable', async () => {
  await withPeople(async ({ tags, step }) => {
    await befriend(ALICE, BOB);
    await step(CAROL, (q) => q.one('select public.send_friend_request($1)', [tags[ALICE]]));
    assert.equal((await step(BOB, (q) => q.rows('select * from public.game_libraries'))).length, 0, 'nothing until shared');
    await step(ALICE, (q) => q.one('select public.share_library($1::int[], $2::smallint[])', [[570, 730], [50, 0, 0, 0, 0, 0, 0, 0]]));
    assert.deepEqual((await step(BOB, (q) => q.one('select app_ids from public.game_libraries where user_id = $1', [ALICE]))).app_ids, [570, 730]);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.game_libraries'))).length, 0, 'a pending request is not enough');
    // Sharing again replaces the list.
    await step(ALICE, (q) => q.one('select public.share_library($1::int[], $2::smallint[])', [[440], [0, 0, 0, 0, 0, 0, 0, 0]]));
    assert.deepEqual((await step(ALICE, (q) => q.one('select app_ids from public.game_libraries where user_id = $1', [ALICE]))).app_ids, [440]);
    await step(ALICE, (q) => q.one('select public.stop_sharing_library()'));
    assert.equal((await step(BOB, (q) => q.rows('select * from public.game_libraries'))).length, 0, 'stopping deletes it');
  });
});

test('game lists: nobody writes directly or for someone else; values are checked; blocks hide them', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await step(BOB, async (q) => {
      await fails(q.rows("insert into public.game_libraries (user_id, app_ids) values ($1, '{1}')", [ALICE]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.share_library($1::int[], $2::smallint[])', [[570], [500, 0, 0, 0, 0, 0, 0, 0]]), /check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.share_library($1::int[], $2::smallint[])', [[-5], [0, 0, 0, 0, 0, 0, 0, 0]]), /check constraint/);
    });
    await step(ALICE, (q) => q.one('select public.share_library($1::int[], $2::smallint[])', [[570], [0, 0, 0, 0, 0, 0, 0, 0]]));
    await step(BOB, async (q) => {
      await fails(q.rows('delete from public.game_libraries'), /permission denied/);
    });
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    assert.equal((await step(BOB, (q) => q.rows('select * from public.game_libraries where user_id = $1', [ALICE]))).length, 0);
    await step(null, async (q) => {
      await fails(q.one('select public.share_library($1::int[], $2::smallint[])', [[1], [0, 0, 0, 0, 0, 0, 0, 0]]), /permission denied/);
    });
  });
});
/** Runs `fn` as the Edge Functions' service role, inside the current transaction. */
async function asService(fn) {
  await db.exec('savepoint s');
  await db.exec('set local role service_role');
  try {
    return await fn({ one: async (sql, params) => (await db.query(sql, params)).rows[0] });
  } finally {
    await db.exec('reset role');
    await db.exec('release savepoint s');
  }
}

test('free assistant: only the service role counts messages, up to the daily cap', async () => {
  await withPeople(async ({ step }) => {
    for (const who of [ALICE, null]) {
      await step(who, async (q) => {
        await fails(q.one('select public.assistant_take($1, 50)', [ALICE]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.one('select public.assistant_used($1)', [ALICE]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.one('select public.assistant_refund($1)', [ALICE]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.rows('select * from private.assistant_usage'), /permission denied/);
      });
    }

    const take = (who) => asService(async (q) => (await q.one('select public.assistant_take($1, 3) as left', [who])).left);
    const used = (who) => asService(async (q) => (await q.one('select public.assistant_used($1) as n', [who])).n);
    assert.equal(await used(ALICE), 0);
    assert.deepEqual([await take(ALICE), await take(ALICE), await take(ALICE), await take(ALICE)], [2, 1, 0, -1]);
    assert.equal(await used(ALICE), 3, 'a refused message is not counted');
    assert.equal(await take(BOB), 2, 'each account has its own allowance');
    await asService((q) => q.one('select public.assistant_refund($1)', [ALICE]));
    assert.equal(await take(ALICE), 0, 'a refund gives one message back');

    await db.query('delete from auth.users where id = $1', [ALICE]);
    assert.equal((await db.query('select count(*)::int as n from private.assistant_usage where user_id = $1', [ALICE])).rows[0].n, 0, 'deleting the account deletes its count');
  });
});

// ---------------------------------------------------------------- ranked (seasons and boards)

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const submit = (q, points, day = today()) => q.one('select public.submit_points($1::date, $2, 12, $3::text[], 3) as total', [day, points, ['first', 'chef']]);

test('ranked: points are capped at 20 a day, only go up, and only for today', async () => {
  await withPeople(async ({ step }) => {
    assert.equal((await step(ALICE, (q) => submit(q, 50))).total, 20, 'capped');
    assert.equal((await step(ALICE, (q) => submit(q, 5))).total, 20, 'never goes down within a day');
    assert.equal((await step(ALICE, (q) => submit(q, -9, daysAgo(1)))).total >= 20, true, 'negative becomes 0');
    await step(ALICE, async (q) => {
      await fails(submit(q, 10, daysAgo(10)), /only be sent for today/);
    });
    await step(null, async (q) => {
      await fails(submit(q, 10), /permission denied/);
    });
    // Nobody reads or writes the tables directly.
    await step(ALICE, async (q) => {
      await fails(q.rows('select * from public.daily_points'), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.daily_points (user_id, day, points) values ($1, current_date, 20)", [ALICE]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows('select * from public.player_stats'), /permission denied/);
    });
    // Junk badge ids are dropped.
    await step(ALICE, (q) => q.one("select public.submit_points(current_date, 1, 3, array['ok', 'Bad Id', '<script>'], 1)"));
    const card = await step(ALICE, (q) => q.one('select public.player_card($1) as c', [ALICE]));
    assert.deepEqual(card.c.badges, ['ok']);
  });
});

test('ranked: friends see each other; the global board is opt-in; blocks hide', async () => {
  await withPeople(async ({ tags, step }) => {
    await befriend(ALICE, BOB);
    await step(ALICE, (q) => submit(q, 12));
    await step(BOB, (q) => submit(q, 7));
    await step(CAROL, (q) => submit(q, 18));

    const friends = await step(ALICE, (q) => q.rows("select user_id, points::int, rank::int, me from public.leaderboard('friends')"));
    assert.deepEqual(friends.map((r) => [r.user_id, r.points, r.rank, r.me]), [[ALICE, 12, 1, true], [BOB, 7, 2, false]], 'Carol is not a friend');
    assert.equal((await step(ALICE, (q) => q.rows("select * from public.leaderboard('global')"))).length, 0, 'nobody opted in');

    // Carol opts in: she shows on the global board and her card is visible, without bio or status.
    await step(CAROL, (q) => q.rows('update public.profiles set show_in_global = true, bio = $2 where id = $1', [CAROL, 'secret bio']));
    const global = await step(ALICE, (q) => q.rows("select user_id, points::int from public.leaderboard('global')"));
    assert.deepEqual(global, [{ user_id: CAROL, points: 18 }]);
    const carol = (await step(ALICE, (q) => q.one('select public.player_card($1) as c', [CAROL]))).c;
    assert.equal(carol.points, 18);
    assert.equal(carol.bio, null, 'strangers never see the bio');
    assert.equal(carol.friend_tag, tags[CAROL], 'opted-in players can be sent a request');
    assert.deepEqual(carol.badges, ['chef', 'first']);
    // Bob's card: a friend sees bio and status, and no tag is needed.
    const bob = (await step(ALICE, (q) => q.one('select public.player_card($1) as c', [BOB]))).c;
    assert.equal(bob.friend, true);
    assert.equal(bob.friend_tag, null);
    assert.notEqual(bob.bio, null);
    // Alice's own ranking: not on the global board until she opts in.
    let mine = await step(ALICE, (q) => q.one('select points::int, show_in_global, global_rank::int, global_players::int from public.my_ranking()'));
    assert.deepEqual(mine, { points: 12, show_in_global: false, global_rank: null, global_players: 1 });
    await step(ALICE, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [ALICE]));
    mine = await step(ALICE, (q) => q.one('select global_rank::int, global_players::int from public.my_ranking()'));
    assert.deepEqual(mine, { global_rank: 2, global_players: 2 });

    // A stranger who didn't opt in stays invisible: Carol can't see Bob.
    assert.equal((await step(CAROL, (q) => q.one('select public.player_card($1) as c', [BOB]))).c, null);
    // A block hides Carol from Alice's board and card, both ways.
    await step(ALICE, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [ALICE, CAROL]));
    assert.deepEqual((await step(ALICE, (q) => q.rows("select user_id from public.leaderboard('global')"))).map((r) => r.user_id), [ALICE]);
    assert.equal((await step(CAROL, (q) => q.one('select public.player_card($1) as c', [ALICE]))).c, null);
    // Signed out: nothing.
    await step(null, async (q) => {
      await fails(q.rows("select * from public.leaderboard('global')"), /permission denied/);
    });
  });
});

test('ranked: export includes points and stats; deleting the account deletes them', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, (q) => submit(q, 9));
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.points_by_day.length, 1);
    assert.equal(data.player_stats.stamped, 12);
    await db.query('delete from auth.users where id = $1', [ALICE]);
    assert.equal((await db.query('select count(*)::int as n from public.daily_points where user_id = $1', [ALICE])).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.player_stats where user_id = $1', [ALICE])).rows[0].n, 0);
  });
});

test('YouTube search cache and quota: only the Edge Function (service role) reaches them', async () => {
  await withPeople(async ({ step }) => {
    for (const user of [null, ALICE]) {
      await step(user, async (q) => {
        await fails(q.rows('select * from public.youtube_cache_get($1)', ['chess']), /permission denied/);
      });
      await step(user, async (q) => {
        await fails(q.one("select public.youtube_cache_put($1, '[]'::jsonb)", ['chess']), /permission denied/);
      });
      await step(user, async (q) => {
        await fails(q.one('select public.youtube_take_search(1000)'), /permission denied/);
      });
      await step(user, async (q) => {
        await fails(q.rows('select * from private.youtube_searches'), /permission denied/);
      });
    }
  });
});

test('YouTube search quota: stops at the daily cap; the cache keeps the latest results', async () => {
  await db.exec('begin');
  try {
    await db.exec('set local role service_role');
    const take = async () => (await db.query('select public.youtube_take_search(2) as ok')).rows[0].ok;
    assert.deepEqual([await take(), await take(), await take()], [true, true, false]);

    await db.query(`select public.youtube_cache_put('chess', '[{"id":"a"}]'::jsonb)`);
    await db.query(`select public.youtube_cache_put('chess', '[{"id":"b"}]'::jsonb)`);
    const rows = (await db.query(`select items from public.youtube_cache_get('chess')`)).rows;
    assert.deepEqual(rows.map((r) => r.items), [[{ id: 'b' }]]);
    assert.equal((await db.query(`select * from public.youtube_cache_get('go')`)).rows.length, 0);
  } finally {
    await db.exec('rollback');
  }
});

// ---------------------------------------------------------------- friends' feed and reactions

const share = (q, title, detail = '') => q.one("select public.share_post('pick', 'idea:run-5k', $1, 'sport', $2) as id", [title, detail]);

test('feed: friends see what you share, strangers never; reactions are friends-only', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const post = (await step(ALICE, (q) => share(q, 'Easy 5 km run'))).id;
    // Sharing the same thing again soon returns the same post.
    assert.equal((await step(ALICE, (q) => share(q, 'Easy 5 km run'))).id, post);

    const bobFeed = await step(BOB, (q) => q.rows('select id, author, own, counts from public.friend_feed()'));
    assert.deepEqual(bobFeed.map((r) => [r.id, r.author, r.own, r.counts]), [[post, ALICE, false, null]], 'counts are for the author only');
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.friend_feed()'))).length, 0, 'a stranger sees nothing');

    // Bob reacts; toggling twice turns it off; Alice sees the count, Bob sees his own reaction.
    assert.equal((await step(BOB, (q) => q.one("select public.toggle_reaction($1, 'fire') as on", [post]))).on, true);
    assert.equal((await step(BOB, (q) => q.one("select public.toggle_reaction($1, 'laugh') as on", [post]))).on, true);
    assert.equal((await step(BOB, (q) => q.one("select public.toggle_reaction($1, 'laugh') as on", [post]))).on, false);
    assert.deepEqual((await step(BOB, (q) => q.one('select mine from public.friend_feed()'))).mine, ['fire']);
    assert.deepEqual((await step(ALICE, (q) => q.one('select own, counts from public.friend_feed()'))), { own: true, counts: { fire: 1 } });

    // No reacting to your own post, to a stranger's, or with an unknown emoji.
    await step(ALICE, async (q) => {
      await fails(q.one("select public.toggle_reaction($1, 'fire')", [post]), /friends' posts/);
    });
    await step(CAROL, async (q) => {
      await fails(q.one("select public.toggle_reaction($1, 'fire')", [post]), /friends' posts/);
    });
    await step(BOB, async (q) => {
      await fails(q.one("select public.toggle_reaction($1, 'poop')", [post]), /unknown reaction/);
    });
    // Nobody reads or writes the tables directly.
    await step(BOB, async (q) => {
      await fails(q.rows('select * from public.posts'), /permission denied/);
    });
    await step(BOB, async (q) => {
      await fails(q.rows("insert into public.reactions (post_id, user_id, emoji) values ($1, $2, 'fire')", [post, BOB]), /permission denied/);
    });
    await step(null, async (q) => {
      await fails(q.rows('select * from public.friend_feed()'), /permission denied/);
    });

    // A block hides the feed both ways; only the author can delete a post.
    await step(BOB, (q) => q.one('select public.delete_post($1)', [post]));
    assert.equal((await step(ALICE, (q) => q.rows('select id from public.friend_feed()'))).length, 1, "Bob can't delete Alice's post");
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    assert.equal((await step(BOB, (q) => q.rows('select * from public.friend_feed() where author = $1', [ALICE]))).length, 0);
    await step(ALICE, (q) => q.one('select public.delete_post($1)', [post]));
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.friend_feed()'))).length, 0);
  });
});

test('feed: values are checked, posts expire, sharing is capped, export and deletion include it', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(q.one("select public.share_post('selfie', null, 'x', '', '')"), /violates check constraint/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one("select public.share_post('pick', 'javascript:alert(1)', 'x', '', '')"), /violates check constraint/);
    });
    for (let i = 0; i < 20; i++) await step(ALICE, (q) => share(q, `Idea ${i}`, String(i)));
    await step(ALICE, async (q) => {
      await fails(share(q, 'One too many', 'x'), /shared a lot today/);
    });
    // Expired posts disappear from the feed.
    await db.query("update public.posts set expires_at = now() - interval '1 minute' where author = $1", [ALICE]);
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.friend_feed()'))).length, 0);
    await db.query("update public.posts set expires_at = now() + interval '1 day' where author = $1", [ALICE]);
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.posts_you_shared.length, 20);
    await db.query('delete from auth.users where id = $1', [ALICE]);
    assert.equal((await db.query('select count(*)::int as n from public.posts')).rows[0].n, 0, 'deleting the account deletes its posts');
  });
});

// ---------------------------------------------------------------- streaks together

test('streaks together: only accepted, past invites between friends count', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await befriend(ALICE, CAROL);
    const invite = (from, to, status, daysAgo) =>
      db.query("insert into public.invites (from_user, to_user, idea_id, title, category, starts_at, status) values ($1, $2, 'idea:hike', 'Hike', 'sport', now() - make_interval(days => $3), $4)", [from, to, daysAgo, status]);
    // Past dates: the invite rules only allow upcoming times, so they're switched off to set up history.
    await db.query("set local session_replication_role = 'replica'");
    await invite(ALICE, BOB, 'accepted', 1);
    await invite(BOB, ALICE, 'accepted', 8);
    await invite(ALICE, BOB, 'declined', 15);
    await invite(ALICE, CAROL, 'pending', 2);
    await invite(ALICE, BOB, 'accepted', -2); // in the future: not done yet
    await db.query("set local session_replication_role = 'origin'");
    const weeks = await step(ALICE, (q) => q.rows('select friend, week::text from public.together_weeks() order by week'));
    assert.equal(weeks.length, 2, 'two different weeks with Bob, nothing with Carol');
    assert.ok(weeks.every((w) => w.friend === BOB));
    // Bob sees the same weeks with Alice; Carol sees nothing.
    assert.equal((await step(BOB, (q) => q.rows('select * from public.together_weeks()'))).length, 2);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.together_weeks()'))).length, 0);
    // Unfriending stops counting.
    await db.query('delete from public.friendships where (requester = $1 and addressee = $2) or (requester = $2 and addressee = $1)', [ALICE, BOB]);
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.together_weeks()'))).length, 0);
    await step(null, async (q) => {
      await fails(q.rows('select * from public.together_weeks()'), /permission denied/);
    });
  });
});

/** Like asService, for a call that must fail: the failed statement is rolled back after. */
async function serviceFails(fn, pattern) {
  await db.exec('savepoint s');
  await db.exec('set local role service_role');
  try {
    await assert.rejects(fn({ one: async (sql, params) => (await db.query(sql, params)).rows[0] }), pattern);
  } finally {
    await db.exec('rollback to savepoint s');
    await db.exec('release savepoint s');
  }
}

const fileTicket = (q, who, ip, message = 'The quiz button does nothing', category = 'bug') =>
  q.one('select public.support_submit($1, $2, $3, $4, $5, $6, $7, $8, $9) as id', [who, ip, category, message, null, '0.3.1', 'desktop', 'fr', 'discover']);
const ipHash = (n) => String(n).padStart(64, 'a');

test('support tickets: only the Edge Function writes them, only admins read and handle them', async () => {
  await withPeople(async ({ step }) => {
    await db.query('insert into private.admins (user_id) values ($1)', [BOB]);

    // Nobody but the service role can file one directly.
    for (const who of [ALICE, null]) {
      await step(who, async (q) => {
        await fails(fileTicket(q, ALICE, ipHash(1)), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.rows("insert into public.support_tickets (category, message) values ('bug', 'something is broken')"), /permission denied/);
      });
    }
    const { id } = await asService((q) => fileTicket(q, ALICE, ipHash(1)));
    assert.ok(id > 0);
    await asService((q) => fileTicket(q, null, ipHash(2), 'I cannot sign in at all', 'account'));

    // Admins see both; others see nothing (signed out: not even the table).
    assert.equal((await step(BOB, (q) => q.rows('select * from public.support_tickets'))).length, 2);
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.support_tickets'))).length, 0, 'not even your own');
    await step(null, async (q) => {
      await fails(q.rows('select * from public.support_tickets'), /permission denied/);
    });
    assert.equal((await step(ALICE, (q) => q.one('select public.is_admin() as a'))).a, false);
    assert.equal((await step(BOB, (q) => q.one('select public.is_admin() as a'))).a, true);
    await step(null, async (q) => {
      await fails(q.one('select public.is_admin()'), /permission denied/);
    });

    // An admin changes the status and leaves a note; the message itself can't be rewritten.
    await step(BOB, (q) => q.rows("update public.support_tickets set status = 'in_progress', admin_note = 'Looking at it' where id = $1", [id]));
    const after = await step(BOB, (q) => q.one('select status, admin_note, updated_at > created_at as touched from public.support_tickets where id = $1', [id]));
    assert.deepEqual([after.status, after.admin_note], ['in_progress', 'Looking at it']);
    await step(BOB, async (q) => {
      await fails(q.rows("update public.support_tickets set message = 'rewritten' where id = $1", [id]), /permission denied/);
    });
    await step(BOB, async (q) => {
      await fails(q.rows("update public.support_tickets set status = 'deleted' where id = $1", [id]), /check constraint/);
    });
    // A non-admin's update touches nothing.
    await step(ALICE, (q) => q.rows("update public.support_tickets set status = 'closed' where id = $1", [id]));
    assert.equal((await step(BOB, (q) => q.one('select status from public.support_tickets where id = $1', [id]))).status, 'in_progress');
    await step(BOB, async (q) => {
      await fails(q.rows('delete from public.support_tickets where id = $1', [id]), /permission denied/);
    });
  });
});

test('support tickets: values are checked, senders are rate limited, deleted accounts are unlinked', async () => {
  await withPeople(async () => {
    await serviceFails((q) => fileTicket(q, null, ipHash(3), 'too short'), /check constraint/);
    await serviceFails((q) => fileTicket(q, null, ipHash(3), 'A real description here', 'spam'), /check constraint/);

    for (let i = 0; i < 10; i++) await asService((q) => fileTicket(q, null, ipHash(4), `Problem number ${i} here`));
    await serviceFails((q) => fileTicket(q, null, ipHash(4)), /too many tickets from this connection/);
    await asService((q) => fileTicket(q, null, ipHash(5)));

    for (let i = 0; i < 5; i++) await asService((q) => fileTicket(q, CAROL, ipHash(10 + i), `Account problem ${i} here`));
    await serviceFails((q) => fileTicket(q, CAROL, ipHash(20)), /too many tickets from this account/);

    await db.query('delete from auth.users where id = $1', [CAROL]);
    const left = (await db.query('select count(*)::int as n, count(user_id)::int as linked from public.support_tickets where message like $1', ['Account problem%'])).rows[0];
    assert.deepEqual([left.n, left.linked], [5, 0], 'the tickets stay, without the account');
  });
});
