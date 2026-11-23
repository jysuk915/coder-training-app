import { supabase, isTrainerUser, unwrap } from '../supabase.js';
import { h, mount, toast, withBusy, field } from '../ui.js';

export async function trainerPage({ app, user, rerender }) {
  if (!isTrainerUser(user)) return signInView(app);

  const sessions = unwrap(
    await supabase.from('sessions').select('*').eq('trainer_id', user.id).order('created_at', { ascending: false })
  );

  const title = h('input', { type: 'text', placeholder: 'e.g., Bike lane study, fall coders', required: true });
  const createBtn = h('button', { type: 'submit' }, 'Create session');
  const form = h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(createBtn, async () => {
        const s = unwrap(await supabase.rpc('create_session', { p_title: title.value }));
        window.location.hash = `#/s/${s.id}`;
      });
    },
  }, title, createBtn);

  mount(
    app,
    h('h1', {}, 'My sessions'),
    h('div', { class: 'card' }, h('h2', {}, 'New session'), form),
    sessions.length === 0
      ? h('p', { class: 'muted' }, 'No sessions yet. Create your first one above.')
      : h('div', { class: 'list' }, sessions.map((s) =>
          h('a', { class: 'card list-item', href: `#/s/${s.id}` },
            h('strong', {}, s.title),
            h('span', { class: 'muted' }, `Join code ${s.join_code}, created ${new Date(s.created_at).toLocaleDateString()}`))))
  );
}

function signInView(app) {
  const email = h('input', { type: 'email', placeholder: 'you@university.edu', required: true, autocomplete: 'email' });
  const btn = h('button', { type: 'submit' }, 'Email me a sign-in link');
  const note = h('p', { class: 'muted' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(btn, async () => {
        const { error } = await supabase.auth.signInWithOtp({
          email: email.value.trim(),
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) throw new Error(error.message);
        note.textContent = `Check ${email.value.trim()} for a sign-in link, and open it in this browser. You can close this tab.`;
        toast('Link sent');
      });
    },
  }, field('Email', email), btn);

  mount(
    app,
    h('div', { class: 'card narrow' },
      h('h1', {}, 'Trainer sign-in'),
      h('p', {}, 'No password. We email you a link, and the same email always brings you back to your sessions.'),
      form, note)
  );
}
