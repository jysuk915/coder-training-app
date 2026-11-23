// @vitest-environment jsdom
// Smoke test: draw the trainer screens against a pretend database and make
// sure the main actions send what we expect.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const calls = [];
let tables = {};
let failNext = null;

// A stand-in for the Supabase client: records every call, answers from `tables`.
function query(table) {
  const q = { table, ops: [] };
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve) => {
          calls.push(q);
          if (failNext && q.ops.some(([name]) => name === 'upsert')) {
            const message = failNext; failNext = null;
            return resolve({ data: null, error: { message } });
          }
          const rows = tables[table] || [];
          const single = q.ops.some(([name]) => name === 'single' || name === 'maybeSingle');
          resolve({ data: single ? rows[0] ?? null : rows, error: null, count: rows.length });
        };
      }
      return (...args) => { q.ops.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}

let rpcs = {};
const rpcCalls = [];
vi.mock('../src/supabase.js', () => {
  const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    supabase: {
      from: (t) => query(t),
      rpc: (name, args) => { rpcCalls.push([name, args]); return Promise.resolve({ data: rpcs[name] ?? null, error: null }); },
    },
    unwrap,
    isTrainerUser: (u) => !!u && !u.is_anonymous,
    ensureSignedIn: async () => ({ id: 'anon', is_anonymous: true }),
    fetchAll: async (build) => unwrap(await build()),
  };
});

const { codebookTab } = await import('../src/pages/tabs/codebook.js');
const { datasetTab } = await import('../src/pages/tabs/dataset.js');
const { settingsTab } = await import('../src/pages/tabs/settings.js');
const { roundsTab } = await import('../src/pages/tabs/rounds.js');
const { sessionPage } = await import('../src/pages/session.js');
const { joinPage } = await import('../src/pages/join.js');
const { coderPage } = await import('../src/pages/coder.js');
const { codingPage } = await import('../src/pages/coding.js');

const session = { id: '11111111-1111-1111-1111-111111111111', trainer_id: 'u1', title: 'Pilot', join_code: 'ABC234', batch_size: 20, alpha_target: 0.8 };
const sample = JSON.parse(readFileSync('sample/sample_codebook.json', 'utf8')).codebook;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const button = (root, text) => [...root.querySelectorAll('button, a.button')].find((b) => b.textContent.includes(text));
const newEl = () => { const el = document.createElement('div'); document.body.append(el); return el; };
const anon = { id: 'anon', is_anonymous: true };
const SID = '11111111-1111-1111-1111-111111111111';
const openRound = { id: 'r1', session_id: SID, round_no: 1, status: 'open', codebook_version_id: 'cb1', opened_at: '2026-11-22T10:00:00Z' };
const slot = { session_id: SID, title: 'Pilot', coder_id: 'coderB', label: 'B', rejoin_code: 'B-7KQ2' };
function codingFixture(extra = {}) {
  rpcs.my_coder_slots = [slot];
  tables = {
    rounds: [openRound],
    codebook_versions: [{ id: 'cb1', version: 1, locked: true, content: sample }],
    round_items: [
      { position: 1, items: { id: 'i1', ext_id: 'P001', text: 'First post' } },
      { position: 2, items: { id: 'i2', ext_id: 'P002', text: 'Second post' } },
    ],
    codes: [],
    submissions: [],
    ...extra,
  };
}
const opsOf = (table, op) => calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter(([n]) => n === op));

beforeEach(async () => {
  // let any page from the previous test clean up its listeners first
  window.dispatchEvent(new Event('hashchange'));
  window.location.hash = '';
  await new Promise((r) => setTimeout(r, 5));
  calls.length = 0;
  rpcCalls.length = 0;
  tables = {};
  rpcs = {};
  window.scrollTo = () => {};
  document.body.innerHTML = '<div id="toast"></div>';
  window.confirm = () => true;
});

