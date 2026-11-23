import { supabase, unwrap } from '../supabase.js';
import { h, mount, toast, withBusy } from '../ui.js';
import { loadCoderContext, loadRound, codeKey } from '../lib/coderData.js';
import { codebookPanel } from './codebookPanel.js';

// The blind coding view: one item at a time, codebook alongside,
// every answer saved the moment it is chosen.
export async function codingPage({ app, user, params }) {
  const [sessionId] = params;
  const ctx = user ? await loadCoderContext(sessionId) : null;
  if (!ctx || !ctx.openRound) {
    window.location.hash = `#/c/${sessionId}`;
    return;
  }
  const { slot, openRound: round } = ctx;
  const data = await loadRound(round, slot.coder_id);
  const { items, codes } = data;
  const variables = data.codebook.variables;
  const locked = !!data.submittedAt;
  if (items.length === 0) {
    mount(app, h('div', { class: 'card' }, h('p', {}, 'This round has no items.')));
    return;
  }

  const isComplete = (it) => variables.every((v) => codes.has(codeKey(it.id, v.key)));
  const isStarted = (it) => variables.some((v) => codes.has(codeKey(it.id, v.key)));
  const firstIncomplete = items.findIndex((it) => !isComplete(it));
  let index = firstIncomplete === -1 ? 0 : firstIncomplete;
  let activeVar = variables[0].key;

  // ---- saving: one request at a time, in order, with a visible status ----
  const saveStatus = h('span', { class: 'save-status' }, locked ? 'Submitted' : 'All answers saved');
  const failed = new Map(); // key -> { item, variable } still to be written
  let queue = Promise.resolve();
  let pending = 0;

  function setStatus() {
    if (locked) return;
    if (pending > 0) {
      saveStatus.textContent = 'Saving…';
      saveStatus.className = 'save-status';
    } else if (failed.size > 0) {
      saveStatus.className = 'save-status bad';
      mount(saveStatus, `${failed.size} answer${failed.size > 1 ? 's' : ''} not saved. `,
        h('button', { class: 'link', onclick: retryFailed }, 'Try again'));
    } else {
      saveStatus.textContent = 'All answers saved';
      saveStatus.className = 'save-status good';
    }
  }

  function write(item, variable) {
    const key = codeKey(item.id, variable.key);
    pending++;
    setStatus();
    queue = queue.then(async () => {
      const value = codes.get(key); // the latest answer at the time this runs
      const base = { round_id: round.id, item_id: item.id, coder_id: slot.coder_id, variable_key: variable.key };
      const { error } = value
        ? await supabase.from('codes').upsert({ ...base, category_key: value.category_key, unsure: value.unsure },
            { onConflict: 'round_id,item_id,coder_id,variable_key' })
        : await supabase.from('codes').delete().match(base);
      if (error) {
        console.error(error);
        failed.set(key, { item, variable });
      } else {
        failed.delete(key);
      }
    }).catch((err) => {
      console.error(err);
      failed.set(key, { item, variable });
    }).finally(() => {
      pending--;
      setStatus();
    });
    return queue;
  }

  function retryFailed() {
    for (const { item, variable } of [...failed.values()]) write(item, variable);
  }

  // ---- page skeleton ----
  const panel = codebookPanel(data.codebook, `Version ${data.codebookVersion}`);
  const itemArea = h('div', {});
  const strip = h('div', { class: 'strip', role: 'navigation', 'aria-label': 'Items in this round' });
  const progressText = h('span', { class: 'muted' });
  const submitBtn = h('button', { onclick: submit }, 'Submit round');

  mount(app,
    h('div', { class: 'session-head' },
      h('div', {},
        h('a', { class: 'muted', href: `#/c/${sessionId}` }, `← ${slot.title}`),
        h('h1', {}, `Round ${round.round_no}, Coder ${slot.label}`)),
      h('div', { class: 'row' }, saveStatus, !locked && submitBtn)),
    locked && h('p', { class: 'note' }, 'You submitted this round, so your answers can no longer change. If you need to fix something, ask your trainer to reopen it for you.'),
    h('div', { class: 'row spread' }, progressText),
    strip,
    h('div', { class: 'coding' }, itemArea, panel.el));

  function renderStrip() {
    const done = items.filter(isComplete).length;
    progressText.textContent = `${done} of ${items.length} items coded`;
    mount(strip, items.map((it, i) =>
      h('button', {
        class: ['dot', isComplete(it) ? 'done' : isStarted(it) ? 'partial' : '', i === index ? 'current' : ''].join(' '),
        title: isComplete(it) ? 'Coded' : isStarted(it) ? 'Partly coded' : 'Not coded yet',
        'aria-current': i === index ? 'true' : null,
        onclick: () => go(i),
      }, i + 1)));
  }

  function go(i) {
    index = Math.max(0, Math.min(items.length - 1, i));
    const it = items[index];
    activeVar = (variables.find((v) => !codes.has(codeKey(it.id, v.key))) || variables[0]).key;
    panel.show(activeVar);
    renderItem();
    renderStrip();
    window.scrollTo({ top: 0 });
  }

  function choose(item, variable, categoryKey) {
    if (locked) return;
    const key = codeKey(item.id, variable.key);
    const prev = codes.get(key);
    codes.set(key, { category_key: categoryKey, unsure: prev?.unsure || false });
    write(item, variable);
    // move on to the next variable on this item that still needs a code
    const next = variables.find((x) => !codes.has(codeKey(item.id, x.key)));
    if (next) {
      activeVar = next.key;
      panel.show(next.key);
    }
    renderItem();
    renderStrip();
  }

  function renderItem() {
    const item = items[index];
    mount(itemArea,
      h('div', { class: 'card item-card' },
        h('div', { class: 'row spread' },
          h('span', { class: 'muted' }, `Item ${index + 1} of ${items.length}`),
          h('span', { class: 'muted' }, `ID ${item.ext_id}`)),
        h('div', { class: 'item-text' }, item.text)),
      variables.map((v) => {
        const key = codeKey(item.id, v.key);
        const value = codes.get(key);
        const groupName = `var-${v.key}`;
        return h('fieldset', {
          class: v.key === activeVar ? 'card answer active' : 'card answer',
          onfocusin: () => { activeVar = v.key; panel.show(v.key); },
          onclick: () => { activeVar = v.key; panel.show(v.key); },
        },
          h('legend', {}, v.name),
          v.categories.map((c, ci) =>
            h('label', { class: value?.category_key === c.key ? 'option chosen' : 'option' },
              h('input', {
                type: 'radio', name: groupName, value: c.key,
                checked: value?.category_key === c.key, disabled: locked,
                onchange: () => choose(item, v, c.key),
              }),
              h('span', { class: 'keyhint' }, ci < 9 ? ci + 1 : ''),
              h('span', {}, c.name))),
          h('div', { class: 'row spread answer-foot' },
            h('label', { class: 'unsure' },
              h('input', {
                type: 'checkbox', checked: !!value?.unsure, disabled: locked || !value,
                onchange: (e) => {
                  codes.set(key, { ...codes.get(key), unsure: e.target.checked });
                  write(item, v);
                },
              }),
              ' Unsure about this one'),
            value && !locked && h('button', {
              class: 'link',
              onclick: () => { codes.delete(key); write(item, v); renderItem(); renderStrip(); },
            }, 'Clear')));
      }),
      h('div', { class: 'row spread' },
        h('button', { class: 'secondary', disabled: index === 0, onclick: () => go(index - 1) }, '← Previous'),
        index < items.length - 1
          ? h('button', { onclick: () => go(index + 1) }, 'Next →')
          : h('span', { class: 'muted' }, locked ? 'Last item' : 'Last item. Submit the round when you are ready.')),
      !locked && h('p', { class: 'muted' }, 'Keyboard: number keys choose a category, left and right arrows move between items.'));
  }

  function submit() {
    withBusy(submitBtn, async () => {
      await queue;
      if (failed.size > 0) throw new Error('Some answers are not saved yet. Click "Try again" first.');
      const missing = items.filter((it) => !isComplete(it)).length;
      const message = missing > 0
        ? `${missing} item${missing > 1 ? 's are' : ' is'} not fully coded.\n\nSubmit anyway? You will not be able to change your answers afterwards.`
        : 'Submit this round? You will not be able to change your answers afterwards.';
      if (!window.confirm(message)) return;
      unwrap(await supabase.rpc('submit_round', { p_round_id: round.id }));
      toast('Round submitted');
      window.location.hash = `#/c/${sessionId}`;
    });
  }

  // ---- keyboard ----
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'radio' && e.target.type !== 'checkbox')) return;
    if (/^[1-9]$/.test(e.key) && !locked) {
      const v = variables.find((x) => x.key === activeVar) || variables[0];
      const c = v.categories[Number(e.key) - 1];
      if (!c) return;
      e.preventDefault();
      choose(items[index], v, c.key);
    } else if (tag !== 'INPUT' && e.key === 'ArrowRight') {
      go(index + 1);
    } else if (tag !== 'INPUT' && e.key === 'ArrowLeft') {
      go(index - 1);
    }
  }
  document.addEventListener('keydown', onKey);
  const leaveWarning = (e) => { if (pending > 0 || failed.size > 0) e.preventDefault(); };
  window.addEventListener('beforeunload', leaveWarning);
  window.addEventListener('hashchange', () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', leaveWarning);
  }, { once: true });

  go(index);
  setStatus();
}
