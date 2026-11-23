import Papa from 'papaparse';
import { supabase, unwrap } from '../../supabase.js';
import { h, mount, toast, withBusy, field } from '../../ui.js';
import { guessColumns, prepareItems } from '../../lib/dataset.js';

const CHUNK = 500;

async function countItems(sessionId) {
  const { count, error } = await supabase
    .from('items').select('id', { count: 'exact', head: true }).eq('session_id', sessionId);
  if (error) throw new Error(error.message);
  return count ?? 0;
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
      uploadArea),
    preview);

  async function refresh() {
    const total = await countItems(session.id);
    const sample = unwrap(await supabase.from('items').select('ext_id, text')
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
      total > 0 && h('p', { class: 'muted' }, `At ${session.batch_size} items per round, that is enough for ${Math.ceil(total / session.batch_size)} rounds.`),
      total > 0 && removeBtn);
    mount(preview, total > 0 && h('div', { class: 'card' },
      h('h2', {}, 'First items'),
      itemsTable(sample.map((r) => [r.ext_id, r.text]))));
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
    const report = h('div', {});
    const uploadBtn = h('button', {}, 'Upload');
    let prepared = { items: [], skipped: {} };

    function update() {
      if (idSel.value === textSel.value) {
        prepared = { items: [], skipped: {} };
        uploadBtn.disabled = true;
        return mount(report, h('p', { class: 'warn' }, 'Choose two different columns.'));
      }
      prepared = prepareItems(rows, idSel.value, textSel.value);
      const { items, skipped } = prepared;
      const notes = [
        skipped.missingId && `${skipped.missingId} rows with no id`,
        skipped.missingText && `${skipped.missingText} rows with no text`,
        skipped.duplicateId && `${skipped.duplicateId} rows repeating an earlier id`,
      ].filter(Boolean);
      uploadBtn.disabled = items.length === 0;
      uploadBtn.textContent = `Upload ${items.length.toLocaleString()} items`;
      mount(report,
        notes.length > 0 && h('p', { class: 'warn' }, `Will skip: ${notes.join(', ')}.`),
        itemsTable(items.slice(0, 5).map((i) => [i.ext_id, i.text])));
    }
    idSel.addEventListener('change', update);
    textSel.addEventListener('change', update);

    uploadBtn.addEventListener('click', () =>
      withBusy(uploadBtn, async () => {
        const before = await countItems(session.id);
        const all = prepared.items.map((it, i) => ({ ...it, session_id: session.id, position: before + i + 1 }));
        for (let i = 0; i < all.length; i += CHUNK) {
          uploadBtn.textContent = `Uploading… ${Math.min(i + CHUNK, all.length)} of ${all.length}`;
          unwrap(await supabase.from('items')
            .upsert(all.slice(i, i + CHUNK), { onConflict: 'session_id,ext_id', ignoreDuplicates: true }));
        }
        const added = (await countItems(session.id)) - before;
        const already = all.length - added;
        toast(`Added ${added} items${already > 0 ? `, skipped ${already} already in the dataset` : ''}`);
        showPicker();
        await refresh();
      }));

    mount(uploadArea,
      h('p', {}, h('strong', {}, filename), `: ${rows.length.toLocaleString()} rows`),
      h('div', { class: 'grid two' }, field('ID column', idSel), field('Text column', textSel)),
      report,
      h('div', { class: 'row' }, uploadBtn, h('button', { class: 'secondary', onclick: showPicker }, 'Cancel')));
    update();
  }

  showPicker();
  await refresh();
}

function itemsTable(rows) {
  return h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Text'))),
    h('tbody', {}, rows.map(([id, text]) => h('tr', {}, h('td', { class: 'nowrap' }, id), h('td', {}, text)))));
}
