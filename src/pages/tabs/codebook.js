import Papa from 'papaparse';
import { supabase, unwrap } from '../../supabase.js';
import { h, mount, toast, withBusy, downloadFile } from '../../ui.js';
import {
  assignKeys, normalizeCodebook, validateCodebook, codebookFromCsvRows, codebookToCsvRows, codebookFromJson, CODEBOOK_CSV_COLUMNS,
} from '../../lib/codebook.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const blank = () => ({ variables: [] });

export async function codebookTab({ el, session }) {
  let versions = [];
  let current = null; // the version row being shown (null = unsaved first draft)
  let draft = blank(); // editable copy of its content
  let dirty = false;

  async function load(selectId) {
    versions = unwrap(await supabase.from('codebook_versions').select('*')
      .eq('session_id', session.id).order('version', { ascending: false }));
    current = versions.find((v) => v.id === selectId) || versions[0] || null;
    draft = current ? clone(current.content) : blank();
    dirty = false;
    render();
  }

  const editable = () => !current || !current.locked;
  const saveState = h('span', { class: 'muted' });
  let autosaveTimer;
  // Every edit is saved automatically a moment after typing stops.
  const markDirty = () => {
    dirty = true;
    saveState.textContent = 'Unsaved changes';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (!el.isConnected) return;
      writeDraft().catch((err) => { saveState.textContent = `Not saved: ${err.message}`; });
    }, 1200);
  };

  // Write the draft to the database without redrawing the page.
  async function writeDraft() {
    clearTimeout(autosaveTimer);
    assignKeys(draft);
    const snapshot = JSON.stringify(draft);
    const content = normalizeCodebook(draft);
    if (current) {
      const rows = unwrap(await supabase.from('codebook_versions')
        .update({ content }).eq('id', current.id).select());
      if (rows.length === 0) throw new Error('This version is locked because a round has used it. Create a new version to make changes.');
    } else {
      current = unwrap(await supabase.from('codebook_versions')
        .insert({ session_id: session.id, version: 1, content }).select().single());
      versions = [current];
    }
    if (JSON.stringify(draft) === snapshot) {
      dirty = false;
      saveState.textContent = 'All changes saved';
    }
  }

  async function save(btn) {
    await withBusy(btn, async () => {
      await writeDraft();
      await load(current.id);
      toast('Codebook saved');
    });
  }

  async function newVersionFrom(source, btn) {
    await withBusy(btn, async () => {
      const next = Math.max(...versions.map((v) => v.version)) + 1;
      const row = unwrap(await supabase.from('codebook_versions')
        .insert({ session_id: session.id, version: next, content: source.content }).select().single());
      await load(row.id);
      toast(`Version ${next} created as a draft`);
    });
  }

  function importFile(file) {
    const apply = (cb) => {
      if (draft.variables.length > 0 && !window.confirm('Replace the current draft with the imported codebook?')) return;
      draft = cb;
      markDirty();
      render();
      toast('Imported. Review it, then click Save.');
    };
    const fail = (err) => toast(err.message, 'error');
    if (/\.json$/i.test(file.name)) {
      file.text().then((t) => apply(codebookFromJson(t))).catch(fail);
    } else {
      Papa.parse(file, {
        header: true, skipEmptyLines: 'greedy',
        complete: (r) => { try { apply(codebookFromCsvRows(r.data)); } catch (e) { fail(e); } },
        error: fail,
      });
    }
  }

  function render() {
    const problems = validateCodebook(normalizeCodebook(draft));
    const canEdit = editable();
    const latest = versions[0];

    const versionPicker = versions.length > 0 && h('select', {
      onchange: (e) => {
        if (dirty && !window.confirm('Discard unsaved changes?')) return render();
        load(e.target.value);
      },
    }, versions.map((v) => h('option', { value: v.id, selected: current && v.id === current.id },
      `Version ${v.version}${v.locked ? ' (used in a round, locked)' : ' (draft)'}`)));

    const saveBtn = h('button', { onclick: () => save(saveBtn) }, 'Save');
    const fileInput = h('input', {
      type: 'file', accept: '.csv,.json', class: 'hidden',
      onchange: () => { if (fileInput.files[0]) importFile(fileInput.files[0]); fileInput.value = ''; },
    });
    const newBtn = h('button', { onclick: () => newVersionFrom(current, newBtn) },
      `Create version ${latest ? latest.version + 1 : ''} from this one`);
    const hasDraft = latest && !latest.locked;
    const name = `codebook_v${current ? current.version : 1}`;

    if (!dirty) saveState.textContent = '';

    mount(el,
      h('div', { class: 'card' },
        h('div', { class: 'row spread' },
          h('h2', {}, 'Codebook'),
          h('div', { class: 'row' }, versionPicker)),
        !current && h('p', { class: 'muted' }, 'Build the codebook here, or import one from a CSV or JSON file. Try sample/sample_codebook.json from the project folder.'),
        current && current.locked && h('p', { class: 'note' },
          'This version was used in a round, so it can no longer change. ',
          hasDraft ? 'Switch to the draft version to keep editing.' : 'To revise the codebook, create the next version.'),
        h('div', { class: 'row' },
          canEdit && saveBtn,
          canEdit && h('button', { class: 'secondary', onclick: () => fileInput.click() }, 'Import CSV or JSON'),
          fileInput,
          current && current.locked && !hasDraft && newBtn,
          h('button', { class: 'secondary', onclick: () =>
            downloadFile(`${name}.json`, JSON.stringify({ codebook: normalizeCodebook(draft) }, null, 2), 'application/json') }, 'Export JSON'),
          h('button', { class: 'secondary', onclick: () =>
            downloadFile(`${name}.csv`, Papa.unparse(codebookToCsvRows(normalizeCodebook(draft)), { columns: CODEBOOK_CSV_COLUMNS }), 'text/csv') }, 'Export CSV'),
          saveState),
        canEdit && problems.length > 0 && draft.variables.length > 0 && h('div', { class: 'warn' },
          h('strong', {}, 'Fix before starting a round:'),
          h('ul', {}, problems.map((p) => h('li', {}, p))))),
      draft.variables.map((v, vi) => variableCard(v, vi, canEdit)),
      canEdit && h('button', {
        class: 'secondary',
        onclick: () => {
          draft.variables.push({ name: '', instructions: '', categories: [blankCat(), blankCat()], worked_examples: [] });
          markDirty();
          render();
        },
      }, '+ Add variable'));
  }

  const blankCat = () => ({ name: '', definition: '', examples: [] });

  function variableCard(v, vi, canEdit) {
    const bind = (obj, key, el, transform = (x) => x) => {
      el.addEventListener('input', () => { obj[key] = transform(el.value); markDirty(); });
      if (!canEdit) el.disabled = true;
      return el;
    };
    return h('div', { class: 'card variable' },
      h('div', { class: 'row spread' },
        h('span', { class: 'muted' }, `Variable ${vi + 1}`),
        canEdit && h('button', {
          class: 'link danger-text',
          onclick: () => {
            if (!window.confirm(`Remove the variable "${v.name || 'untitled'}" and its categories?`)) return;
            draft.variables.splice(vi, 1);
            markDirty();
            render();
          },
        }, 'Remove variable')),
      bind(v, 'name', h('input', { type: 'text', class: 'var-name', placeholder: 'Variable name, e.g., Stance', value: v.name || '', 'aria-label': 'Variable name' })),
      h('div', { class: 'part-label' }, 'Instructions (optional)'),
      bind(v, 'instructions', h('textarea', {
        rows: 4, 'aria-label': 'Instructions',
        placeholder: 'Anything that applies to the whole variable: what to look at, decision rules, tie-breakers.\nStart a line with "- " to make a bullet.',
      }, v.instructions ?? v.description ?? '')),
      h('div', { class: 'part-label' }, 'Categories'),
      h('div', { class: 'cats' }, (v.categories || []).map((c, ci) =>
        h('div', { class: 'cat' },
          h('div', { class: 'row spread' },
            bind(c, 'name', h('input', { type: 'text', placeholder: `Category ${ci + 1} name`, value: c.name || '', 'aria-label': 'Category name' })),
            canEdit && h('button', {
              class: 'link danger-text',
              onclick: () => {
                const [removed] = v.categories.splice(ci, 1);
                for (const w of v.worked_examples || []) if (removed.key && w.code === removed.key) w.code = '';
                markDirty();
                render();
              },
            }, 'Remove')),
          bind(c, 'definition', h('textarea', { rows: 2, placeholder: 'Definition: when to choose this category', 'aria-label': 'Definition' }, c.definition || '')),
          bind(c, 'examples', h('textarea', { rows: 2, placeholder: 'Examples, one per line', 'aria-label': 'Examples' }, (c.examples || []).join('\n')),
            (text) => text.split('\n').map((s) => s.trim()).filter(Boolean))))),
      canEdit && h('button', {
        class: 'secondary small',
        onclick: () => { v.categories.push(blankCat()); markDirty(); render(); },
      }, '+ Add category'),
      h('div', { class: 'part-label' }, 'Worked examples (optional)'),
      (v.worked_examples || []).length === 0 && !canEdit && h('p', { class: 'muted' }, 'None.'),
      h('div', { class: 'cats' }, (v.worked_examples || []).map((w, wi) => {
        const named = v.categories.filter((c) => (c.name || '').trim());
        const codeSel = h('select', {
          'aria-label': 'Correct code',
          onchange: () => {
            assignKeys(draft);
            w.code = named[Number(codeSel.value)]?.key || '';
            markDirty();
          },
        },
          h('option', { value: '' }, 'Correct code…'),
          named.map((c, i) => h('option', { value: i, selected: !!c.key && c.key === w.code }, c.name)));
        if (!canEdit) codeSel.disabled = true;
        return h('div', { class: 'cat' },
          bind(w, 'text', h('textarea', { rows: 2, placeholder: 'Example item text', 'aria-label': 'Example text' }, w.text || '')),
          h('div', { class: 'row spread' },
            codeSel,
            canEdit && h('button', {
              class: 'link danger-text',
              onclick: () => { v.worked_examples.splice(wi, 1); markDirty(); render(); },
            }, 'Remove')),
          bind(w, 'reason', h('textarea', { rows: 2, placeholder: 'Reason: why this code is correct', 'aria-label': 'Reason' }, w.reason || '')));
      })),
      canEdit && h('button', {
        class: 'secondary small',
        onclick: () => {
          (v.worked_examples ||= []).push({ text: '', code: '', reason: '' });
          markDirty();
          render();
        },
      }, '+ Add worked example'));
  }

  await load();
}