describe('codebook tab', () => {
  it('starts empty, lets the trainer build a variable, and saves version 1', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    await codebookTab({ el, session });
    expect(el.textContent).toContain('Build the codebook here');

    [...el.querySelectorAll('button')].find((b) => b.textContent === '+ Add variable').click();
    const name = el.querySelector('.var-name');
    name.value = 'Stance';
    name.dispatchEvent(new Event('input'));
    const cats = el.querySelectorAll('.cat input');
    expect(cats).toHaveLength(2);
    cats[0].value = 'Support'; cats[0].dispatchEvent(new Event('input'));
    cats[1].value = 'Oppose'; cats[1].dispatchEvent(new Event('input'));

    tables.codebook_versions = [{ id: 'cb1', version: 1, locked: false, content: { variables: [] } }];
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await tick(); await tick(); await tick();
    const [insert] = opsOf('codebook_versions', 'insert');
    expect(insert[1].version).toBe(1);
    expect(insert[1].content.variables[0]).toMatchObject({ key: 'stance', name: 'Stance' });
    expect(insert[1].content.variables[0].categories.map((c) => c.key)).toEqual(['support', 'oppose']);
  });

  it('shows a locked version read-only and offers the next version', async () => {
    tables.codebook_versions = [{ id: 'cb1', version: 1, locked: true, content: sample }];
    const el = document.createElement('div');
    document.body.append(el);
    await codebookTab({ el, session });
    expect(el.querySelectorAll('.variable')).toHaveLength(3);
    expect([...el.querySelectorAll('.variable input, .variable textarea')].every((i) => i.disabled)).toBe(true);
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Create version 2 from this one');
    expect(labels).not.toContain('Save');
    expect(labels).not.toContain('+ Add variable');
  });

  it('a draft version is editable and warns about problems', async () => {
    tables.codebook_versions = [{ id: 'cb2', version: 2, locked: false,
      content: { variables: [{ key: 'v', name: 'Tone', categories: [{ key: 'a', name: 'Only' }] }] } }];
    const el = document.createElement('div');
    document.body.append(el);
    await codebookTab({ el, session });
    expect(el.textContent).toContain('"Tone" needs at least two categories.');
    expect(el.querySelector('.var-name').disabled).toBe(false);
  });
});

describe('dataset tab', () => {
  it('shows the count, rounds estimate, and first items', async () => {
    tables.items = [{ ext_id: 'P001', text: 'Hello' }, { ext_id: 'P002', text: 'World' }];
    const el = document.createElement('div');
    document.body.append(el);
    await datasetTab({ el, session });
    expect(el.textContent).toContain('2 items');
    expect(el.textContent).toContain('enough for 1 rounds');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.querySelector('input[type=file]')).not.toBeNull();
  });
});

describe('settings tab', () => {
  it('saves batch size and target', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const rerender = vi.fn();
    await settingsTab({ el, session, rerender });
    const [title, batch, target] = el.querySelectorAll('form input');
    expect(target.value).toBe('0.80');
    batch.value = '15';
    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    const [update] = opsOf('sessions', 'update');
    expect(update[1]).toEqual({ title: 'Pilot', batch_size: 15, alpha_target: 0.8 });
    expect(rerender).toHaveBeenCalled();
  });
});

describe('session page', () => {
  it('shows the title, join code, and tabs to its trainer only', async () => {
    tables.sessions = [session];
    const app = document.createElement('div');
    document.body.append(app);
    await sessionPage({ app, user: { id: 'u1', email: 't@example.edu' }, params: [session.id, 'settings'], rerender: () => {} });
    expect(app.querySelector('h1').textContent).toBe('Pilot');
    expect(app.querySelector('.joincode strong').textContent).toBe('ABC234');
    expect(app.querySelector('.tabs a.active').textContent).toBe('Settings');

    await sessionPage({ app, user: { id: 'someone-else', email: 'x@example.edu' }, params: [session.id], rerender: () => {} });
    expect(app.textContent).toContain('Session not found');
  });
});

describe('codebook editor: instructions and worked examples', () => {
  it('saves instructions and a worked example pointing at a category', async () => {
    const el = newEl();
    await codebookTab({ el, session });
    button(el, '+ Add variable').click();
    const set = (node, value) => { node.value = value; node.dispatchEvent(new Event('input')); };
    set(el.querySelector('.var-name'), 'Relevance');
    set(el.querySelector('textarea[aria-label="Instructions"]'), 'Stance does not matter.\n- Hashtags alone are 0');
    const cats = el.querySelectorAll('input[aria-label="Category name"]');
    set(cats[0], 'Not relevant'); set(cats[1], 'Relevant');
    button(el, '+ Add worked example').click();
    set(el.querySelector('textarea[aria-label="Example text"]'), 'Happy Pride Month!');
    set(el.querySelector('textarea[aria-label="Reason"]'), 'Greeting alone.');
    const sel = el.querySelector('select[aria-label="Correct code"]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Correct code…', 'Not relevant', 'Relevant']);
    sel.value = '0'; sel.dispatchEvent(new Event('change'));

    tables.codebook_versions = [{ id: 'cb1', version: 1, locked: false, content: { variables: [] } }];
    button(el, 'Save').click();
    await settle();
    const [insert] = opsOf('codebook_versions', 'insert');
    const v = insert[1].content.variables[0];
    expect(v.instructions).toBe('Stance does not matter.\n- Hashtags alone are 0');
    expect(v.categories.map((c) => c.key)).toEqual(['not_relevant', 'relevant']);
    expect(v.worked_examples).toEqual([{ text: 'Happy Pride Month!', code: 'not_relevant', reason: 'Greeting alone.' }]);
  });
});

