// Proves the permission rules of the migrations: each test signs in as someone and checks what
// they can and cannot see or change. Run: cd supabase/tests && npm install && npm test
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { GameError, handle } from '../functions/games/handler.js';

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
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  // Undo first, so a wrong message is reported as such rather than as an aborted transaction.
  await db.exec('rollback to savepoint s');
  assert.ok(error, `expected an error matching ${pattern}`);
  assert.match(String(error), pattern);
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

test('profile photos: upload, replace, remove, and follow profile visibility', async () => {
  // Valid 160×160 grayscale PNGs and a 1×1 PNG used to test the size check.
  const first = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAAAAACupDjxAAAAq0lEQVR4nO3OMQEAIAzAsEnDvyok7MgBR6Mgcz43rwObgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoCqqCqqAqqAqqgqqgKqgKqoKqoCqoLhwmAXgB4UisAAAAAElFTkSuQmCC';
  const replacement = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAAAAACupDjxAAAAqklEQVR4nO3OMQEAIAzAsElHOhJ25ICjUZA5n5vXgU1BVVAVVAVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQX050C76n7tDUAAAAASUVORK5CYII=';
  const wrongSize = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNQAAAAIgAh4+9nCwAAAABJRU5ErkJggg==';
  await withPeople(async ({ step }) => {
    const photos = (who) => step(who, (q) => q.rows('select image from public.profile_photos where user_id = $1', [ALICE]));
    const save = (q, name, image) => q.one(
      "select public.save_profile_with_photo($1, 2::smallint, 1::smallint, '', '', $2) as profile", [name, image],
    );
    assert.equal((await step(ALICE, (q) => save(q, 'Alice', first))).profile.id, ALICE);
    assert.deepEqual(await photos(ALICE), [{ image: first }]);
    assert.deepEqual(await photos(BOB), []);
    await step(null, async (q) => {
      await fails(q.rows('select * from public.profile_photos'), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(save(q, 'Invalid edit', wrongSize), /profile_photo_format/);
    });
    assert.equal((await step(ALICE, (q) => q.one('select display_name from public.profiles where id = $1', [ALICE]))).display_name, 'Alice');
    assert.deepEqual(await photos(ALICE), [{ image: first }]);

    await befriend(ALICE, BOB);
    assert.deepEqual(await photos(BOB), [{ image: first }]);
    assert.deepEqual(await step(BOB, (q) => q.rows('update public.profile_photos set image = $2 where user_id = $1 returning user_id', [ALICE, replacement])), []);
    await step(BOB, async (q) => {
      await fails(q.rows('insert into public.profile_photos (user_id, image) values ($1, $2)', [ALICE, replacement]), /row-level security/);
    });
    await step(ALICE, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [ALICE]));
    assert.deepEqual(await photos(CAROL), [{ image: first }]);
    await step(CAROL, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [CAROL, ALICE]));
    assert.deepEqual(await photos(CAROL), []);

    await step(ALICE, (q) => save(q, 'Alice', replacement));
    assert.deepEqual(await photos(BOB), [{ image: replacement }]);
    await step(ALICE, (q) => q.rows("update public.profiles set bio = 'Updated bio' where id = $1", [ALICE]));
    assert.deepEqual(await photos(ALICE), [{ image: replacement }]);
    const exported = (who) => step(who, async (q) => (await q.one('select public.export_my_data() as data')).data.profile_photo);
    assert.equal(await exported(ALICE), `data:image/png;base64,${replacement}`);
    assert.equal(await exported(BOB), null);

    await step(ALICE, (q) => save(q, 'Alice', null));
    assert.deepEqual(await photos(ALICE), []);
    assert.deepEqual(await photos(BOB), []);
    await step(ALICE, (q) => save(q, 'Alice', first));
    await step(ALICE, (q) => q.one('select public.delete_my_account()'));
    assert.deepEqual((await db.query('select user_id from public.profile_photos')).rows, []);
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
    // A second device can add a badge without erasing earlier achievements or lowering stats.
    await step(ALICE, (q) => q.one("select public.submit_points(current_date, 1, 3, array['ok', 'Bad Id', '<script>'], 1)"));
    const card = await step(ALICE, (q) => q.one('select public.player_card($1) as c', [ALICE]));
    assert.deepEqual(card.c.badges, ['chef', 'first', 'ok'], 'junk badge ids are dropped');
    assert.equal(card.c.stamped, 12);
    assert.equal(card.c.best_streak, 3);
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

test('support ticket photos are private, saved atomically, and deleted with the ticket', async () => {
  const image = readFileSync(join(here, '..', '..', 'desktop', 'ui', 'img', 'ideas', 'advent-of-code.jpg')).toString('base64');
  const submit = (q, photos, who = ALICE) => q.one(
    "select public.support_submit_with_photos($1, $2, 'bug', 'There is a screenshot of the problem.', null, null, null, null, null, $3) as id",
    [who, ipHash(25), photos],
  );
  await withPeople(async ({ step }) => {
    await db.query('insert into private.admins (user_id) values ($1)', [BOB]);
    await step(ALICE, async (q) => {
      await fails(submit(q, [image]), /permission denied/);
    });
    await serviceFails((q) => submit(q, [image, 'invalid']), /check constraint/);
    await serviceFails((q) => submit(q, [image, image, image, image]), /one to three photos/);
    assert.equal((await db.query('select count(*)::int as n from public.support_tickets')).rows[0].n, 0);
    const { id } = await asService((q) => submit(q, [image, image]));
    const { id: anonymousTicket } = await asService((q) => submit(q, [image], null));
    const { id: textTicket } = await asService((q) => fileTicket(q, ALICE, ipHash(26)));
    const counts = await step(BOB, (q) => q.rows('select id, photo_count from public.support_tickets order by id'));
    assert.deepEqual(counts, [{ id, photo_count: 2 }, { id: anonymousTicket, photo_count: 1 }, { id: textTicket, photo_count: 0 }]);
    assert.deepEqual(await step(BOB, (q) => q.rows('select position, image from public.support_ticket_photos where ticket_id = $1 order by position', [id])),
      [{ position: 1, image }, { position: 2, image }]);
    assert.deepEqual(await step(ALICE, (q) => q.rows('select image from public.support_ticket_photos')), []);
    await step(BOB, async (q) => {
      await fails(q.rows('delete from public.support_ticket_photos where ticket_id = $1', [id]), /permission denied/);
    });
    await step(null, async (q) => {
      await fails(q.rows('select image from public.support_ticket_photos'), /permission denied/);
    });
    await db.query('delete from public.support_tickets where id = $1', [id]);
    assert.deepEqual(await step(BOB, (q) => q.rows('select image from public.support_ticket_photos where ticket_id = $1', [id])), []);
  });
});
// ---------------------------------------------------------------- meet

test('meet: only people who chose to be visible, never friends, yourself or blocked people', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.meet_people()'))).length, 0, 'nobody opted in');
    for (const who of [BOB, CAROL]) await step(who, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [who]));
    const list = await step(ALICE, (q) => q.rows('select user_id, new, request from public.meet_people()'));
    assert.deepEqual(list.map((r) => r.user_id), [CAROL], 'Bob is already a friend');
    assert.equal(list[0].new, true);
    assert.equal(list[0].request, 'none');
    // The list never carries email, bio or status: only these columns.
    const cols = Object.keys(await step(ALICE, (q) => q.one('select * from public.meet_people()')));
    assert.deepEqual(cols.sort(), ['avatar_color', 'avatar_icon', 'badges', 'display_name', 'new', 'points', 'request', 'user_id']);
    // Carol never sees herself; hidden Alice doesn't show, visible Bob does.
    assert.deepEqual((await step(CAROL, (q) => q.rows('select user_id from public.meet_people()'))).map((r) => r.user_id), [BOB]);
    // A block hides both ways.
    await step(CAROL, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [CAROL, ALICE]));
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.meet_people()'))).length, 0);
    await step(null, async (q) => {
      await fails(q.rows('select * from public.meet_people()'), /permission denied/);
    });
  });
});

