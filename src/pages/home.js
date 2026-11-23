import { supabase, isTrainerUser } from '../supabase.js';
import { h, mount } from '../ui.js';

export async function homePage({ app, user }) {
  // Sessions this browser is already connected to as a coder.
  let slots = [];
  if (user) {
    const { data } = await supabase.rpc('my_coder_slots');
    slots = data || [];
  }

  const code = h('input', { type: 'text', placeholder: 'Session code', required: true, autocapitalize: 'characters', autocomplete: 'off', class: 'code-input' });
  const joinForm = h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      window.location.hash = `#/join/${code.value.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')}`;
    },
  }, code, h('button', { type: 'submit' }, 'Join'));

  mount(
    app,
    h('section', { class: 'hero' },
      h('h1', {}, 'Train content-analysis coders, round by round'),
      h('p', {}, 'Coders work through the same batch on their own, then the team reviews disagreements and reliability together before the next round.')),
    slots.length > 0 && h('div', { class: 'card' },
      h('h2', {}, 'Continue coding'),
      h('div', { class: 'list' }, slots.map((s) =>
        h('a', { class: 'card list-item', href: `#/c/${s.session_id}` },
          h('strong', {}, s.title), h('span', { class: 'muted' }, `You are Coder ${s.label}`))))),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h2', {}, 'I am a coder'),
        h('p', {}, 'Enter the session code from your trainer. No account needed.'),
        joinForm,
        h('p', {}, h('a', { href: '#/join' }, 'Reconnect with a rejoin code'))),
      h('div', { class: 'card' },
        h('h2', {}, 'I am a trainer'),
        h('p', {}, 'Create a session, upload a dataset and codebook, and run training rounds.'),
        h('a', { class: 'button', href: '#/trainer' }, isTrainerUser(user) ? 'Open my sessions' : 'Sign in'))));
}