describe('joining', () => {
  it('a new coder joins with a name and is shown the rejoin code', async () => {
    rpcs.join_session = { ok: true, session_id: SID, title: 'Pilot', coder_id: 'coderB', label: 'B', rejoin_code: 'B-7KQ2' };
    const app = newEl();
    await joinPage({ app, params: ['ABC234'] });
    const [code, name] = app.querySelectorAll('form input');
    expect(code.value).toBe('ABC234');
    expect(name.required).toBe(true);
    name.value = 'Yini';
    app.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(rpcCalls).toEqual([['join_session', { p_join_code: 'ABC234', p_name: 'Yini' }]]);
    expect(app.querySelector('h1').textContent).toBe('You are Coder B');
    expect(app.querySelector('.rejoin-box strong').textContent).toBe('B-7KQ2');
    expect(button(app, 'Continue').getAttribute('href')).toBe(`#/c/${SID}`);
  });

  it('reconnecting sends the rejoin code and shows errors from the server', async () => {
    rpcs.rejoin_session = { ok: false, error: 'That rejoin code does not match this session.' };
    const app = newEl();
    await joinPage({ app, params: ['ABC234'] });
    button(app, 'Use your rejoin code').click();
    const [code, rejoin] = app.querySelectorAll('form input');
    rejoin.value = 'b-0000';
    app.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(rpcCalls[0]).toEqual(['rejoin_session', { p_join_code: 'ABC234', p_rejoin_code: 'b-0000' }]);
    expect(document.getElementById('toast').textContent).toContain('does not match');
    expect(app.querySelector('h1').textContent).toBe('Reconnect on this device');
  });
});

describe('coder home', () => {
  it('shows progress and a button to continue', async () => {
    codingFixture({ codes: [{ item_id: 'i1', variable_key: 'stance', category_key: 'support', unsure: false }] });
    const app = newEl();
    await coderPage({ app, user: anon, params: [SID] });
    expect(app.querySelector('h1').textContent).toBe('Coder B');
    expect(app.textContent).toContain('0 of 2 items coded'); // 3 variables, only 1 coded on item 1
    expect(button(app, 'Start coding').getAttribute('href')).toBe(`#/c/${SID}/code`);
  });

  it('tells a browser with no slot to join', async () => {
    rpcs.my_coder_slots = [];
    const app = newEl();
    await coderPage({ app, user: anon, params: [SID] });
    expect(app.textContent).toContain('not connected');
  });
});

describe('coding view', () => {
  it('shows one item with the codebook, saves each choice, and submits', async () => {
    codingFixture();
    const app = newEl();
    await codingPage({ app, user: anon, params: [SID] });
    expect(app.querySelector('.item-text').textContent).toBe('First post');
    expect(app.querySelectorAll('fieldset.answer')).toHaveLength(3);
    expect(app.querySelector('.codebook-panel').textContent).toContain('The post favors the proposal');
    expect(app.querySelector('.codebook-panel').textContent).toContain('Sarcasm counts as the position it implies');
    expect(app.querySelector('input[type=checkbox]').disabled).toBe(true); // unsure needs a code first

    // click "Oppose" for Stance
    const oppose = app.querySelector('input[name="var-stance"][value="oppose"]');
    oppose.checked = true; oppose.dispatchEvent(new Event('change'));
    await settle();
    let [upsert] = opsOf('codes', 'upsert');
    expect(upsert[1]).toEqual({ round_id: 'r1', item_id: 'i1', coder_id: 'coderB', variable_key: 'stance', category_key: 'oppose', unsure: false });
    expect(app.querySelector('.save-status').textContent).toBe('All answers saved');
    expect(app.querySelector('.dot.current').className).toContain('partial');

    // mark unsure
    const unsure = app.querySelector('fieldset.answer input[type=checkbox]');
    expect(unsure.disabled).toBe(false);
    unsure.checked = true; unsure.dispatchEvent(new Event('change'));
    await settle();
    expect(opsOf('codes', 'upsert')[1][1]).toMatchObject({ variable_key: 'stance', category_key: 'oppose', unsure: true });

    // keyboard: the next two variables by number key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await settle();
    const saved = opsOf('codes', 'upsert').map((u) => [u[1].variable_key, u[1].category_key]);
    expect(saved.slice(2)).toEqual([['primary_frame', 'safety'], ['incivility', 'absent']]);
    expect(app.querySelector('.dot.current').className).toContain('done');
    expect(app.textContent).toContain('1 of 2 items coded');

    // next item
    button(app, 'Next').click();
    expect(app.querySelector('.item-text').textContent).toBe('Second post');

    // submit with one item missing asks first
    const asked = [];
    window.confirm = (m) => { asked.push(m); return true; };
    button(app, 'Submit round').click();
    await settle();
    expect(asked[0]).toContain('1 item is not fully coded');
    expect(rpcCalls.at(-1)).toEqual(['submit_round', { p_round_id: 'r1' }]);
    expect(window.location.hash).toBe(`#/c/${SID}`);
  });

  it('is read-only after submitting', async () => {
    codingFixture({
      codes: [{ item_id: 'i1', variable_key: 'stance', category_key: 'support', unsure: true }],
      submissions: [{ submitted_at: '2026-11-22T12:00:00Z' }],
    });
    const app = newEl();
    await codingPage({ app, user: anon, params: [SID] });
    expect(app.textContent).toContain('You submitted this round');
    expect([...app.querySelectorAll('fieldset input')].every((i) => i.disabled)).toBe(true);
    expect(app.querySelector('input[name="var-stance"][value="support"]').checked).toBe(true);
    expect(button(app, 'Submit round')).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await settle();
    expect(opsOf('codes', 'upsert')).toHaveLength(0);
    window.dispatchEvent(new Event('hashchange'));
  });

  it('keeps an answer flagged when saving fails', async () => {
    codingFixture();
    const app = newEl();
    await codingPage({ app, user: anon, params: [SID] });
    failNext = 'network down';
    const support = app.querySelector('input[name="var-stance"][value="support"]');
    support.checked = true; support.dispatchEvent(new Event('change'));
    await settle();
    expect(app.querySelector('.save-status').textContent).toContain('1 answer not saved');
    button(app, 'Try again').click();
    await settle();
    expect(app.querySelector('.save-status').textContent).toBe('All answers saved');
    window.dispatchEvent(new Event('hashchange'));
  });
});