test('meet: a one-tap request only reaches visible people, and is capped', async () => {
  await withPeople(async ({ step }) => {
    // Carol is hidden: no request by id (same answer as for an unknown id).
    await step(ALICE, async (q) => {
      await fails(q.one('select public.request_friend($1)', [CAROL]), /can't be added from here/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.request_friend($1)', ['00000000-0000-4000-8000-0000000000ff']), /can't be added from here/);
    });
    await step(CAROL, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [CAROL]));
    assert.equal((await step(ALICE, (q) => q.one('select public.request_friend($1) as r', [CAROL]))).r, 'pending');
    assert.equal((await step(ALICE, (q) => q.one('select public.request_friend($1) as r', [CAROL]))).r, 'pending', 'asking twice changes nothing');
    assert.equal((await step(ALICE, (q) => q.one('select request from public.meet_people()'))).request, 'sent');
    // Hidden Alice asked visible Carol: Carol can answer by id, even though Alice is hidden.
    assert.equal((await step(CAROL, (q) => q.one('select public.request_friend($1) as r', [ALICE]))).r, 'accepted');
    assert.equal((await step(ALICE, (q) => q.rows('select * from public.meet_people()'))).length, 0, 'friends leave the list');
    // Not to yourself; a block refuses.
    await step(BOB, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [BOB]));
    await step(ALICE, async (q) => {
      await fails(q.one('select public.request_friend($1)', [ALICE]), /can't be added from here/);
    });
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    await step(ALICE, async (q) => {
      await fails(q.one('select public.request_friend($1)', [BOB]), /can't be added from here/);
    });
  });
});

test('meet: at most 20 requests sent a day', async () => {
  await withPeople(async ({ step }) => {
    await step(BOB, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [BOB]));
    // 20 requests made today to other people (inserted directly, then answered so they don't stay pending).
    for (let i = 0; i < 20; i++) {
      const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `x${i}@test`]);
      await db.query("insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')", [ALICE, id]);
    }
    await step(ALICE, async (q) => {
      await fails(q.one('select public.request_friend($1)', [BOB]), /a lot of friend requests/);
    });
  });
});

// ---------------------------------------------------------------- quiz duels

/** The right answers of a duel, read as the database owner. */
async function duelKey(id) {
  return (await db.query('select array_agg(k.answer order by q.n) as key from public.duels d, unnest(d.questions) with ordinality q(id, n) join public.quiz_keys k on k.id = q.id where d.id = $1', [id])).rows[0].key;
}

test('duels: only between friends, 5 questions from 5 topics, one at a time per pair', async () => {
  await withPeople(async ({ step }) => {
    await step(ALICE, async (q) => {
      await fails(q.one('select public.create_duel($1)', [BOB]), /only challenge your friends/);
    });
    await befriend(ALICE, BOB);
    const id = (await step(ALICE, (q) => q.one('select public.create_duel($1) as id', [BOB]))).id;
    const d = (await db.query('select questions from public.duels where id = $1', [id])).rows[0];
    assert.equal(d.questions.length, 5);
    const topics = (await db.query('select count(distinct topic)::int as n from public.quiz_keys where id = any($1)', [d.questions])).rows[0].n;
    assert.equal(topics, 5, 'five different topics');
    await step(ALICE, async (q) => {
      await fails(q.one('select public.create_duel($1)', [BOB]), /already have a duel going/);
    });
    await step(BOB, async (q) => {
      await fails(q.one('select public.create_duel($1)', [ALICE]), /already have a duel going/);
    });
    // Bob sees it as his turn, with the questions; Alice waits and doesn't get them.
    const bob = (await step(BOB, (q) => q.one('select public.my_duels() as d'))).d;
    assert.equal(bob.length, 1);
    assert.equal(bob[0].state, 'your_turn');
    assert.equal(bob[0].questions.length, 5);
    assert.equal(bob[0].challenger, false);
    // Carol, a stranger, sees nothing and can't read the table or the answer key.
    assert.equal((await step(CAROL, (q) => q.one('select public.my_duels() as d'))).d.length, 0);
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.duels'))).length, 0);
    await step(BOB, async (q) => {
      await fails(q.rows('select * from public.quiz_keys'), /permission denied/);
    });
    await step(BOB, async (q) => {
      await fails(q.rows('select * from public.duel_answers'), /permission denied/);
    });
  });
});

