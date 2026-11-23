import { h, mount } from '../ui.js';
import { loadCoderContext, loadRound, countComplete } from '../lib/coderData.js';

// A coder's home for one session: where they are and what to do next.
export async function coderPage({ app, user, params }) {
  const [sessionId] = params;
  const ctx = user ? await loadCoderContext(sessionId) : null;
  if (!ctx) {
    mount(app, h('div', { class: 'card narrow' },
      h('h2', {}, 'This browser is not connected to that session'),
      h('p', {}, 'Join with the session code, or reconnect with your rejoin code.'),
      h('a', { class: 'button', href: '#/join' }, 'Join or reconnect')));
    return;
  }
  const { slot, rounds, openRound } = ctx;
  const closed = rounds.filter((r) => r.status === 'closed');

  let status;
  if (openRound) {
    const round = await loadRound(openRound, slot.coder_id);
    const total = round.items.length;
    const done = countComplete(round.items, round.codebook.variables, round.codes);
    status = h('div', { class: 'card' },
      h('h2', {}, `Round ${openRound.round_no}`),
      round.submittedAt
        ? [h('p', { class: 'note' }, `You submitted this round (${done} of ${total} items coded). The review opens when your trainer closes the round.`),
           h('a', { class: 'button secondary', href: `#/c/${sessionId}/code` }, 'Look at my answers')]
        : [h('p', { class: 'big' }, `${done} of ${total} items coded`),
           h('p', { class: 'muted' }, 'Your answers save as you go. You can change them until you submit the round.'),
           h('a', { class: 'button', href: `#/c/${sessionId}/code` }, done === 0 ? 'Start coding' : 'Continue coding')]);
  } else {
    status = h('div', { class: 'card' },
      h('h2', {}, rounds.length === 0 ? 'Waiting for the first round' : 'Waiting for the next round'),
      h('p', {}, 'Your trainer has not opened a round yet. Come back to this page when they tell you it has started.'),
      h('button', { class: 'secondary', onclick: () => window.location.reload() }, 'Check again'));
  }

  mount(app,
    h('div', { class: 'session-head' },
      h('div', {}, h('span', { class: 'muted' }, slot.title), h('h1', {}, `Coder ${slot.label}`)),
      h('div', { class: 'joincode' }, h('span', { class: 'muted' }, 'Your rejoin code'), h('strong', {}, slot.rejoin_code))),
    status,
    closed.length > 0 && h('div', { class: 'card' },
      h('h2', {}, 'Earlier rounds'),
      h('ul', {}, closed.map((r) => h('li', {}, `Round ${r.round_no}, closed ${new Date(r.closed_at).toLocaleDateString()}`))),
      h('p', { class: 'muted' }, 'The disagreement review screens arrive in the next build step.')));
}
