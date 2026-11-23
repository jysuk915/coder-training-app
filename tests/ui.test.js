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
        return (resolve, reject) => {
          calls.push(q);
          let result;
          if (failNext && q.ops.some(([name]) => name === 'upsert')) {
            result = { data: null, error: { message: failNext } };
            failNext = null;
          } else {
            const rows = tables[table] || [];
            const single = q.ops.some(([name]) => name === 'single' || name === 'maybeSingle');
            result = { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
          }
          return Promise.resolve(result).then(resolve, reject);
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
const { reviewPage } = await import('../src/pages/review.js');
const { krippendorffAlphaNominal } = await import('../src/lib/alpha.js');

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
    rpcs.session_item_counts = [{ group_label: '', total: 2, unused: 2 }];
    const el = document.createElement('div');
    document.body.append(el);
    await datasetTab({ el, session });
    expect(el.textContent).toContain('2 items');
    expect(el.textContent).toContain('enough for 1 rounds');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.querySelector('input[type=file]')).not.toBeNull();
  });
  it('shows groups and the per-group draw when the dataset has them', async () => {
    tables.items = [{ ext_id: 'FB 51', text: 'Hello', group_label: 'FB' }];
    rpcs.session_item_counts = [{ group_label: 'BS', total: 1950, unused: 1950 }, { group_label: 'FB', total: 1950, unused: 1950 }, { group_label: 'YT', total: 1950, unused: 1950 }];
    const el = document.createElement('div');
    document.body.append(el);
    await datasetTab({ el, session: { ...session, batch_size: 50 } });
    expect(el.textContent).toContain('5,850 items');
    expect(el.textContent).toContain('Groups: BS 1,950, FB 1,950, YT 1,950');
    expect(el.textContent).toContain('Each round draws 50 items from every group (150 per round), enough for 39 rounds.');
    expect([...el.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual(['ID', 'Group', 'Text']);
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
  });
  const threeItems = () => { rpcs.session_item_counts = [{ group_label: '', total: 3, unused: 3 }]; };

  it('offers to start the first round when setup is complete', async () => {
    tables = { ...base(), rounds: [] };
    threeItems();
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
    threeItems();
    const el = newEl();
    await roundsTab({ el, session, rerender: () => {} });
    expect(button(el, 'Start round 1').disabled).toBe(true);
    expect(el.textContent).toContain('"Tone" needs at least two categories.');
  });

  it('with groups, says how many items come from each group', async () => {
    tables = { ...base(), rounds: [] };
    rpcs.session_item_counts = [{ group_label: 'BS', total: 1950, unused: 30 }, { group_label: 'FB', total: 1950, unused: 1950 }, { group_label: 'YT', total: 1950, unused: 1950 }];
    const el = newEl();
    await roundsTab({ el, session: { ...session, batch_size: 50 }, rerender: () => {} });
    expect(el.textContent).toContain('This round will draw 130 at random: BS 30, FB 50, YT 50.');
    expect(el.textContent).toContain('Some groups have fewer than 50 unused items left');
    const asked = [];
    window.confirm = (m) => { asked.push(m); return false; };
    button(el, 'Start round 1').click();
    expect(asked[0]).toContain('with 130 items');
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

describe('closing a round', () => {
  it('warns about coders who have not submitted, closes, and goes to the review', async () => {
    tables = {
      coders: [{ id: 'coderA', label: 'A', joined_at: '2026-11-22T09:00:00Z' }, { id: 'coderB', label: 'B', joined_at: '2026-11-22T09:05:00Z' }],
      coder_secrets: [{ coder_id: 'coderA', rejoin_code: 'A-2222', name: 'Jiyoun' }, { coder_id: 'coderB', rejoin_code: 'B-7KQ2', name: 'Yini' }],
      codebook_versions: [{ id: 'cb1', version: 1, locked: true, content: sample }],
      rounds: [openRound], round_items: [{}, {}],
    };
    rpcs.session_item_counts = [{ group_label: '', total: 2, unused: 0 }];
    rpcs.round_progress = [
      { coder_id: 'coderA', label: 'A', codes_done: 6, codes_total: 6, submitted_at: '2026-11-22T12:00:00Z' },
      { coder_id: 'coderB', label: 'B', codes_done: 4, codes_total: 6, submitted_at: null },
    ];
    const el = newEl();
    await roundsTab({ el, session, rerender: () => {} });
    const asked = [];
    window.confirm = (m) => { asked.push(m); return true; };
    button(el, 'Close round 1').click();
    await settle();
    expect(asked[0]).toContain('Not submitted yet: B (Yini)');
    expect(rpcCalls.at(-1)).toEqual(['close_round', { p_round_id: 'r1' }]);
    expect(window.location.hash).toBe('#/r/r1');
    el.remove();
  });
});

describe('review', () => {
  const relevance = { variables: [{ key: 'relevance', name: 'Relevance', instructions: '', worked_examples: [],
    categories: [{ key: '0', name: '0 = Not about DEI', definition: 'Not about DEI.' }, { key: '1', name: '1 = About DEI', definition: 'About DEI.' }] }] };
  const votes = { i1: ['1', '1', '1'], i2: ['1', '1', '0'], i3: ['0', '1?', '1'], i4: ['0', '0', '0'] };
  const coderIds = ['coderA', 'coderB', 'coderC'];
  function reviewFixture(extra = {}) {
    const codes = [];
    for (const [item, row] of Object.entries(votes)) {
      row.forEach((cell, i) => codes.push({ item_id: item, coder_id: coderIds[i], variable_key: 'relevance', category_key: cell[0], unsure: cell.endsWith('?') }));
    }
    tables = {
      rounds: [{ ...openRound, status: 'closed', closed_at: '2026-11-23T15:00:00Z' }],
      sessions: [session],
      codebook_versions: [{ version: 2, content: relevance }],
      round_items: Object.keys(votes).map((id, i) => ({ position: i + 1, items: { id, ext_id: `FB ${51 + i}`, text: `Post ${id}` } })),
      coders: coderIds.map((id, i) => ({ id, label: 'ABC'[i], joined_at: `2026-11-22T09:0${i}:00Z` })),
      codes, consensus: [], comments: [], codebook_flags: [], reliability: [],
      ...extra,
    };
    rpcs.my_coder_slots = [];
  }
  const trainer = { id: 'u1', email: 't@example.edu' };
  const expectedAlpha = krippendorffAlphaNominal([['1', '1', '1'], ['1', '1', '0'], ['0', '1', '1'], ['0', '0', '0']]).alpha;

  it('trainer: summary, stored reliability, sorted cards, consensus, flag, comment', async () => {
    reviewFixture();
    const app = newEl();
    await reviewPage({ app, user: trainer, params: ['r1'] });
    expect(app.querySelector('h1').textContent).toBe('Round 1 review');
    expect(app.textContent).toContain('0 of 1 variable at or above the target');
    const shown = expectedAlpha.toFixed(2).replace(/^0\./, '.');
    expect(app.querySelector('table.summary tbody tr').textContent).toContain(shown);
    expect(app.querySelector('table.summary tbody tr').textContent).toContain('2 of 4'); // items all agreed
    // reliability stored for the history view
    const [saved] = opsOf('reliability', 'upsert');
    expect(saved[1]).toHaveLength(1);
    expect(saved[1][0]).toMatchObject({ round_id: 'r1', variable_key: 'relevance', n_items: 4, n_coders: 3, passed: false });
    expect(saved[1][0].alpha).toBeCloseTo(expectedAlpha, 12);
    expect(saved[1][0].pct_agreement).toBeCloseTo(8 / 12, 12);
    expect([...app.querySelectorAll('.tabs a')].map((a) => a.textContent)).toEqual(['Summary', 'By variable', 'By item', 'By coder', 'Codebook issues']);

    // variable view: unsure card first, then by odd one out
    button(app, 'Review').click();
    const cards = [...app.querySelectorAll('.dcard')];
    expect(cards.map((c) => c.querySelector('.muted').textContent)).toEqual(['ID FB 53', 'ID FB 52']);
    expect(cards[0].textContent).toContain('unsure');
    expect(cards[0].textContent).toContain('Majority split (2 to 1)');
    expect(cards[0].querySelector('.disputed').textContent).toContain('Not about DEI.');
    expect(app.querySelector('button.cell').textContent).toBe('2'); // 0 vs 1 mixed up on two items
    expect([...app.querySelectorAll('td.diag')].map((d) => d.textContent)).toEqual(['1', '1']);

    // set consensus on the first card
    button(cards[0], '1 = About DEI').click();
    await settle();
    const [cons] = opsOf('consensus', 'upsert');
    expect(cons[1]).toMatchObject({ round_id: 'r1', item_id: 'i3', variable_key: 'relevance', category_key: '1', status: 'resolved' });

    // flag as a codebook issue
    window.prompt = () => 'Title-only posts';
    button(app.querySelector('.dcard'), 'Flag as codebook issue').click();
    await settle();
    expect(opsOf('codebook_flags', 'insert')[0][1]).toEqual({ round_id: 'r1', item_id: 'i3', variable_key: 'relevance', author_coder_id: null, note: 'Title-only posts' });

    // comment as trainer
    const box = app.querySelector('.dcard textarea');
    box.value = 'B was unsure here'; box.dispatchEvent(new Event('input'));
    button(app.querySelector('.dcard'), 'Post').click();
    await settle();
    expect(opsOf('comments', 'insert')[0][1]).toEqual({ round_id: 'r1', item_id: 'i3', variable_key: 'relevance', author_coder_id: null, body: 'B was unsure here' });
    app.remove();
  });

  it('shows resolved consensus, flags, and comments; the by-coder tab counts deviation', async () => {
    reviewFixture({
      consensus: [{ round_id: 'r1', item_id: 'i3', variable_key: 'relevance', category_key: '1', status: 'resolved' }],
      comments: [{ id: 'm1', round_id: 'r1', item_id: 'i3', variable_key: 'relevance', author_coder_id: 'coderB', body: 'Read it as a passing mention', created_at: '2026-11-23T16:00:00Z' }],
      codebook_flags: [{ id: 'f1', round_id: 'r1', item_id: 'i2', variable_key: 'relevance', author_coder_id: null, note: 'Promo posts' }],
      reliability: [{ variable_key: 'relevance' }],
    });
    const app = newEl();
    await reviewPage({ app, user: trainer, params: ['r1'] });
    expect(opsOf('reliability', 'upsert')).toHaveLength(0); // already stored
    const tab = (name) => [...app.querySelectorAll('.tabs a')].find((a) => a.textContent.startsWith(name)).click();
    expect([...app.querySelectorAll('.tabs a')].at(-1).textContent).toBe('Codebook issues (1)');

    tab('By variable');
    const first = app.querySelector('.dcard');
    expect(first.className).toContain('resolved');
    expect(first.textContent).toContain('Coder B Read it as a passing mention');
    expect(app.textContent).toContain('Resolved (1)');
    expect(app.textContent).toContain('Codebook issue (1)');

    tab('By coder');
    const rows = Object.fromEntries([...app.querySelectorAll('tbody tr')].map((r) => [r.cells[0].textContent, [...r.cells].map((c) => c.textContent)]));
    // comparable items: i1, i4 (unanimous) and i3 (resolved to 1). A coded 0 on i3.
    expect(rows.A[2]).toBe('1 of 3 (33%)');
    expect(rows.B[2]).toBe('0 of 3 (0%)');
    expect(rows.A[3]).toBe('1'); // odd one out on i3
    expect(rows.C[3]).toBe('1'); // odd one out on i2
    expect(rows.B[4]).toBe('1'); // unsure once

    tab('By item');
    expect(app.querySelectorAll('.card table')).toHaveLength(2); // two items with a disagreement
    tab('Codebook issues');
    expect(app.textContent).toContain('Trainer: Promo posts');
    expect(app.textContent).toContain('ID FB 52');
    app.remove();
  });

  it('coder: no by-coder tab, cannot set consensus, comments as their own letter', async () => {
    reviewFixture({ consensus: [{ round_id: 'r1', item_id: 'i3', variable_key: 'relevance', category_key: '1', status: 'resolved' }] });
    rpcs.my_coder_slots = [{ session_id: SID, title: 'Pilot', coder_id: 'coderB', label: 'B', rejoin_code: 'B-7KQ2' }];
    const app = newEl();
    await reviewPage({ app, user: anon, params: ['r1'] });
    expect(opsOf('reliability', 'upsert')).toHaveLength(0);
    expect([...app.querySelectorAll('.tabs a')].map((a) => a.textContent)).toEqual(['Summary', 'By variable', 'By item', 'Codebook issues']);
    button(app, 'Review').click();
    const card = app.querySelector('.dcard');
    expect(card.querySelector('.consensus')).toBeNull();
    expect(card.textContent).toContain('Consensus: 1 = About DEI');
    expect(card.querySelector('.votes').textContent).toContain('B (you)');
    const box = card.querySelector('textarea');
    box.value = 'I agree'; box.dispatchEvent(new Event('input'));
    button(card, 'Post').click();
    await settle();
    expect(opsOf('comments', 'insert')[0][1]).toMatchObject({ author_coder_id: 'coderB', body: 'I agree' });
    app.remove();
  });

  it('with groups: alpha overall and per group, stored for both, cards filter by group', async () => {
    reviewFixture();
    tables.round_items.forEach((ri, i) => { ri.items.group_label = i < 2 ? 'FB' : 'YT'; }); // FB: i1, i2; YT: i3, i4
    const app = newEl();
    await reviewPage({ app, user: trainer, params: ['r1'] });
    const [saved] = opsOf('reliability', 'upsert');
    expect(saved[1].map((r) => [r.group_label, r.n_items])).toEqual([['', 4], ['FB', 2], ['YT', 2]]);
    expect(saved[2]).toEqual({ onConflict: 'round_id,variable_key,group_label' });
    const fb = krippendorffAlphaNominal([['1', '1', '1'], ['1', '1', '0']]).alpha;
    const yt = krippendorffAlphaNominal([['0', '1', '1'], ['0', '0', '0']]).alpha;
    expect(saved[1][1].alpha).toBeCloseTo(fb, 12);
    expect(saved[1][2].alpha).toBeCloseTo(yt, 12);
    const fmt = (a) => a.toFixed(2).replace(/^(-?)0\./, '$1.');
    const byGroup = [...app.querySelectorAll('table.summary')][1];
    expect([...byGroup.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual(['Variable', 'All items', 'FB', 'YT']);
    expect([...byGroup.querySelectorAll('tbody td')].map((t) => t.textContent)).toEqual(['Relevance', fmt(expectedAlpha), fmt(fb), fmt(yt)]);

    button(app, 'Review').click();
    expect(app.querySelectorAll('.dcard')).toHaveLength(2);
    button(app, 'YT').click();
    const cards = [...app.querySelectorAll('.dcard')];
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('ID FB 53');
    app.remove();
  });

  it('an open round has no review yet', async () => {
    reviewFixture({ rounds: [openRound] });
    const app = newEl();
    await reviewPage({ app, user: trainer, params: ['r1'] });
    expect(app.textContent).toContain('still open');
  });
});
