import { supabase, unwrap } from '../../supabase.js';
import { h, mount, toast, withBusy } from '../../ui.js';
import { normalizeCodebook, validateCodebook } from '../../lib/codebook.js';

const REFRESH_MS = 20000;

export async function roundsTab({ el, session, rerender }) {
  const sid = session.id;
  const [coders, secrets, rounds, versions, itemsHead] = await Promise.all([
    supabase.from('coders').select('id, label, joined_at').eq('session_id', sid).order('joined_at'),
    supabase.from('coder_secrets').select('coder_id, rejoin_code, name').eq('session_id', sid),
    supabase.from('rounds').select('*').eq('session_id', sid).order('round_no'),
    supabase.from('codebook_versions').select('id, version, locked, content').eq('session_id', sid).order('version', { ascending: false }),
    supabase.from('items').select('id', { count: 'exact', head: true }).eq('session_id', sid),
  ]);
  const coderRows = unwrap(coders);
  const secretOf = new Map(unwrap(secrets).map((s) => [s.coder_id, s]));
  const roundRows = unwrap(rounds);
  const versionRows = unwrap(versions);
  if (itemsHead.error) throw new Error(itemsHead.error.message);
  const totalItems = itemsHead.count ?? 0;

  let usedItems = 0;
  if (roundRows.length > 0) {
    const used = await supabase.from('round_items').select('item_id', { count: 'exact', head: true })
      .in('round_id', roundRows.map((r) => r.id));
    if (used.error) throw new Error(used.error.message);
    usedItems = used.count ?? 0;
  }
  const unused = totalItems - usedItems;
  const openRound = roundRows.find((r) => r.status === 'open');
  const versionOf = (id) => versionRows.find((v) => v.id === id);
  const joinLink = `${window.location.origin}${window.location.pathname}#/join/${session.join_code}`;

  // ---- coders ----
  const codersCard = h('div', { class: 'card' },
    h('div', { class: 'row spread' },
      h('h2', {}, `Coders (${coderRows.length})`),
      h('a', { class: 'button secondary small', href: `#/join/${session.join_code}` }, 'Join as a coder myself')),
    h('p', { class: 'muted' }, 'Send coders this link, or the site address plus the join code. Names and rejoin codes are visible only to you.'),
    h('div', { class: 'row' },
      h('code', {}, joinLink),
      h('button', { class: 'link', onclick: async () => { await navigator.clipboard.writeText(joinLink); toast('Link copied'); } }, 'Copy link')),
    coderRows.length > 0 && h('table', {},
      h('thead', {}, h('tr', {}, ['Coder', 'Name', 'Rejoin code', 'Joined'].map((t) => h('th', {}, t)))),
      h('tbody', {}, coderRows.map((c) => h('tr', {},
        h('td', {}, h('strong', {}, c.label)),
        h('td', {}, secretOf.get(c.id)?.name || ''),
        h('td', {}, h('code', {}, secretOf.get(c.id)?.rejoin_code || '')),
        h('td', {}, new Date(c.joined_at).toLocaleDateString()))))));

  // ---- current round, or the form to start one ----
  const roundCard = h('div', { class: 'card' });

  if (openRound) {
    const cb = versionOf(openRound.codebook_version_id);
    const nVars = cb ? cb.content.variables.length : 1;
    const table = h('div', {});
    const stamp = h('span', { class: 'muted' });

    async function refreshProgress() {
      const rows = unwrap(await supabase.rpc('round_progress', { p_round_id: openRound.id }));
      stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      mount(table, rows.length === 0
        ? h('p', { class: 'muted' }, 'No coders have joined yet.')
        : h('table', {},
            h('thead', {}, h('tr', {}, ['Coder', 'Name', 'Progress', 'Status', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, rows.map((r) => {
              const done = Number(r.codes_done);
              const total = Number(r.codes_total);
              const itemsDone = Math.floor(done / nVars);
              const itemsTotal = Math.round(total / nVars);
              const reopenBtn = h('button', {
                class: 'link',
                onclick: () => {
                  if (!window.confirm(`Reopen the round for coder ${r.label} so they can change their answers?`)) return;
                  withBusy(reopenBtn, async () => {
                    unwrap(await supabase.rpc('reopen_submission', { p_round_id: openRound.id, p_coder_id: r.coder_id }));
                    toast(`Reopened for coder ${r.label}`);
                    await refreshProgress();
                  });
                },
              }, 'Reopen');
              return h('tr', {},
                h('td', {}, h('strong', {}, r.label)),
                h('td', {}, secretOf.get(r.coder_id)?.name || ''),
                h('td', {},
                  h('progress', { max: total || 1, value: done }),
                  ` ${itemsDone} of ${itemsTotal} items`,
                  nVars > 1 && done % nVars !== 0 && h('span', { class: 'muted' }, ' (one more partly coded)')),
                h('td', {}, r.submitted_at
                  ? h('span', { class: 'tag ok' }, `Submitted ${new Date(r.submitted_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`)
                  : done === 0 ? h('span', { class: 'tag' }, 'Not started') : h('span', { class: 'tag busy' }, 'Coding')),
                h('td', {}, r.submitted_at && reopenBtn));
            }))));
    }

    const refreshBtn = h('button', { class: 'secondary small', onclick: () => withBusy(refreshBtn, refreshProgress) }, 'Refresh');
    mount(roundCard,
      h('div', { class: 'row spread' },
        h('h2', {}, `Round ${openRound.round_no} is open`),
        h('div', { class: 'row' }, stamp, refreshBtn)),
      h('p', { class: 'muted' }, `Codebook version ${cb ? cb.version : '?'}, opened ${new Date(openRound.opened_at).toLocaleDateString()}. You see progress only. Nobody, including you, can see other coders' answers until the round is closed.`),
      table,
      h('p', { class: 'note' }, 'Closing the round, reliability statistics, and the disagreement review arrive in the next build step.'));
    await refreshProgress();
    const timer = setInterval(() => {
      if (!el.isConnected) return clearInterval(timer);
      if (document.visibilityState === 'visible') refreshProgress().catch(console.error);
    }, REFRESH_MS);
  } else {
    const latest = versionRows[0];
    const select = h('select', {}, versionRows.map((v) =>
      h('option', { value: v.id }, `Version ${v.version}${v.locked ? ' (used before)' : ' (draft, will be locked)'}`)));
    const problemsBox = h('div', {});
    const startBtn = h('button', {}, `Start round ${roundRows.length + 1}`);
    const batch = Math.min(session.batch_size, unused);

    function check() {
      const v = versionOf(select.value);
      const problems = [];
      if (totalItems === 0) problems.push('Upload a dataset first (Dataset tab).');
      else if (unused === 0) problems.push('Every item has been used. Upload more items to run another round.');
      if (!v) problems.push('Create a codebook first (Codebook tab).');
      else problems.push(...validateCodebook(normalizeCodebook(v.content)));
      startBtn.disabled = problems.length > 0;
      mount(problemsBox, problems.length > 0 && h('div', { class: 'warn' },
        h('strong', {}, 'Before you can start:'), h('ul', {}, problems.map((p) => h('li', {}, p)))));
    }
    select.addEventListener('change', check);
    startBtn.addEventListener('click', () => {
      const v = versionOf(select.value);
      const few = coderRows.length < 2 ? `\n\nOnly ${coderRows.length} coder${coderRows.length === 1 ? ' has' : 's have'} joined so far. Others can still join after the round starts.` : '';
      if (!window.confirm(`Start round ${roundRows.length + 1} with ${batch} items and codebook version ${v.version}?\n\nThe codebook version will be locked.${few}`)) return;
      withBusy(startBtn, async () => {
        unwrap(await supabase.rpc('start_round', { p_session_id: sid, p_codebook_version_id: v.id }));
        toast('Round started');
        rerender();
      });
    });

    mount(roundCard,
      h('h2', {}, roundRows.length === 0 ? 'Start the first round' : 'Start the next round'),
      h('p', {}, totalItems === 0
        ? 'No items uploaded yet.'
        : `${unused.toLocaleString()} of ${totalItems.toLocaleString()} items are unused. This round will draw ${batch} of them at random.`),
      latest && h('div', { class: 'row' }, h('span', {}, 'Codebook'), select),
      problemsBox,
      startBtn);
    check();
  }

  const closed = roundRows.filter((r) => r.status === 'closed');
  mount(el,
    roundCard,
    codersCard,
    closed.length > 0 && h('div', { class: 'card' },
      h('h2', {}, 'Earlier rounds'),
      h('ul', {}, closed.map((r) => h('li', {},
        `Round ${r.round_no}, codebook version ${versionOf(r.codebook_version_id)?.version ?? '?'}, closed ${new Date(r.closed_at).toLocaleDateString()}`)))));
}