test('duels: the server scores the answers; nobody plays twice, for someone else, or writes directly', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const id = (await step(ALICE, (q) => q.one('select public.create_duel($1) as id', [BOB]))).id;
    const key = await duelKey(id);
    // Alice gets 4 right (the 3rd is wrong).
    const mine = key.map((k, i) => (i === 2 ? (k + 1) % 4 : k));
    const r = (await step(ALICE, (q) => q.one('select public.play_duel($1, $2) as r', [id, mine]))).r;
    assert.equal(r.score, 4);
    assert.deepEqual(r.key, key);
    assert.equal(r.other_score, null);
    assert.equal(r.status, 'open');
    await step(ALICE, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, key]), /already played/);
    });
    // Carol isn't in it; bad answers are refused.
    await step(CAROL, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, key]), /no such duel/);
    });
    await step(BOB, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, [0, 1, 2]]), /5 answers/);
    });
    await step(BOB, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, [0, 1, 2, 3, 9]]), /5 answers/);
    });
    // No direct writes, even to your own duel.
    await step(ALICE, async (q) => {
      await fails(q.rows('update public.duels set challenger_score = 5 where id = $1', [id]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.duels (challenger, opponent, questions) values ($1, $2, '{q001,q002,q003,q004,q005}')", [ALICE, BOB]), /permission denied/);
    });
    // Bob plays everything right: the duel is done and both see both scores.
    const b = (await step(BOB, (q) => q.one('select public.play_duel($1, $2) as r', [id, key]))).r;
    assert.equal(b.score, 5);
    assert.equal(b.other_score, 4);
    assert.equal(b.status, 'done');
    const seen = (await step(ALICE, (q) => q.one('select public.my_duels() as d'))).d[0];
    assert.deepEqual([seen.state, seen.my_score, seen.their_score, seen.questions], ['done', 4, 5, null]);
    // A finished duel frees the pair for a new one; it shows in the export.
    await step(BOB, (q) => q.one('select public.create_duel($1)', [ALICE]));
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.quiz_duels.length, 2);
    assert.equal(data.quiz_duels[0].your_score, 4);
  });
});

test('duels: declined, cancelled and expired duels are over; at most 5 waiting; blocks hide them', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await befriend(ALICE, CAROL);
    let id = (await step(ALICE, (q) => q.one('select public.create_duel($1) as id', [BOB]))).id;
    await step(BOB, (q) => q.one('select public.drop_duel($1)', [id]));
    assert.equal((await db.query('select status from public.duels where id = $1', [id])).rows[0].status, 'declined');
    await step(BOB, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, [0, 0, 0, 0, 0]]), /over/);
    });
    id = (await step(ALICE, (q) => q.one('select public.create_duel($1) as id', [CAROL]))).id;
    await step(ALICE, (q) => q.one('select public.drop_duel($1)', [id]));
    assert.equal((await db.query('select status from public.duels where id = $1', [id])).rows[0].status, 'cancelled');
    // Older than 7 days: expired, can't be played, and the pair can start again.
    id = (await step(ALICE, (q) => q.one('select public.create_duel($1) as id', [BOB]))).id;
    await db.query("update public.duels set created_at = now() - interval '8 days' where id = $1", [id]);
    await step(BOB, async (q) => {
      await fails(q.one('select public.play_duel($1, $2)', [id, [0, 0, 0, 0, 0]]), /over/);
    });
    assert.equal((await step(BOB, (q) => q.one('select public.my_duels() as d'))).d.find((d) => d.id === id).state, 'expired');
    await step(ALICE, (q) => q.one('select public.create_duel($1)', [BOB]));
    // At most 5 waiting per challenger.
    for (let i = 0; i < 4; i++) {
      const id2 = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id2, `d${i}@test`]);
      await befriend(ALICE, id2);
      await step(ALICE, (q) => q.one('select public.create_duel($1)', [id2]));
    }
    await step(ALICE, async (q) => {
      await fails(q.one('select public.create_duel($1)', [CAROL]), /5 duels waiting/);
    });
    // Blocking hides the duels with that person.
    await step(BOB, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]));
    const left = (await step(ALICE, (q) => q.one('select public.my_duels() as d'))).d;
    assert.ok(left.every((d) => d.other.id !== BOB));
    await step(null, async (q) => {
      await fails(q.one('select public.my_duels()'), /permission denied/);
    });
  });
});

test('duels: the answer key covers the questions with valid values', async () => {
  const r = (await db.query("select count(*)::int as n, count(distinct topic)::int as topics, min(answer)::int as lo, max(answer)::int as hi from public.quiz_keys")).rows[0];
  assert.ok(r.n >= 100);
  assert.ok(r.topics >= 5, 'enough topics for 5 different ones');
  assert.ok(r.lo >= 0 && r.hi <= 3);
});

// ---------------------------------------------------------------- turn-based games

/** The games Edge Function's database, as the service role (like supabase-js: { data, error }). */
const serviceDb = {
  async rpc(name, args) {
    const keys = Object.keys(args);
    const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    await db.exec('savepoint svc');
    await db.exec('set local role service_role');
    try {
      const res = await db.query(sql, params);
      await db.exec('reset role');
      await db.exec('release savepoint svc');
      return { data: res.rows[0].r, error: null };
    } catch (e) {
      await db.exec('rollback to savepoint svc');
      await db.exec('release savepoint svc');
      return { data: null, error: { code: e.code, message: e.message } };
    }
  },
};

