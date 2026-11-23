import { h, mount, richText } from '../ui.js';

// Read-only codebook, shown next to the item while coding and in review.
// Returns { el, show(variableKey) } so the page can switch the variable shown.
export function codebookPanel(codebook, versionLabel) {
  const vars = codebook.variables || [];
  let activeVar = vars[0]?.key;
  let view = 'definitions';
  const el = h('aside', { class: 'card codebook-panel' });

  function render() {
    const v = vars.find((x) => x.key === activeVar) || vars[0];
    if (!v) return mount(el, h('p', { class: 'muted' }, 'No codebook.'));
    const worked = v.worked_examples || [];
    const nameOf = (key) => v.categories.find((c) => c.key === key)?.name || key;
    mount(el,
      h('div', { class: 'row spread' },
        h('h2', {}, 'Codebook'),
        versionLabel && h('span', { class: 'muted' }, versionLabel)),
      vars.length > 1 && h('div', { class: 'pills' }, vars.map((x) =>
        h('button', {
          class: x.key === v.key ? 'pill active' : 'pill',
          onclick: () => { activeVar = x.key; render(); },
        }, x.name))),
      h('div', { class: 'pills sub' },
        h('button', { class: view === 'definitions' ? 'pill active' : 'pill', onclick: () => { view = 'definitions'; render(); } }, 'Definitions'),
        worked.length > 0 && h('button', { class: view === 'worked' ? 'pill active' : 'pill', onclick: () => { view = 'worked'; render(); } }, `Worked examples (${worked.length})`)),
      view === 'worked' && worked.length > 0
        ? h('div', { class: 'defs' }, worked.map((w) =>
            h('div', { class: 'def' },
              h('p', { class: 'quote' }, w.text),
              h('p', {}, h('strong', {}, nameOf(w.code)), w.reason ? `: ${w.reason}` : ''))))
        : h('div', { class: 'defs' },
            v.categories.map((c) =>
              h('div', { class: 'def' },
                h('strong', {}, c.name),
                c.definition && h('p', {}, c.definition),
                (c.examples || []).length > 0 && h('ul', { class: 'examples' }, c.examples.map((e) => h('li', {}, e))))),
            v.instructions && h('div', { class: 'instructions' }, h('strong', {}, 'Instructions'), richText(v.instructions))));
  }

  render();
  return {
    el,
    show(variableKey) {
      if (variableKey && variableKey !== activeVar && vars.some((x) => x.key === variableKey)) {
        activeVar = variableKey;
        view = 'definitions';
        render();
      }
    },
  };
}
