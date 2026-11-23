import { supabase, isTrainerUser, unwrap } from '../supabase.js';
import { h, mount, toast } from '../ui.js';
import { roundsTab } from './tabs/rounds.js';
import { datasetTab } from './tabs/dataset.js';
import { codebookTab } from './tabs/codebook.js';
import { settingsTab } from './tabs/settings.js';

const TABS = [
  ['rounds', 'Rounds and coders', roundsTab],
  ['dataset', 'Dataset', datasetTab],
  ['codebook', 'Codebook', codebookTab],
  ['settings', 'Settings', settingsTab],
];

export async function sessionPage({ app, user, params, rerender }) {
  const [sessionId, tabName = 'rounds'] = params;
  if (!isTrainerUser(user)) {
    window.location.hash = '#/trainer';
    return;
  }
  const session = unwrap(await supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle());
  if (!session || session.trainer_id !== user.id) {
    mount(app, h('div', { class: 'card' },
      h('h2', {}, 'Session not found'),
      h('p', {}, 'It may have been deleted, or it belongs to a different trainer account.'),
      h('a', { href: '#/trainer' }, 'Back to my sessions')));
    return;
  }

  const tab = TABS.find(([name]) => name === tabName) || TABS[0];
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));

  const copyBtn = h('button', {
    class: 'link',
    onclick: async () => {
      await navigator.clipboard.writeText(session.join_code);
      toast('Join code copied');
    },
  }, 'Copy');

  mount(
    app,
    h('div', { class: 'session-head' },
      h('div', {},
        h('a', { class: 'muted', href: '#/trainer' }, '← My sessions'),
        h('h1', {}, session.title)),
      h('div', { class: 'joincode' },
        h('span', { class: 'muted' }, 'Coder join code'),
        h('strong', {}, session.join_code),
        copyBtn)),
    h('nav', { class: 'tabs' }, TABS.map(([name, label]) =>
      h('a', { href: `#/s/${session.id}/${name}`, class: name === tab[0] ? 'active' : '' }, label))),
    body
  );

  await tab[2]({ el: body, session, rerender });
}