/** Calls the Edge Function's handler as `user`; returns its answer or { status, code }. */
async function games(user, body, first = 0) {
  try {
    return await handle(serviceDb, user, body, () => (first === 0 ? 0.1 : 0.9));
  } catch (e) {
    if (e instanceof GameError) return { status: e.status, code: e.code, message: e.message };
    throw e;
  }
}

const myMatches = (step, who) => step(who, async (q) => (await q.one('select public.my_matches() as m')).m);

test('game rankings: completed results, tied ranks, friends, and worldwide visibility', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await db.query("update public.profiles set display_name = case id when $1 then 'Alice' when $2 then 'Bob' else 'Carol' end", [ALICE, BOB]);
    await db.query(`
      insert into public.matches (game, player_a, player_b, state, status, result, finished_at)
      values ('four', $1, $2, '{}', 'done', 'a', now() - interval '90 days'),
             ('four', $2, $3, '{}', 'done', 'b', now()),
             ('four', $3, $1, '{}', 'done', 'draw', now()),
             ('four', $1, $2, '{}', 'active', null, null),
             ('four', $1, $2, '{}', 'active', null, null),
             ('four', $1, $2, '{}', 'cancelled', null, now()),
             ('four', $2, $1, '{}', 'declined', null, now()),
             ('gomoku', $2, $1, '{}', 'done', 'a', now())
    `, [ALICE, BOB, CAROL]);
    await db.exec("update public.matches set updated_at = now() - interval '8 days' where id = (select id from public.matches where status = 'active' limit 1)");
    await db.query(`
      insert into public.duels (challenger, opponent, questions, challenger_score, opponent_score, status, finished_at)
      values ($1, $2, array['q1','q2','q3','q4','q5'], 4, 2, 'done', now()),
             ($2, $1, array['q1','q2','q3','q4','q5'], 5, 5, 'done', now()),
             ($1, $2, array['q1','q2','q3','q4','q5'], 5, null, 'open', null)
    `, [ALICE, BOB]);

    const board = (game, scope, who = ALICE) =>
      step(who, async (q) => (await q.one('select public.game_leaderboard($1, $2) as board', [game, scope])).board);
    const fields = ({ rows }) => rows.map((r) => [r.display_name, r.rank, r.points, r.wins, r.draws, r.losses, r.me]);
    assert.deepEqual(fields(await board('four', 'friends')), [
      ['Alice', 1, 4, 1, 1, 0, true], ['Bob', 2, 0, 0, 0, 2, false],
    ]);
    assert.deepEqual(fields(await board('gomoku', 'friends')), [
      ['Bob', 1, 3, 1, 0, 0, false], ['Alice', 2, 0, 0, 0, 1, true],
    ]);
    assert.deepEqual(fields(await board('quiz-duel', 'friends')), [
      ['Alice', 1, 4, 1, 1, 0, true], ['Bob', 2, 1, 0, 1, 1, false],
    ]);
    assert.deepEqual(await board('four', 'global'), { show_in_global: false, rows: [] });

    await step(CAROL, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [CAROL]));
    assert.deepEqual(fields(await board('four', 'global')), [['Carol', 1, 4, 1, 1, 0, false]]);
    await step(ALICE, (q) => q.rows('update public.profiles set show_in_global = true where id = $1', [ALICE]));
    const global = await board('four', 'global');
    assert.equal(global.show_in_global, true);
    assert.deepEqual(fields(global), [['Alice', 1, 4, 1, 1, 0, true], ['Carol', 1, 4, 1, 1, 0, false]]);
    assert.deepEqual(Object.keys(global.rows[1]).sort(), ['avatar_color', 'avatar_icon', 'display_name', 'draws', 'losses', 'me', 'points', 'rank', 'wins']);
    assert.deepEqual(await step(ALICE, (q) => q.rows('select player_a from public.matches where player_a = $1', [BOB])), [{ player_a: BOB }, { player_a: BOB }]);

    await step(ALICE, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [ALICE, CAROL]));
    assert.deepEqual(fields(await board('four', 'global')), [['Alice', 1, 4, 1, 1, 0, true]]);
    assert.deepEqual(fields(await board('four', 'global', CAROL)), [['Carol', 1, 4, 1, 1, 0, true]]);
    await step(ALICE, async (q) => {
      await fails(q.one("select public.game_leaderboard('solo', 'global')"), /unknown game leaderboard/);
    });
    await step(null, async (q) => {
      await fails(q.one("select public.game_leaderboard('four', 'global')"), /permission denied/);
    });
  });
});