describe('rounds and coders tab', () => {
  const base = () => ({
    coders: [{ id: 'coderA', label: 'A', joined_at: '2026-11-22T09:00:00Z' }, { id: 'coderB', label: 'B', joined_at: '2026-11-22T09:05:00Z' }],
    coder_secrets: [{ coder_id: 'coderA', rejoin_code: 'A-2222', name: 'Jiyoun' }, { coder_id: 'coderB', rejoin_code: 'B-7KQ2', name: 'Yini' }],
    codebook_versions: [{ id: 'cb1', version: 1, locked: false, content: sample }],
    items: [{}, {}, {}],
  });

  it('offers to start the first round when setup is complete', async () => {
    tables = { ...base(), rounds: [] };
    const el = newEl();
    const rerender = vi.fn();
    await roundsTab({ el, session, rerender });
    expect(el.textContent).toContain('3 of 3 items are unused');
    expect(el.textContent).toContain('Yini');
    expect(el.textContent).toContain('B-7KQ2');
    const start = button(el, 'Start round 1');
    expect(start.disabled).toBe(false);
    start.click();
    await settle();
    expect(rpcCalls.at(-1)).toEqual(['start_round', { p_session_id: SID, p_codebook_version_id: 'cb1' }]);
    expect(rerender).toHaveBeenCalled();
  });

  it('blocks starting when the codebook has problems', async () => {
    tables = { ...base(), rounds: [], codebook_versions: [{ id: 'cb1', version: 1, locked: false,
      content: { variables: [{ key: 'v', name: 'Tone', categories: [{ key: 'a', name: 'Only' }] }] } }] };
    const el = newEl();
    await roundsTab({ el, session, rerender: () => {} });
    expect(button(el, 'Start round 1').disabled).toBe(true);
    expect(el.textContent).toContain('"Tone" needs at least two categories.');
  });

  it('shows who has finished and who has not, with names, while a round is open', async () => {
    tables = { ...base(), rounds: [openRound], round_items: [{}, {}] };
    rpcs.round_progress = [
      { coder_id: 'coderA', label: 'A', codes_done: 6, codes_total: 6, submitted_at: '2026-11-22T12:00:00Z' },
      { coder_id: 'coderB', label: 'B', codes_done: 4, codes_total: 6, submitted_at: null },
    ];
    const el = newEl();
    await roundsTab({ el, session, rerender: () => {} });
    const rows = [...el.querySelector('table').querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows[0]).toContain('Jiyoun');
    expect(rows[0]).toContain('2 of 2 items');
    expect(rows[0]).toContain('Submitted');
    expect(rows[1]).toContain('Yini');
    expect(rows[1]).toContain('1 of 2 items');
    expect(rows[1]).toContain('Coding');
    button(el, 'Reopen').click();
    await settle();
    expect(rpcCalls.some(([n, a]) => n === 'reopen_submission' && a.p_coder_id === 'coderA')).toBe(true);
    el.remove();
  });
});
