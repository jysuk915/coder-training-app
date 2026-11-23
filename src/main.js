import { supabase, isConfigured, currentUser, isTrainerUser, arrivedFromEmailLink, emailLinkError } from './supabase.js';
import { h, mount, toast } from './ui.js';
import { homePage } from './pages/home.js';
import { trainerPage } from './pages/trainer.js';
import { sessionPage } from './pages/session.js';
import { joinPage } from './pages/join.js';
import { coderPage } from './pages/coder.js';
import { codingPage } from './pages/coding.js';
import { reviewPage } from './pages/review.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

const routes = [
  [/^#?\/?$/, homePage],
  [/^#\/trainer$/, trainerPage],
  [/^#\/s\/([0-9a-f-]{36})(?:\/([a-z]+))?$/, sessionPage],
  [/^#\/join(?:\/([0-9A-Za-z]+))?$/, joinPage],
  [/^#\/c\/([0-9a-f-]{36})$/, coderPage],
  [/^#\/c\/([0-9a-f-]{36})\/code$/, codingPage],
  [/^#\/r\/([0-9a-f-]{36})$/, reviewPage],
];

async function renderNav(user) {
  if (isTrainerUser(user)) {
    mount(
      nav,
      h('a', { href: '#/trainer' }, 'My sessions'),
      h('span', { class: 'muted' }, user.email),
      h('button', {
        class: 'link',
        onclick: async () => {
          await supabase.auth.signOut();
          window.location.hash = '#/';
          render();
        },
      }, 'Sign out')
    );
  } else {
    mount(nav, h('a', { href: '#/trainer' }, 'Trainer sign-in'));
  }
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const user = await currentUser();
  if (token !== renderToken) return;
  renderNav(user);
  const hash = window.location.hash;
  for (const [pattern, page] of routes) {
    const match = hash.match(pattern);
    if (match) {
      mount(app, h('p', { class: 'muted' }, 'Loading…'));
      try {
        await page({ app, user, params: match.slice(1), rerender: render });
      } catch (err) {
        console.error(err);
        mount(app, h('div', { class: 'card error' }, h('h2', {}, 'Something went wrong'), h('p', {}, err.message || String(err))));
      }
      return;
    }
  }
  mount(app, h('div', { class: 'card' }, h('h2', {}, 'Page not found'), h('a', { href: '#/' }, 'Back to the start')));
}

async function start() {
  if (!isConfigured) {
    mount(
      app,
      h('div', { class: 'card' },
        h('h2', {}, 'Almost there: connect your Supabase project'),
        h('p', {}, 'Open the file ', h('code', {}, 'src/config.js'), ' and paste in your project URL and key. SETUP.md (step 4) shows where to find them.'))
    );
    return;
  }
  await currentUser(); // waits for an email sign-in link to be processed, if any
  if (arrivedFromEmailLink) {
    if (emailLinkError) toast(`Sign-in link problem: ${emailLinkError}. Request a new link.`, 'error');
    history.replaceState(null, '', window.location.pathname + '#/trainer');
  }
  window.addEventListener('hashchange', render);
  render();
}

start();
