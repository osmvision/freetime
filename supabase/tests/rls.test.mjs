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