test('games: only the Edge Function (service role) writes games; players only read their own', async () => {
  await withPeople(async ({ step }) => {
    for (const who of [ALICE, null]) {
      await step(who, async (q) => {
        await fails(q.one("select public.match_open($1, $2, 'four', '{}'::jsonb, 0::smallint, null)", [ALICE, BOB]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.one('select public.match_load($1, $2)', [ALICE, ALICE]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.one("select public.match_save($1, $2, 0, '{}'::jsonb, 0::smallint, 'a', null)", [ALICE, ALICE]), /permission denied/);
      });
      await step(who, async (q) => {
        await fails(q.rows('select * from public.match_secrets'), /permission denied/);
      });
    }
    await befriend(ALICE, BOB);
    const { id } = await games(ALICE, { action: 'start', game: 'four', opponent: BOB });
    await step(ALICE, async (q) => {
      await fails(q.rows("update public.matches set result = 'a' where id = $1", [id]), /permission denied/);
    });
    await step(ALICE, async (q) => {
      await fails(q.rows("insert into public.matches (game, player_a, player_b, state) values ('four', $1, $2, '{}')", [ALICE, BOB]), /permission denied/);
    });
    assert.equal((await step(CAROL, (q) => q.rows('select * from public.matches'))).length, 0, 'strangers see nothing');
    assert.equal((await step(BOB, (q) => q.rows('select * from public.matches'))).length, 1);
    await step(null, async (q) => {
      await fails(q.one('select public.my_matches()'), /permission denied/);
    });
  });
});

test('games: a whole game of four in a row, checked move by move', async () => {
  await withPeople(async ({ step }) => {
    assert.equal((await games(ALICE, { action: 'start', game: 'four', opponent: BOB })).code, 'not_found', 'friends only');
    await befriend(ALICE, BOB);
    const start = await games(ALICE, { action: 'start', game: 'four', opponent: BOB }, 0);
    assert.equal(start.state.turn, 0);
    assert.equal((await games(ALICE, { action: 'start', game: 'four', opponent: BOB })).code, 'already', 'one game per pair');
    assert.equal((await games(BOB, { action: 'start', game: 'four', opponent: ALICE })).code, 'already');
    let [mine] = await myMatches(step, ALICE);
    assert.deepEqual([mine.phase, mine.me, mine.game], ['your_turn', 0, 'four']);
    assert.equal((await myMatches(step, BOB))[0].phase, 'waiting');

    let version = 0;
    const move = async (who, col) => {
      const r = await games(who, { action: 'move', match: start.id, version, move: { col } });
      if (r.version) version = r.version;
      return r;
    };
    assert.equal((await move(BOB, 3)).code, 'illegal', 'not his turn');
    assert.equal((await move(CAROL, 3)).code, 'not_found', 'not her game');
    assert.equal((await games(ALICE, { action: 'move', match: start.id, version: 7, move: { col: 0 } })).code, 'stale');
    assert.equal((await move(ALICE, 9)).code, 'illegal');
    for (const [who, col] of [[ALICE, 0], [BOB, 1], [ALICE, 0], [BOB, 1], [ALICE, 0], [BOB, 1]]) {
      assert.ok((await move(who, col)).state, `${who} plays ${col}`);
    }
    const last = await move(ALICE, 0);
    assert.equal(last.state.winner, 0);
    assert.equal((await move(BOB, 2)).code, 'over');
    [mine] = await myMatches(step, ALICE);
    assert.deepEqual([mine.phase, mine.outcome], ['over', 'won']);
    assert.equal((await myMatches(step, BOB))[0].outcome, 'lost');
    // A finished game frees the pair for a new one, and shows in the export.
    assert.ok((await games(BOB, { action: 'start', game: 'four', opponent: ALICE })).id);
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.games.length, 2);
  });
});

test('games: torpedoes fleets stay secret; shots are resolved on the server', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const fleetA = { ships: [[0, 1, 2, 3], [16, 24, 32], [20, 21, 22], [62, 63]] };
    const fleetB = { ships: [[7, 15, 23, 31], [40, 41, 42], [44, 45, 46], [56, 57]] };
    assert.equal((await games(ALICE, { action: 'start', game: 'torpedoes', opponent: BOB, fleet: { ships: [[0, 1]] } })).code, 'illegal', 'a full fleet is needed');
    const start = await games(ALICE, { action: 'start', game: 'torpedoes', opponent: BOB, fleet: fleetA });
    const seen = await step(BOB, (q) => q.one('select state::text as s from public.matches where id = $1', [start.id]));
    assert.equal(seen.s.includes('ships'), false, 'Bob never receives Alice’s ships');
    assert.equal(JSON.stringify(await myMatches(step, BOB)).includes('"ships"'), false);
    let version = 0;
    const act = async (who, move) => {
      const r = await games(who, { action: 'move', match: start.id, version, move });
      if (r.version) version = r.version;
      return r;
    };
    assert.equal((await act(ALICE, { fleet: fleetA })).code, 'illegal', 'not her turn: Bob places now');
    assert.equal((await act(BOB, { fleet: fleetB })).state.phase, 'play');
    assert.deepEqual((await act(ALICE, { cell: 56 })).state.shots[0], [{ c: 56, r: 'hit' }]);
    assert.equal((await act(BOB, { cell: 0 })).state.shots[1][0].r, 'hit');
    assert.equal((await act(ALICE, { cell: 57 })).state.sunk[0].length, 1);
    // Each player gets their own fleet back, never the other's.
    assert.deepEqual((await myMatches(step, ALICE))[0].my_secret, fleetA);
    assert.deepEqual((await myMatches(step, BOB))[0].my_secret, fleetB);
    assert.equal(JSON.stringify(await myMatches(step, BOB)).includes('[0,1,2,3]'), false, 'Alice’s ships never reach Bob');
    // Bob's own fleet is in his export; Alice's isn't.
    const data = (await step(BOB, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.deepEqual(data.games[0].your_ships, fleetB);
  });
});

