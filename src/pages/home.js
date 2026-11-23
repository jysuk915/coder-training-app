import { h, mount } from '../ui.js';

export async function homePage({ app }) {
  mount(
    app,
    h('section', { class: 'hero' },
      h('h1', {}, 'Train content-analysis coders, round by round'),
      h('p', {}, 'Coders work through the same batch on their own, then the team reviews disagreements and reliability together before the next round.')),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h2', {}, 'I am a coder'),
        h('p', { class: 'muted' }, 'Joining with a session code arrives in the next build step (blind coding view).'),
        h('button', { disabled: true }, 'Join a session')),
      h('div', { class: 'card' },
        h('h2', {}, 'I am a trainer'),
        h('p', {}, 'Create a session, upload a dataset and codebook, and run training rounds.'),
        h('a', { class: 'button', href: '#/trainer' }, 'Sign in or open my sessions')))
  );
}
