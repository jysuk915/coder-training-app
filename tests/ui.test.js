// @vitest-environment jsdom
// Smoke test: draw the trainer screens against a pretend database and make
// sure the main actions send what we expect.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const calls = [];
let tables = {};

// A stand-in for the Supabase client: records every call, answers from `tables`.
function query(table) {
  const q = { table, ops: [] };
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve) => {
          calls.push(q);
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

vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t) => query(t), rpc: vi.fn() },
  unwrap: ({ data, error }) => { if (error) throw new Error(error.message); return data; },
  isTrainerUser: (u) => !!u && !u.is_anonymous,
}));

const { codebookTab } = await import('../src/pages/tabs/codebook.js');
const { datasetTab } = await import('../src/pages/tabs/dataset.js');
const { settingsTab } = await import('../src/pages/tabs/settings.js');
const { sessionPage } = await import('../src/pages/session.js');

const session = { id: '11111111-1111-1111-1111-111111111111', trainer_id: 'u1', title: 'Pilot', join_code: 'ABC234', batch_size: 20, alpha_target: 0.8 };
const sample = JSON.parse(readFileSync('sample/sample_codebook.json', 'utf8')).codebook;
const tick = () => new Promise((r) => setTimeout(r, 0));
const opsOf = (table, op) => calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter(([n]) => n === op));

beforeEach(() => {
  calls.length = 0;
  tables = {};
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
