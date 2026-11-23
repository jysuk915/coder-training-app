import { supabase, ensureSignedIn, unwrap } from '../supabase.js';
import { h, mount, toast, withBusy, field } from '../ui.js';

export async function joinPage({ app, params }) {
  let [prefill = ''] = params;
  let mode = 'new';

  function render() {
    const code = h('input', { type: 'text', value: prefill, placeholder: 'e.g., K7M2QX', required: true, autocapitalize: 'characters', autocomplete: 'off', class: 'code-input' });
    const name = h('input', { type: 'text', placeholder: 'Your name', required: true, autocomplete: 'name' });
    const rejoin = h('input', { type: 'text', placeholder: 'e.g., B-7KQ2', required: true, autocapitalize: 'characters', autocomplete: 'off', class: 'code-input' });
    const btn = h('button', { type: 'submit' }, mode === 'new' ? 'Join session' : 'Reconnect');

    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(btn, async () => {
          await ensureSignedIn();
          const result = unwrap(mode === 'new'
            ? await supabase.rpc('join_session', { p_join_code: code.value, p_name: name.value })
            : await supabase.rpc('rejoin_session', { p_join_code: code.value, p_rejoin_code: rejoin.value }));
          if (!result.ok) throw new Error(result.error);
          welcome(result, mode === 'rejoin');
        });
      },
    },
      field('Session code', code, 'Your trainer gives you this code.'),
      mode === 'new'
        ? field('Your name', name, 'Only the trainer sees your name. Other coders see a letter (A, B, C).')
        : field('Your rejoin code', rejoin, 'The personal code you were shown when you first joined. Your trainer can also look it up.'),
      btn);

    mount(app,
      h('div', { class: 'card narrow' },
        h('h1', {}, mode === 'new' ? 'Join a session' : 'Reconnect on this device'),
        form,
        h('p', {},
          h('button', { class: 'link', onclick: () => { prefill = code.value; mode = mode === 'new' ? 'rejoin' : 'new'; render(); } },
            mode === 'new'
              ? 'Already joined on another device or browser? Use your rejoin code'
              : 'First time in this session? Join as a new coder'))));
  }

  function welcome(result, wasRejoin) {
    mount(app,
      h('div', { class: 'card narrow' },
        h('h1', {}, wasRejoin ? `Welcome back, Coder ${result.label}` : `You are Coder ${result.label}`),
        h('p', {}, `Session: ${result.title}`),
        h('div', { class: 'rejoin-box' },
          h('span', { class: 'muted' }, 'Your rejoin code'),
          h('strong', {}, result.rejoin_code),
          h('button', {
            class: 'link',
            onclick: async () => { await navigator.clipboard.writeText(result.rejoin_code); toast('Rejoin code copied'); },
          }, 'Copy')),
        h('p', {}, 'Save this code. This browser will remember you, but on a different device or browser you need the session code plus this rejoin code to get back to your saved work.'),
        h('a', { class: 'button', href: `#/c/${result.session_id}` }, 'Continue')));
  }

  render();
}
