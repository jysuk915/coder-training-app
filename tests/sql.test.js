// Runs supabase/setup.sql in an in-memory Postgres (PGlite) with a small
// stand-in for Supabase's auth schema, then checks that the security rules
// behave as promised: blind coding, rejoin, no reading ahead, and so on.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const setupSql = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');

const AUTH_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
`;

let db;
const users = {};

async function admin(sql, params) {
  await db.exec('reset role');
  return (await db.query(sql, params)).rows;
}

// Run a query as a signed-in user, the way the Supabase API would.
async function as(name, sql, params) {
  const u = users[name];
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: u.id, is_anonymous: u.anon }),
  ]);
  await db.exec('set role authenticated');
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

const codebook = {
  variables: [
    {
      key: 'stance', name: 'Stance',
      categories: [{ key: 'support', name: 'Support' }, { key: 'oppose', name: 'Oppose' }],
    },
  ],
};

let session, round, cbId, slots = {};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(setupSql);
  await db.exec(setupSql); // running it twice must be safe
  for (const [name, anon] of [['trainer', false], ['a', true], ['b', true], ['newdevice', true], ['outsider', true], ['other', false]]) {
    const [row] = await admin('insert into auth.users default values returning id');
    users[name] = { id: row.id, anon };
  }
});

describe('sessions', () => {
  it('anonymous users cannot create a session', async () => {
    await expect(as('a', `select * from create_session('x')`)).rejects.toThrow(/Sign in/);
  });

  it('a trainer creates a session and gets a join code', async () => {
    [session] = await as('trainer', `select * from create_session('Pilot', 3, 0.8)`);
    expect(session.join_code).toMatch(/^[2-9A-Z]{6}$/);
  });

  it('nobody can insert a session directly', async () => {
    await expect(
      as('trainer', `insert into sessions (trainer_id, title, join_code) values ($1, 'x', 'ABCDEF')`, [users.trainer.id])
    ).rejects.toThrow(/permission denied/);
  });

  it('the trainer cannot change the join code, but can change settings', async () => {
    await expect(as('trainer', `update sessions set join_code = 'AAAAAA'`)).rejects.toThrow(/permission denied/);
    await as('trainer', `update sessions set batch_size = 2 where id = $1`, [session.id]);
    const [s] = await as('trainer', `select batch_size from sessions where id = $1`, [session.id]);
    expect(s.batch_size).toBe(2);
  });

  it('other trainers and outsiders see nothing', async () => {
    expect(await as('other', 'select * from sessions')).toHaveLength(0);
    expect(await as('outsider', 'select * from sessions')).toHaveLength(0);
  });
});

describe('setup: items and codebook', () => {
  it('the trainer uploads items; another trainer cannot', async () => {
    for (let i = 1; i <= 5; i++) {
      await as('trainer', `insert into items (session_id, ext_id, text, position) values ($1, $2, $3, $4)`,
        [session.id, `p${i}`, `text ${i}`, i]);
    }
    await expect(
      as('other', `insert into items (session_id, ext_id, text) values ($1, 'zz', 'nope')`, [session.id])
    ).rejects.toThrow(/row-level security/);
    expect(await as('other', 'select * from items')).toHaveLength(0);
  });

  it('the trainer saves a draft codebook version', async () => {
    const [cb] = await as('trainer',
      `insert into codebook_versions (session_id, version, content) values ($1, 1, $2) returning id`,
      [session.id, JSON.stringify(codebook)]);
    cbId = cb.id;
  });
});

describe('joining', () => {
  it('coders get labels in order and a rejoin code', async () => {
    for (const name of ['a', 'b']) {
      const [r] = await as(name, `select join_session($1, $2) as j`, [session.join_code.toLowerCase(), `Real ${name}`]);
      slots[name] = r.j;
    }
    expect(slots.a.label).toBe('A');
    expect(slots.b.label).toBe('B');
    expect(slots.b.rejoin_code).toMatch(/^B-[2-9A-Z]{4}$/);
  });

  it('joining again from the same browser returns the same slot', async () => {
    const [r] = await as('a', `select join_session($1) as j`, [session.join_code]);
    expect(r.j.coder_id).toBe(slots.a.coder_id);
    expect(r.j.rejoin_code).toBe(slots.a.rejoin_code);
  });

  it('a new coder must give a name', async () => {
    const [r] = await as('outsider', `select join_session($1, '  ') as j`, [session.join_code]);
    expect(r.j.ok).toBe(false);
    expect(r.j.error).toMatch(/name/);
    expect(await admin('select 1 from coders where session_id = $1', [session.id])).toHaveLength(2);
  });

  it('a wrong session code is refused', async () => {
    const [r] = await as('outsider', `select join_session('NOPE22') as j`);
    expect(r.j.ok).toBe(false);
  });

  it('a coder sees labels but not other coders\' rejoin codes or names', async () => {
    expect(await as('a', 'select id, label from coders')).toHaveLength(2);
    const secrets = await as('a', 'select * from coder_secrets');
    expect(secrets).toHaveLength(1);
    expect(secrets[0].coder_id).toBe(slots.a.coder_id);
    await expect(as('a', 'select user_id from coders')).rejects.toThrow(/permission denied/);
  });

  it('the trainer sees every rejoin code and name', async () => {
    const rows = await as('trainer', 'select * from coder_secrets order by rejoin_code');
    expect(rows.map((r) => r.name)).toEqual(['Real a', 'Real b']);
  });

  it('coders cannot read items or a draft codebook before a round starts', async () => {
    expect(await as('a', 'select * from items')).toHaveLength(0);
    expect(await as('a', 'select * from codebook_versions')).toHaveLength(0);
  });
});

describe('a round', () => {
  it('only the trainer can start one', async () => {
    await expect(as('a', `select * from start_round($1, $2)`, [session.id, cbId])).rejects.toThrow(/Only the trainer/);
    [round] = await as('trainer', `select * from start_round($1, $2)`, [session.id, cbId]);
    expect(round.round_no).toBe(1);
    await expect(as('trainer', `select * from start_round($1, $2)`, [session.id, cbId])).rejects.toThrow(/Close the current round/);
  });

  it('coders see only the batch (2 of 5 items) and the now-locked codebook', async () => {
    expect(await as('a', 'select * from items')).toHaveLength(2);
    expect(await as('a', 'select * from codebook_versions')).toHaveLength(1);
  });

  it('the locked codebook can no longer be edited', async () => {
    const rows = await as('trainer', `update codebook_versions set notes = 'x' where id = $1 returning id`, [cbId]);
    expect(rows).toHaveLength(0);
  });

  it('coders save, revise, and are blind to each other; so is the trainer', async () => {
    const batch = await as('a', 'select item_id from round_items order by position');
    const save = (who, item, cat) => as(who,
      `insert into codes (round_id, item_id, coder_id, variable_key, category_key) values ($1, $2, $3, 'stance', $4)
       on conflict (round_id, item_id, coder_id, variable_key) do update set category_key = excluded.category_key, unsure = excluded.unsure`,
      [round.id, item, slots[who].coder_id, cat]);
    await save('a', batch[0].item_id, 'support');
    await save('a', batch[0].item_id, 'oppose'); // revise
    await save('a', batch[1].item_id, 'support');
    await save('b', batch[0].item_id, 'support');

    expect(await as('a', 'select * from codes')).toHaveLength(2);
    expect(await as('b', 'select * from codes')).toHaveLength(1);
    expect(await as('trainer', 'select * from codes')).toHaveLength(0);

    // cannot write into someone else's slot
    await expect(as('b',
      `insert into codes (round_id, item_id, coder_id, variable_key, category_key) values ($1, $2, $3, 'stance', 'support')`,
      [round.id, batch[1].item_id, slots.a.coder_id])).rejects.toThrow(/row-level security/);
    // cannot use a category that is not in the codebook
    await expect(save('b', batch[1].item_id, 'banana')).rejects.toThrow(/not in the codebook/);
    // cannot code an item outside the batch
    const [outside] = await admin(
      `select id from items where session_id = $1 and id not in (select item_id from round_items)`, [session.id]);
    await expect(save('b', outside.id, 'support')).rejects.toThrow(/not part of the round/);
    // no comments while the round is open
    await expect(as('a',
      `insert into comments (round_id, item_id, variable_key, author_coder_id, body) values ($1, $2, 'stance', $3, 'hi')`,
      [round.id, batch[0].item_id, slots.a.coder_id])).rejects.toThrow(/row-level security/);
  });

  it('the trainer sees progress counts only', async () => {
    const rows = await as('trainer', 'select * from round_progress($1)', [round.id]);
    expect(rows.map((r) => [r.label, Number(r.codes_done), Number(r.codes_total)])).toEqual([['A', 2, 2], ['B', 1, 2]]);
    await expect(as('a', 'select * from round_progress($1)', [round.id])).rejects.toThrow(/Only the trainer/);
  });

  it('submitting locks a coder\'s answers; the trainer can reopen', async () => {
    await as('a', 'select submit_round($1)', [round.id]);
    const changed = await as('a', `update codes set category_key = 'support' returning *`);
    expect(changed).toHaveLength(0);
    await as('trainer', 'select reopen_submission($1, $2)', [round.id, slots.a.coder_id]);
    expect(await as('a', `update codes set unsure = true returning *`)).toHaveLength(2);
    await as('a', 'select submit_round($1)', [round.id]);
  });
});

describe('rejoining on a new device', () => {
  it('a wrong rejoin code fails', async () => {
    const [r] = await as('newdevice', `select rejoin_session($1, 'B-0000') as j`, [session.join_code]);
    expect(r.j.ok).toBe(false);
  });

  it('the right code moves the slot and its saved work', async () => {
    // The new device first joined as a fresh coder by mistake (slot C, no work).
    const [c] = await as('newdevice', `select join_session($1, 'Oops') as j`, [session.join_code]);
    expect(c.j.label).toBe('C');
    const [r] = await as('newdevice', `select rejoin_session($1, $2) as j`, [session.join_code, slots.b.rejoin_code.toLowerCase()]);
    expect(r.j.ok).toBe(true);
    expect(r.j.label).toBe('B');
    expect(await as('newdevice', 'select * from codes')).toHaveLength(1);
    expect(await as('b', 'select * from codes')).toHaveLength(0); // old browser is out
    expect(await as('trainer', 'select label from coders order by label')).toEqual([{ label: 'A' }, { label: 'B' }]);
    const mine = await as('newdevice', 'select * from my_coder_slots()');
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe('B');
  });

  it('guessing is throttled after 10 wrong codes', async () => {
    for (let i = 0; i < 10; i++) {
      await as('outsider', `select rejoin_session($1, 'A-ZZZZ') as j`, [session.join_code]);
    }
    const [r] = await as('outsider', `select rejoin_session($1, $2) as j`, [session.join_code, slots.a.rejoin_code]);
    expect(r.j.ok).toBe(false);
    expect(r.j.error).toMatch(/Too many/);
    await admin('delete from rejoin_attempts');
  });
});

describe('closing the round', () => {
  it('only the trainer can close; then everyone in the session sees all codes', async () => {
    await expect(as('a', 'select * from close_round($1)', [round.id])).rejects.toThrow(/Only the trainer/);
    await as('trainer', 'select * from close_round($1)', [round.id]);
    expect(await as('trainer', 'select * from codes')).toHaveLength(3);
    expect(await as('a', 'select * from codes')).toHaveLength(3);
    expect(await as('outsider', 'select * from codes')).toHaveLength(0);
  });

  it('codes are frozen after close', async () => {
    expect(await as('newdevice', `update codes set category_key = 'oppose' returning *`)).toHaveLength(0);
  });

  it('review: trainer saves reliability and consensus; coders comment and flag as themselves', async () => {
    const [item] = await as('a', 'select item_id from round_items order by position limit 1');
    await as('trainer',
      `insert into reliability (round_id, variable_key, n_items, n_coders, pct_agreement, alpha, passed) values ($1, 'stance', 2, 2, 0.5, 0.1, false)`,
      [round.id]);
    await as('trainer',
      `insert into consensus (round_id, item_id, variable_key, category_key, status) values ($1, $2, 'stance', 'support', 'resolved')`,
      [round.id, item.item_id]);
    await expect(as('a',
      `insert into consensus (round_id, item_id, variable_key, category_key) values ($1, $2, 'stance', 'oppose')`,
      [round.id, item.item_id])).rejects.toThrow();
    await as('a',
      `insert into comments (round_id, item_id, variable_key, author_coder_id, body) values ($1, $2, 'stance', $3, 'I read it as sarcasm')`,
      [round.id, item.item_id, slots.a.coder_id]);
    // a coder cannot post as the trainer or as another coder
    await expect(as('a',
      `insert into comments (round_id, item_id, variable_key, author_coder_id, body) values ($1, $2, 'stance', null, 'fake')`,
      [round.id, item.item_id])).rejects.toThrow(/row-level security/);
    await expect(as('a',
      `insert into comments (round_id, item_id, variable_key, author_coder_id, body) values ($1, $2, 'stance', $3, 'fake')`,
      [round.id, item.item_id, slots.b.coder_id])).rejects.toThrow(/row-level security/);
    await as('trainer',
      `insert into codebook_flags (round_id, item_id, variable_key, note) values ($1, $2, 'stance', 'sarcasm rule')`,
      [round.id, item.item_id]);
    expect(await as('newdevice', 'select * from comments')).toHaveLength(1);
    expect(await as('newdevice', 'select * from codebook_flags')).toHaveLength(1);
    expect(await as('newdevice', 'select * from reliability')).toHaveLength(1);
  });
});

describe('next round', () => {
  it('draws only unused items and needs a valid codebook', async () => {
    const [cb2] = await as('trainer',
      `insert into codebook_versions (session_id, version, content) values ($1, 2, $2) returning id`,
      [session.id, JSON.stringify({ variables: [{ key: 'v', name: 'V', categories: [{ key: 'only', name: 'Only' }] }] })]);
    await expect(as('trainer', 'select * from start_round($1, $2)', [session.id, cb2.id])).rejects.toThrow(/at least two categories/);
    const [r2] = await as('trainer', 'select * from start_round($1, $2)', [session.id, cbId]);
    expect(r2.round_no).toBe(2);
    const overlap = await admin(
      `select 1 from round_items x join round_items y on x.item_id = y.item_id and x.round_id <> y.round_id`);
    expect(overlap).toHaveLength(0);
    await as('trainer', 'select * from close_round($1)', [r2.id]);
    const [r3] = await as('trainer', 'select * from start_round($1, $2)', [session.id, cbId]);
    const n = await admin('select count(*)::int as n from round_items where round_id = $1', [r3.id]);
    expect(n[0].n).toBe(1); // 5 items, batches of 2: the last round gets the 1 left
    await as('trainer', 'select * from close_round($1)', [r3.id]);
    await expect(as('trainer', 'select * from start_round($1, $2)', [session.id, cbId])).rejects.toThrow(/No unused items/);
  });
});

describe('visitors who are not signed in', () => {
  it('have no access to tables or functions', async () => {
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role anon');
    await expect(db.query('select * from sessions')).rejects.toThrow(/permission denied/);
    await expect(db.query(`select join_session('ABCDEF')`)).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });

  it('items used in a round cannot be deleted; unused ones can', async () => {
    const [s2] = await as('trainer', `select * from create_session('Second', 1, 0.8)`);
    await as('trainer', `insert into items (session_id, ext_id, text) values ($1, 'u1', 'one'), ($1, 'u2', 'two')`, [s2.id]);
    const [cb] = await as('trainer',
      `insert into codebook_versions (session_id, version, content) values ($1, 1, $2) returning id`,
      [s2.id, JSON.stringify(codebook)]);
    await as('trainer', 'select * from start_round($1, $2)', [s2.id, cb.id]);
    const gone = await as('trainer', 'delete from items where session_id = $1 returning id', [s2.id]);
    expect(gone).toHaveLength(1);
    await as('trainer', 'delete from sessions where id = $1', [s2.id]);
  });

  it('a trainer can join their own session as a coder and stays blind', async () => {
    const [s3] = await as('trainer', `select * from create_session('Third', 2, 0.8)`);
    await as('trainer', `insert into items (session_id, ext_id, text) values ($1, 't1', 'one'), ($1, 't2', 'two')`, [s3.id]);
    const [cb] = await as('trainer',
      `insert into codebook_versions (session_id, version, content) values ($1, 1, $2) returning id`,
      [s3.id, JSON.stringify(codebook)]);
    const [t] = await as('trainer', `select join_session($1, 'The PI') as j`, [s3.join_code]);
    const [o] = await as('other', `select join_session($1, 'Colleague') as j`, [s3.join_code]);
    expect([t.j.label, o.j.label]).toEqual(['A', 'B']);
    const [r] = await as('trainer', 'select * from start_round($1, $2)', [s3.id, cb.id]);
    const batch = await as('trainer', 'select item_id from round_items where round_id = $1', [r.id]);
    for (const [who, slot] of [['trainer', t.j], ['other', o.j]]) {
      await as(who,
        `insert into codes (round_id, item_id, coder_id, variable_key, category_key) values ($1, $2, $3, 'stance', 'support')`,
        [r.id, batch[0].item_id, slot.coder_id]);
    }
    expect(await as('trainer', 'select * from codes where round_id = $1', [r.id])).toHaveLength(1); // own code only
    await as('trainer', 'select * from close_round($1)', [r.id]);
    expect(await as('trainer', 'select * from codes where round_id = $1', [r.id])).toHaveLength(2);
    await as('trainer', 'delete from sessions where id = $1', [s3.id]);
  });

  it('a codebook with an unnamed category cannot start a round', async () => {
    const [s4] = await as('trainer', `select * from create_session('Fourth', 2, 0.8)`);
    await as('trainer', `insert into items (session_id, ext_id, text) values ($1, 'x1', 'one')`, [s4.id]);
    const [cb] = await as('trainer',
      `insert into codebook_versions (session_id, version, content) values ($1, 1, $2) returning id`,
      [s4.id, JSON.stringify({ variables: [{ key: 'v', name: 'V', categories: [{ key: 'a', name: 'A' }, { key: '', name: '' }] }] })]);
    await expect(as('trainer', 'select * from start_round($1, $2)', [s4.id, cb.id])).rejects.toThrow(/needs a name/);
    await as('trainer', 'delete from sessions where id = $1', [s4.id]);
  });

  it('deleting a session removes everything under it', async () => {
    await as('trainer', 'delete from sessions where id = $1', [session.id]);
    const [c] = await admin('select (select count(*) from codes)::int + (select count(*) from items)::int + (select count(*) from rounds)::int as n');
    expect(c.n).toBe(0);
  });
});
