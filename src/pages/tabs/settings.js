import { supabase, unwrap } from '../../supabase.js';
import { h, mount, toast, withBusy, field } from '../../ui.js';

export async function settingsTab({ el, session, rerender }) {
  const title = h('input', { type: 'text', value: session.title, required: true });
  const batch = h('input', { type: 'number', min: 1, max: 1000, step: 1, value: session.batch_size, required: true });
  const target = h('input', { type: 'number', min: 0, max: 1, step: 0.01, value: Number(session.alpha_target).toFixed(2), required: true });
  const saveBtn = h('button', { type: 'submit' }, 'Save settings');

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(saveBtn, async () => {
        unwrap(await supabase.from('sessions').update({
          title: title.value.trim(),
          batch_size: parseInt(batch.value, 10),
          alpha_target: parseFloat(target.value),
        }).eq('id', session.id));
        toast('Settings saved');
        rerender();
      });
    },
  },
    field('Session title', title),
    field('Batch size per round', batch, 'How many items every coder codes in each round. Each round draws new items at random from the ones not yet used. If your dataset has groups (for example platforms), this is the number drawn from each group.'),
    field("Reliability target (Krippendorff's α)", target, 'A variable passes a round when its α is at or above this value. The usual standard is .80.'),
    saveBtn);

  const delBtn = h('button', {
    class: 'danger',
    onclick: () => {
      const typed = window.prompt(`This deletes the session with all its items, codes, and review notes. It cannot be undone.\n\nType the session title to confirm:\n${session.title}`);
      if (typed === null) return;
      if (typed.trim() !== session.title) return toast('Title did not match. Nothing was deleted.', 'error');
      withBusy(delBtn, async () => {
        unwrap(await supabase.from('sessions').delete().eq('id', session.id));
        toast('Session deleted');
        window.location.hash = '#/trainer';
      });
    },
  }, 'Delete this session');

  mount(el,
    h('div', { class: 'card narrow' }, h('h2', {}, 'Settings'), form),
    h('div', { class: 'card narrow' }, h('h2', {}, 'Delete session'),
      h('p', { class: 'muted' }, 'Export anything you need first.'), delBtn));
}