test('games: declining, cancelling, resigning, expiry, blocks and the limit of 5', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await befriend(ALICE, CAROL);
    const leave = (who, id) => step(who, async (q) => (await q.one('select public.leave_match($1) as r', [id])).r);
    let g = await games(ALICE, { action: 'start', game: 'dots', opponent: BOB }, 1);
    assert.equal(await leave(BOB, g.id), 'declined');
    g = await games(ALICE, { action: 'start', game: 'dots', opponent: BOB }, 0);
    assert.equal(await leave(ALICE, g.id), 'cancelled');
    // Once Bob played, leaving is resigning: the other player wins.
    g = await games(ALICE, { action: 'start', game: 'gomoku', opponent: BOB }, 1);
    assert.ok((await games(BOB, { action: 'move', match: g.id, version: 0, move: { cell: 60 } })).state);
    assert.equal(await leave(BOB, g.id), 'resigned');
    assert.equal((await myMatches(step, ALICE)).find((m) => m.id === g.id).outcome, 'won');
    await step(ALICE, async (q) => {
      await fails(q.one('select public.leave_match($1)', [g.id]), /over/);
    });
    await step(CAROL, async (q) => {
      await fails(q.one('select public.leave_match($1)', [g.id]), /no such game/);
    });
    // 7 days without a move: expired, no more moves.
    g = await games(ALICE, { action: 'start', game: 'draughts', opponent: BOB }, 0);
    await db.query("update public.matches set updated_at = now() - interval '8 days' where id = $1", [g.id]);
    assert.equal((await games(ALICE, { action: 'move', match: g.id, version: 0, move: { path: [61, 50] } })).code, 'over');
    assert.equal((await myMatches(step, BOB)).find((m) => m.id === g.id).outcome, 'expired');
    // At most 5 games started at once.
    for (const game of ['four', 'gomoku', 'draughts', 'dots', 'torpedoes']) {
      const r = await games(ALICE, { action: 'start', game, opponent: CAROL, fleet: game === 'torpedoes' ? { ships: [[0, 1, 2, 3], [16, 24, 32], [20, 21, 22], [62, 63]] } : undefined });
      assert.ok(r.id, `${game}: ${r.message}`);
    }
    assert.equal((await games(ALICE, { action: 'start', game: 'draughts', opponent: BOB })).code, 'too_many');
    // A block hides the games and stops them.
    const id = (await myMatches(step, ALICE)).find((m) => m.other.id === CAROL && m.game === 'four').id;
    await step(CAROL, (q) => q.rows('insert into public.blocks (blocker, blocked) values ($1, $2)', [CAROL, ALICE]));
    assert.ok((await myMatches(step, ALICE)).every((m) => m.other.id !== CAROL));
    assert.equal((await games(ALICE, { action: 'move', match: id, version: 0, move: { col: 3 } })).code, 'not_found');
  });
});

test('games: clearing finished games hides them for you only', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const hide = (who, id) => step(who, (q) => q.rows('select public.hide_match($1)', [id]));
    const ids = (who) => myMatches(step, who).then((l) => l.map((m) => m.id));
    // Two finished games (declined, resigned) and one still going.
    const declined = await games(ALICE, { action: 'start', game: 'dots', opponent: BOB }, 1);
    await step(BOB, (q) => q.one('select public.leave_match($1)', [declined.id]));
    const resigned = await games(ALICE, { action: 'start', game: 'gomoku', opponent: BOB }, 1);
    assert.ok((await games(BOB, { action: 'move', match: resigned.id, version: 0, move: { cell: 60 } })).state);
    await step(BOB, (q) => q.one('select public.leave_match($1)', [resigned.id]));
    const going = await games(ALICE, { action: 'start', game: 'four', opponent: BOB }, 0);
    assert.equal((await ids(ALICE)).length, 3);

    // A game still going can't be cleared; nor one that isn't yours.
    await step(ALICE, async (q) => {
      await fails(q.one('select public.hide_match($1)', [going.id]), /not over/);
    });
    await step(CAROL, async (q) => {
      await fails(q.one('select public.hide_match($1)', [declined.id]), /no such game/);
    });

    // One game: gone for Alice, still there for Bob; the game itself is untouched.
    await hide(ALICE, declined.id);
    assert.deepEqual((await ids(ALICE)).sort(), [resigned.id, going.id].sort());
    assert.equal((await ids(BOB)).length, 3);
    assert.equal((await db.query('select count(*)::int as n from public.matches')).rows[0].n, 3);
    await hide(ALICE, declined.id); // again: harmless

    // All at once: only finished ones, and only for the one who asks.
    assert.equal((await step(ALICE, (q) => q.one('select public.hide_finished_matches() as n'))).n, 1);
    assert.deepEqual(await ids(ALICE), [going.id]);
    assert.equal((await ids(BOB)).length, 3);
    assert.equal((await step(BOB, (q) => q.one('select public.hide_finished_matches() as n'))).n, 2);
    assert.deepEqual(await ids(BOB), [going.id]);
    assert.equal((await step(BOB, (q) => q.one('select public.hide_finished_matches() as n'))).n, 0);

    // An expired game counts as finished.
    await db.query("update public.matches set updated_at = now() - interval '8 days' where id = $1", [going.id]);
    assert.equal((await step(ALICE, (q) => q.one('select public.hide_finished_matches() as n'))).n, 1);
    assert.deepEqual(await ids(ALICE), []);
    assert.equal((await ids(BOB)).length, 1);
  });
});

test('games: bad requests are refused before anything is saved', async () => {
  await withPeople(async () => {
    assert.equal((await games(ALICE, { action: 'start', game: 'checkers', opponent: BOB })).code, 'bad_request');
    assert.equal((await games(ALICE, { action: 'start', game: 'four', opponent: 'not-a-uuid' })).code, 'bad_request');
    assert.equal((await games(ALICE, { action: 'move', match: BOB, version: 'x' })).code, 'bad_request');
    assert.equal((await games(ALICE, { action: 'dance' })).code, 'bad_request');
    assert.equal((await games(ALICE, { action: 'move', match: '00000000-0000-4000-8000-0000000000ff', version: 0, move: {} })).code, 'not_found');
    assert.equal((await db.query('select count(*)::int as n from public.matches')).rows[0].n, 0);
  });
});

