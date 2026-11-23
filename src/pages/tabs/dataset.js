import Papa from 'papaparse';
import { supabase, unwrap } from '../../supabase.js';
import { h, mount, toast, withBusy, field } from '../../ui.js';
import { guessColumns, prepareItems, describeGroups } from '../../lib/dataset.js';

const CHUNK = 500;

// Per group: how many items there are and how many are still unused.
async function itemCounts(sessionId) {
  const rows = unwrap(await supabase.rpc('session_item_counts', { p_session_id: sessionId })) || [];
  const total = rows.reduce((a, r) => a + Number(r.total), 0);
  const grouped = rows.some((r) => r.group_label);
  return { rows, total, grouped };
}

export async function datasetTab({ el, session }) {
  const summary = h('div', {});
  const uploadArea = h('div', {});
  const preview = h('div', {});
  mount(el,
    h('div', { class: 'card' }, h('h2', {}, 'Dataset'), summary),
    h('div', { class: 'card' },
      h('h2', {}, 'Upload a CSV'),
      h('p', { class: 'muted' }, 'One row per item, with a column of unique ids and a column of text. You choose which columns to use after picking the file. Uploading again adds new items and skips ids that are already here.'),
      h('p', { class: 'muted' }, 'Optional: a group column (for example platform). With groups, every round draws the batch size from each group, and reliability is reported overall and per group.'),
      uploadArea),
    preview);

  async function refresh() {
    const { rows: groups, total, grouped } = await itemCounts(session.id);
    const sample = unwrap(await supabase.from('items').select('ext_id, text, group_label')
      .eq('session_id', session.id).order('position').limit(10));
    const removeBtn = h('button', {
      class: 'danger',
      onclick: () => {
        if (!window.confirm('Remove all items that have not been used in a round yet?')) return;
        withBusy(removeBtn, async () => {
          unwrap(await supabase.from('items').delete().eq('session_id', session.id));
          toast('Unused items removed');
          await refresh();
        });
      },
    }, 'Remove unused items');
    mount(summary,
      h('p', { class: 'big' }, total === 0 ? 'No items yet.' : `${total.toLocaleString()} items`),
      total > 0 && grouped && h('p', {}, `Groups: ${describeGroups(groups, 'total')}`),
      total > 0 && h('p', { class: 'muted' }, grouped
        ? `Each round draws ${session.batch_size} items from every group (${session.batch_size * groups.length} per round), enough for ${Math.ceil(Math.max(...groups.map((g) => Number(g.total))) / session.batch_size)} rounds.`
        : `At ${session.batch_size} items per round, that is enough for ${Math.ceil(total / session.batch_size)} rounds.`),
      total > 0 && removeBtn);
    mount(preview, total > 0 && h('div', { class: 'card' },
      h('h2', {}, 'First items'),
      itemsTable(sample.map((r) => [r.ext_id, r.text, r.group_label]), grouped)));
  }

  function showPicker() {
    const file = h('input', {
      type: 'file', accept: '.csv,text/csv',
      onchange: () => file.files[0] && readFile(file.files[0]),
    });
    mount(uploadArea, file);
  }

  function readFile(f) {
    Papa.parse(f, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (result) => {
        const fields = (result.meta.fields || []).filter((x) => x !== '');
        if (fields.length < 2 || result.data.length === 0) {
          toast('This file needs a header row, at least two columns, and at least one row.', 'error');
          return showPicker();
        }
        showMapping(f.name, fields, result.data);
      },
      error: (err) => {
        toast(`Could not read the file: ${err.message}`, 'error');
        showPicker();
      },
    });
  }

  function showMapping(filename, fields, rows) {
    const guess = guessColumns(fields);
    const select = (chosen) =>
      h('select', {}, fields.map((f) => h('option', { value: f, selected: f === chosen }, f)));
    const idSel = select(guess.idCol);
    const textSel = select(guess.textCol);
    const groupSel = h('select', {},
      h('option', { value: '' }, 'None'),
      fields.map((f) => h('option', { value: f, selected: f === guess.groupCol }, f)));
    const report = h('div', {});
    const uploadBtn = h('button', {}, 'Upload');
    let prepared = { items: [], skipped: {} };

    function update() {
      const g = groupSel.value || null;
      if (idSel.value === textSel.value || g === idSel.value || g === textSel.value) {
        prepared = { items: [], skipped: {} };
        uploadBtn.disabled = true;
        return mount(report, h('p', { class: 'warn' }, 'Choose a different column for each.'));
      }
      prepared = prepareItems(rows, idSel.value, textSel.value, g);
      const { items, skipped, noGroup } = prepared;
      const groupCounts = new Map();
      if (g) for (const it of items) groupCounts.set(it.group_label || '(no group)', (groupCounts.get(it.group_label || '(no group)') || 0) + 1);
      const notes = [
        skipped.missingId && `${skipped.missingId} rows with no id`,
        skipped.missingText && `${skipped.missingText} rows with no text`,
        skipped.duplicateId && `${skipped.duplicateId} rows repeating an earlier id`,
      ].filter(Boolean);
      uploadBtn.disabled = items.length === 0;
      uploadBtn.textContent = `Upload ${items.length.toLocaleString()} items`;
      mount(report,
        notes.length > 0 && h('p', { class: 'warn' }, `Will skip: ${notes.join(', ')}.`),
        g && h('p', {}, `Groups: ${[...groupCounts].map(([name, n]) => `${name} ${n.toLocaleString()}`).join(', ')}`),
        g && groupCounts.size > 20 && h('p', { class: 'warn' }, `That is ${groupCounts.size} different groups. A group column should have a handful of values, such as platforms.`),
        g && noGroup > 0 && h('p', { class: 'warn' }, `${noGroup} rows have an empty group. They will form their own group.`),
        itemsTable(items.slice(0, 5).map((i) => [i.ext_id, i.text, i.group_label]), !!g));
    }
    idSel.addEventListener('change', update);
    textSel.addEventListener('change', update);
    groupSel.addEventListener('change', update);

    uploadBtn.addEventListener('click', () =>
      withBusy(uploadBtn, async () => {
        const before = (await itemCounts(session.id)).total;
        const all = prepared.items.map((it, i) => ({ ...it, session_id: session.id, position: before + i + 1 }));
        for (let i = 0; i < all.length; i += CHUNK) {
          uploadBtn.textContent = `Uploading… ${Math.min(i + CHUNK, all.length)} of ${all.length}`;
          unwrap(await supabase.from('items')
            .upsert(all.slice(i, i + CHUNK), { onConflict: 'session_id,ext_id', ignoreDuplicates: true }));
        }
        const added = (await itemCounts(session.id)).total - before;
        const already = all.length - added;
        toast(`Added ${added} items${already > 0 ? `, skipped ${already} already in the dataset` : ''}`);
        showPicker();
        await refresh();
      }));

    mount(uploadArea,
      h('p', {}, h('strong', {}, filename), `: ${rows.length.toLocaleString()} rows`),
      h('div', { class: 'grid two' }, field('ID column', idSel), field('Text column', textSel), field('Group column (optional)', groupSel)),
      report,
      h('div', { class: 'row' }, uploadBtn, h('button', { class: 'secondary', onclick: showPicker }, 'Cancel')));
    update();
  }

  showPicker();
  await refresh();
}

function itemsTable(rows, withGroup = false) {
  return h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), withGroup && h('th', {}, 'Group'), h('th', {}, 'Text'))),
    h('tbody', {}, rows.map(([id, text, group]) => h('tr', {},
      h('td', { class: 'nowrap' }, id),
      withGroup && h('td', { class: 'nowrap' }, group || ''),
      h('td', {}, text.length > 400 ? `${text.slice(0, 400)}…` : text)))));
}