test('games: chess online — moves are checked by the real rules, and mate ends the game for both', async () => {
  await withPeople(async ({ step }) => {
    // Player 0 (Alice, who started it) has white. Squares: e2 = 52, e4 = 36...
    const sq = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
    const move = (text) => ({ from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)) });
    await befriend(ALICE, BOB);
    const g = await games(ALICE, { action: 'start', game: 'chess', opponent: BOB }, 0);
    assert.ok(g.id, g.message);
    assert.equal(g.state.game, 'chess');
    assert.equal(g.state.white, 0);
    let version = 0;
    const play = async (who, text) => {
      const r = await games(who, { action: 'move', match: g.id, version, move: move(text) });
      if (r.state) version = r.version;
      return r;
    };
    // Not Bob's turn, not a legal move, not a piece of yours: refused, and nothing changes.
    assert.equal((await play(BOB, 'e7e5')).code, 'illegal');
    assert.equal((await play(ALICE, 'e2e5')).code, 'illegal');
    assert.equal((await play(ALICE, 'e7e5')).code, 'illegal');
    assert.equal((await play(ALICE, 'f2f3')).state.turn, 1);
    assert.equal((await play(BOB, 'e7e5')).state.turn, 0);
    assert.equal((await play(ALICE, 'g2g4')).state.winner, null);
    const end = await play(BOB, 'd8h4');
    assert.equal(end.state.winner, 1, 'fool’s mate: black wins');
    assert.equal((await play(ALICE, 'a2a3')).code, 'over');
    assert.equal((await myMatches(step, BOB)).find((m) => m.id === g.id).outcome, 'won');
    assert.equal((await myMatches(step, ALICE)).find((m) => m.id === g.id).outcome, 'lost');
    const saved = (await db.query('select pg_column_size(state) as size from public.matches where id = $1', [g.id])).rows[0].size;
    assert.ok(saved < 4000, `the state takes ${saved} bytes`);
  });
});

// ---------------------------------------------------------------- end of game: record and chess ranking

test('head to head: your record against one friend, cleared games included, nobody else’s', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    await db.query(`
      insert into public.matches (game, player_a, player_b, state, status, result, finished_at, updated_at)
      values ('four', $1, $2, '{}', 'done', 'a', now(), now() - interval '3 days'),
             ('four', $2, $1, '{}', 'done', 'a', now(), now() - interval '2 days'),
             ('chess', $1, $2, '{}', 'done', 'draw', now(), now() - interval '1 day'),
             ('four', $1, $2, '{}', 'active', null, null, now()),
             ('four', $1, $3, '{}', 'done', 'a', now(), now())
    `, [ALICE, BOB, CAROL]);
    // Clearing a game hides it from the list, not from the record.
    await db.query("update public.matches set hidden_a = true where game = 'chess'");
    const h2h = (who, other, game = null) =>
      step(who, async (q) => (await q.one('select public.head_to_head($1, $2) as r', [other, game])).r);
    const alice = await h2h(ALICE, BOB);
    assert.deepEqual([alice.wins, alice.draws, alice.losses], [1, 1, 1]);
    assert.deepEqual(alice.last.map((g) => [g.game, g.outcome]), [['chess', 'draw'], ['four', 'lost'], ['four', 'won']]);
    const bob = await h2h(BOB, ALICE, 'four');
    assert.deepEqual([bob.wins, bob.draws, bob.losses], [1, 0, 1], 'one game only, from Bob’s side');
    // Carol never played Bob: nothing. Asking about yourself or an unknown game: refused.
    assert.deepEqual(await h2h(CAROL, BOB), { wins: 0, draws: 0, losses: 0, last: [] });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.head_to_head($1)', [ALICE]), /pick a friend/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.head_to_head($1, $2)', [BOB, 'poker']), /unknown game/);
    });
    await step(null, async (q) => {
      await fails(q.one('select public.head_to_head($1)', [BOB]), /permission denied/);
    });
    // Chess is ranked now.
    const board = await step(BOB, async (q) => (await q.one("select public.game_leaderboard('chess', 'friends') as b")).b);
    assert.deepEqual(board.rows.map((r) => [r.points, r.draws]), [[1, 1], [1, 1]]);
    // Blocked: an empty record.
    await db.query('insert into public.blocks (blocker, blocked) values ($1, $2)', [BOB, ALICE]);
    assert.equal((await h2h(ALICE, BOB)).last.length, 0);
  });
});

// ---------------------------------------------------------------- evenings

test('evenings: two times, three activities, friends only, answers and the final choice', async () => {
  await withPeople(async ({ step }) => {
    await befriend(ALICE, BOB);
    const at = (h) => new Date(Date.now() + h * 3600000).toISOString();
    const acts = JSON.stringify([
      { idea_id: 'steam:570', title: 'Dota 2', category: 'game' },
      { idea_id: 'play:four', title: 'Four in a row', category: 'game' },
      { idea_id: 'custom:pizza', title: 'Pizza at mine', category: 'food' },
    ]);
    const createSql = 'select public.create_evening($1::timestamptz[], $2::jsonb, $3, $4::uuid[]) as id';
    const create = (who, slots, guests, activities = acts) =>
      step(who, async (q) => (await q.one(createSql, [slots, activities, 'bring snacks', guests])).id);
    const list = (who) => step(who, async (q) => (await q.one('select public.my_evenings() as l')).l);

    // Only friends; one to eight guests; one or two different times within two weeks; 1-3 valid activities.
    await step(ALICE, async (q) => {
      await fails(q.one(createSql, [[at(2)], acts, '', [CAROL]]), /only invite your friends/);
    });
    for (const [slots, activities, pattern] of [
      [[at(2), at(2)], acts, /different times/],
      [[at(2), at(3), at(4)], acts, /different times/],
      [[at(24 * 15)], acts, /two weeks/],
      [[at(-2)], acts, /two weeks/],
      [[at(2)], '[]', /one to three/],
      [[at(2)], JSON.stringify([{ idea_id: 'x', title: 'Bad id', category: 'game' }]), /not valid/],
      [[at(2)], JSON.stringify([{ idea_id: 'idea:a', title: 'Bad kind', category: 'nap' }]), /not valid/],
    ]) {
      await step(ALICE, async (q) => {
        await fails(q.one(createSql, [slots, activities, '', [BOB]]), pattern);
      });
    }
    await step(ALICE, async (q) => {
      await fails(q.one(createSql, [[at(2)], acts, '', []]), /one to eight/);
    });
    await step(null, async (q) => {
      await fails(q.one(createSql, [[at(2)], acts, '', [BOB]]), /permission denied/);
    });

    // The tables themselves are closed.
    await step(BOB, async (q) => {
      await fails(q.rows('select * from public.evenings'), /permission denied/);
    });

    // Times come back earliest first.
    const id = await create(ALICE, [at(26), at(2)], [BOB]);
    const [mine] = await list(ALICE);
    assert.equal(mine.mine, true);
    assert.ok(new Date(mine.slots[0]) < new Date(mine.slots[1]));
    assert.equal(mine.activities.length, 3);
    assert.equal(mine.guests[0].answered, false);
    assert.equal((await list(CAROL)).length, 0, 'Carol isn’t invited');

    // Bob answers: the first time works, the second doesn't; he'd rather play Four in a row.
    const answerSql = 'select public.answer_evening($1, $2::boolean[], $3)';
    await step(BOB, async (q) => {
      await fails(q.one(answerSql, [id, [true], null]), /each time/);
    });
    await step(BOB, async (q) => {
      await fails(q.one(answerSql, [id, [true, false], 3]), /no such activity/);
    });
    await step(CAROL, async (q) => {
      await fails(q.one(answerSql, [id, [true, false], null]), /no such evening/);
    });
    await step(BOB, (q) => q.one(answerSql, [id, [true, false], 1]));
    const seen = (await list(ALICE))[0].guests[0];
    assert.deepEqual([seen.slots, seen.activity, seen.answered], [[true, false], 1, true]);

    // Only the host settles, once; then answers are closed.
    await step(BOB, async (q) => {
      await fails(q.one('select public.settle_evening($1, 0::smallint, 1::smallint)', [id]), /no such evening/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.settle_evening($1, 2::smallint, 1::smallint)', [id]), /pick one of the times/);
    });
    await step(ALICE, (q) => q.one('select public.settle_evening($1, 0::smallint, 1::smallint)', [id]));
    const settled = (await list(BOB))[0];
    assert.deepEqual([settled.status, settled.chosen_slot, settled.chosen_activity], ['set', 0, 1]);
    await step(BOB, async (q) => {
      await fails(q.one(answerSql, [id, [false, true], null]), /already decided/);
    });

    // Cancelled: still listed for a day so Bob knows; only the host can cancel.
    await step(BOB, async (q) => {
      await fails(q.one('select public.cancel_evening($1)', [id]), /no such evening/);
    });
    await step(ALICE, (q) => q.one('select public.cancel_evening($1)', [id]));
    assert.equal((await list(BOB))[0].status, 'cancelled');
    await db.query("update public.evenings set settled_at = now() - interval '2 days' where id = $1", [id]);
    assert.equal((await list(BOB)).length, 0);

    // Past evenings drop off the list; the export keeps them.
    const old = await create(ALICE, [at(1)], [BOB]);
    await db.query("update public.evenings set slots = array[now() - interval '7 hours'] where id = $1", [old]);
    assert.equal((await list(ALICE)).length, 0);
    const data = (await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(data.evenings_you_hosted.length, 2);
    const bobData = (await step(BOB, (q) => q.one('select public.export_my_data() as d'))).d;
    assert.equal(bobData.evening_answers.find((a) => Number(a.evening) === Number(id)).activity, 1);

    // Ten an hour at most; deleting the account removes them.
    for (let i = 0; i < 8; i++) await create(ALICE, [at(3 + i)], [BOB]);
    await step(ALICE, async (q) => {
      await fails(q.one(createSql, [[at(20)], acts, '', [BOB]]), /too many/);
    });
    await step(ALICE, (q) => q.one('select public.delete_my_account()'));
    assert.equal((await db.query('select count(*)::int as n from public.evenings')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.evening_guests')).rows[0].n, 0);
  });
});

// ---------------------------------------------------------------- preferences on all your devices

test('synced preferences: yours only, size-limited, exported and deleted with the account', async () => {
  await withPeople(async ({ step }) => {
    const get = (who) => step(who, async (q) => (await q.one('select public.my_preferences() as p')).p);
    const save = (who, data) => step(who, (q) => q.one('select public.save_my_preferences($1::jsonb) as at', [data]));
    assert.equal(await get(ALICE), null);
    const data = { shortcuts: [{ label: 'Quick game', minutes: 20 }], mood: { minutes: 30 } };
    assert.ok((await save(ALICE, JSON.stringify(data))).at);
    assert.deepEqual((await get(ALICE)).data, data);
    assert.equal(await get(BOB), null, 'Bob sees nothing of Alice’s');
    await step(BOB, async (q) => {
      await fails(q.rows('select * from public.synced_preferences'), /permission denied/);
    });
    // Saving again replaces them.
    await save(ALICE, JSON.stringify({ mood: { minutes: 60 } }));
    assert.deepEqual((await get(ALICE)).data, { mood: { minutes: 60 } });
    // Not an object, or too big: refused.
    await step(ALICE, async (q) => {
      await fails(q.one('select public.save_my_preferences($1::jsonb)', ['[1,2]']), /nothing to save/);
    });
    await step(ALICE, async (q) => {
      await fails(q.one('select public.save_my_preferences($1::jsonb)', [JSON.stringify({ big: 'x'.repeat(70000) })]), /too big/);
    });
    await step(null, async (q) => {
      await fails(q.one('select public.my_preferences()'), /permission denied/);
    });
    assert.deepEqual((await step(ALICE, (q) => q.one('select public.export_my_data() as d'))).d.synced_preferences.data, { mood: { minutes: 60 } });
    await step(ALICE, (q) => q.one('select public.forget_my_preferences()'));
    assert.equal(await get(ALICE), null);
    await save(ALICE, '{}');
    await step(ALICE, (q) => q.one('select public.delete_my_account()'));
    assert.equal((await db.query('select count(*)::int as n from public.synced_preferences')).rows[0].n, 0);
  });
});
