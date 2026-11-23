import { supabase, unwrap, fetchAll, isTrainerUser } from '../supabase.js';
import { h, mount, toast, withBusy, richText } from '../ui.js';
import {
  indexCodes, buildCards, sortDisagreements, confusionGrid, consensusCode, coderDeviation, roundReliability, reliabilityRows,
} from '../lib/review.js';

const POLL_MS = 20000;
const LONG_TEXT = 1200;
const cardKey = (itemId, variableKey) => `${itemId}|${variableKey}`;
const fmtAlpha = (a) => (a === null || a === undefined ? 'n/a' : a.toFixed(2).replace(/^(-?)0\./, '$1.'));
const fmtPct = (p) => (p === null || p === undefined ? 'n/a' : `${Math.round(p * 100)}%`);

// Review of a closed round: summary, per-variable disagreements, by item,
// by coder (trainer only), and the codebook issues list.
export async function reviewPage({ app, user, params }) {
  const [roundId] = params;
  const round = user ? unwrap(await supabase.from('rounds').select('*').eq('id', roundId).maybeSingle()) : null;
  if (!round) {
    mount(app, h('div', { class: 'card narrow' },
      h('h2', {}, 'Round not found'),
      h('p', {}, 'This browser is not connected to that session, or the round does not exist.'),
      h('a', { class: 'button', href: '#/' }, 'Back to the start')));
    return;
  }
  const session = unwrap(await supabase.from('sessions').select('*').eq('id', round.session_id).single());
  const isTrainer = isTrainerUser(user) && session.trainer_id === user.id;
  const slots = unwrap(await supabase.rpc('my_coder_slots'));
  const mySlot = slots.find((s) => s.session_id === session.id) || null;
  const backHref = isTrainer ? `#/s/${session.id}` : `#/c/${session.id}`;

  if (round.status !== 'closed') {
    mount(app, h('div', { class: 'card narrow' },
      h('h2', {}, `Round ${round.round_no} is still open`),
      h('p', {}, 'The review opens when the trainer closes the round.'),
      h('a', { class: 'button', href: backHref }, 'Back')));
    return;
  }

  // ---- load everything for the round ----
  const [cbRow, batch, coderRows, codes] = await Promise.all([
    supabase.from('codebook_versions').select('version, content').eq('id', round.codebook_version_id).single().then(unwrap),
    supabase.from('round_items').select('position, items(id, ext_id, text)').eq('round_id', round.id).order('position').then(unwrap),
    supabase.from('coders').select('id, label, joined_at').eq('session_id', session.id).order('joined_at').then(unwrap),
    fetchAll(() => supabase.from('codes').select('item_id, coder_id, variable_key, category_key, unsure')
      .eq('round_id', round.id).order('item_id').order('coder_id').order('variable_key')),
  ]);
  const variables = cbRow.content.variables;
  const items = batch.map((b) => b.items).filter(Boolean);
  const index = indexCodes(codes);
  const activeIds = new Set(codes.map((c) => c.coder_id));
  const coders = coderRows.filter((c) => activeIds.has(c.id)); // only people who coded in this round
  const labelOf = new Map(coderRows.map((c) => [c.id, c.label]));
  const target = Number(session.alpha_target);
  const stats = roundReliability(items, variables, index, target);
  const cardsByVar = new Map(variables.map((v) => [v.key, buildCards(items, v, index, coders)]));

  // The trainer's first visit stores the reliability figures for the history view.
  if (isTrainer) {
    const stored = unwrap(await supabase.from('reliability').select('variable_key').eq('round_id', round.id));
    if (stored.length !== variables.length) {
      unwrap(await supabase.from('reliability').upsert(reliabilityRows(round.id, stats), { onConflict: 'round_id,variable_key' }));
    }
  }

  // ---- discussion state: consensus, comments, flags (refreshed while open) ----
  let consensus = new Map();
  let comments = [];
  let flags = [];
  let lastSnapshot = '';
  async function loadDiscussion() {
    const [c, m, f] = await Promise.all([
      supabase.from('consensus').select('*').eq('round_id', round.id).then(unwrap),
      fetchAll(() => supabase.from('comments').select('*').eq('round_id', round.id).order('created_at').order('id')),
      supabase.from('codebook_flags').select('*').eq('round_id', round.id).order('created_at').then(unwrap),
    ]);
    const snapshot = JSON.stringify([c, m, f]);
    const changed = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    consensus = new Map(c.map((r) => [cardKey(r.item_id, r.variable_key), r]));
    comments = m;
    flags = f;
    return changed;
  }
  await loadDiscussion();

  const consensusRow = (card) => consensus.get(cardKey(card.item.id, card.variableKey));
  const isResolved = (card) => consensusRow(card)?.status === 'resolved';
  const flagsOf = (card) => flags.filter((f) => f.item_id === card.item.id && f.variable_key === card.variableKey);
  const commentsOf = (card) => comments.filter((c) => c.item_id === card.item.id && c.variable_key === card.variableKey);
  const authorName = (coderId) => (coderId ? `Coder ${labelOf.get(coderId) || '?'}` : 'Trainer');
  const catName = (variable, key) => variable.categories.find((c) => c.key === key)?.name || key;

  // ---- view state ----
  const state = { view: 'summary', variableKey: stats[0]?.variable.key, pair: null, status: 'all', onlyDisagreements: true };
  const drafts = new Map(); // unsent comment text per card, kept across redraws
  let postAs = isTrainer ? 'trainer' : 'coder';
  const body = h('div', {});
  const tabsEl = h('nav', { class: 'tabs' });

  function setView(view, patch = {}) {
    Object.assign(state, { view, pair: null, status: 'all' }, patch);
    render();
    window.scrollTo({ top: 0 });
  }

  function render() {
    const nFlags = new Set(flags.map((f) => cardKey(f.item_id, f.variable_key))).size;
    const tabs = [
      ['summary', 'Summary'],
      ['variable', 'By variable'],
      ['item', 'By item'],
      isTrainer && ['coder', 'By coder'],
      ['issues', `Codebook issues${nFlags ? ` (${nFlags})` : ''}`],
    ].filter(Boolean);
    mount(tabsEl, tabs.map(([name, label]) =>
      h('a', { href: 'javascript:void(0)', class: state.view === name ? 'active' : '', onclick: (e) => { e.preventDefault(); setView(name); } }, label)));
    const views = { summary: summaryView, variable: variableView, item: itemView, coder: coderView, issues: issuesView };
    mount(body, views[state.view]());
  }

  // ---------------------------------------------------------------- summary
  function summaryView() {
    const passing = stats.filter((s) => s.passed).length;
    return [
      h('div', { class: 'card' },
        h('p', { class: 'big' }, `${passing} of ${stats.length} variable${stats.length === 1 ? '' : 's'} at or above the target (α ≥ ${fmtAlpha(target)})`),
        h('p', { class: 'muted' }, `${items.length} items, ${coders.length} coder${coders.length === 1 ? '' : 's'} (${coders.map((c) => c.label).join(', ')}), codebook version ${cbRow.version}. Variables below the target are listed first.`),
        coders.length < 2 && h('p', { class: 'warn' }, 'Fewer than two coders coded this round, so agreement cannot be computed.')),
      h('div', { class: 'card' },
        h('table', { class: 'summary' },
          h('thead', {}, h('tr', {}, ['Variable', "Krippendorff's α", 'Result', 'Pairwise agreement', 'Items all agreed', 'Disagreements', 'Resolved', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, stats.map((s) => {
            const dis = cardsByVar.get(s.variable.key).filter((c) => c.isDisagreement);
            const resolved = dis.filter(isResolved).length;
            return h('tr', {},
              h('td', {}, h('strong', {}, s.variable.name)),
              h('td', { class: 'num', title: s.alphaReason || '' }, fmtAlpha(s.alpha)),
              h('td', {}, s.passed ? h('span', { class: 'tag ok' }, 'Passed') : h('span', { class: 'tag bad' }, s.alpha === null ? 'Not computable' : 'Below target')),
              h('td', { class: 'num' }, fmtPct(s.pctAgreement)),
              h('td', { class: 'num' }, `${s.nUnanimous} of ${s.nItems}`),
              h('td', { class: 'num' }, dis.length),
              h('td', { class: 'num' }, dis.length ? `${resolved} of ${dis.length}` : ''),
              h('td', {}, h('button', { class: 'secondary small', onclick: () => setView('variable', { variableKey: s.variable.key }) }, 'Review')));
          }))),
        stats.some((s) => s.alphaReason) && h('p', { class: 'muted' }, stats.filter((s) => s.alphaReason).map((s) => `${s.variable.name}: ${s.alphaReason}`).join(' ')),
        h('p', { class: 'muted' }, 'Pairwise agreement: of all pairs of coders who coded the same item, the share that chose the same category. Items coded by only one coder are left out of every figure.')),
    ];
  }

  // --------------------------------------------------------------- variable
  function variableView() {
    const s = stats.find((x) => x.variable.key === state.variableKey) || stats[0];
    if (!s) return h('p', {}, 'No variables.');
    const variable = s.variable;
    const cards = cardsByVar.get(variable.key);
    const grid = confusionGrid(cards, variable.categories);
    const totalCodes = Object.values(s.categoryTotals || {}).reduce((a, b) => a + b, 0);
    let list = sortDisagreements(cards);
    const counts = {
      all: list.length,
      open: list.filter((c) => !isResolved(c)).length,
      resolved: list.filter(isResolved).length,
      flagged: list.filter((c) => flagsOf(c).length > 0).length,
    };
    if (state.pair) list = list.filter((c) => state.pair.every((p) => c.disputed.includes(p)));
    if (state.status === 'open') list = list.filter((c) => !isResolved(c));
    if (state.status === 'resolved') list = list.filter(isResolved);
    if (state.status === 'flagged') list = list.filter((c) => flagsOf(c).length > 0);

    return [
      stats.length > 1 && h('div', { class: 'pills' }, stats.map((x) =>
        h('button', {
          class: x.variable.key === variable.key ? 'pill active' : 'pill',
          onclick: () => setView('variable', { variableKey: x.variable.key }),
        }, `${x.variable.name} ${fmtAlpha(x.alpha)}`))),
      h('div', { class: 'card' },
        h('div', { class: 'row spread' },
          h('h2', {}, variable.name),
          s.passed ? h('span', { class: 'tag ok' }, `Passed (target ${fmtAlpha(target)})`) : h('span', { class: 'tag bad' }, s.alpha === null ? 'Not computable' : `Below target ${fmtAlpha(target)}`)),
        h('div', { class: 'statrow' },
          stat("Krippendorff's α", fmtAlpha(s.alpha)),
          stat('Pairwise agreement', fmtPct(s.pctAgreement)),
          stat('Items all agreed', `${s.nUnanimous} of ${s.nItems}`),
          stat('Coders', s.nCoders)),
        s.alphaReason && h('p', { class: 'muted' }, s.alphaReason),
        h('div', { class: 'grid two' },
          h('div', {},
            h('h3', {}, 'How often each category was used'),
            h('table', {}, h('tbody', {}, variable.categories.map((c) => {
              const n = s.categoryTotals?.[c.key] || 0;
              return h('tr', {}, h('td', {}, c.name), h('td', { class: 'num' }, n), h('td', { class: 'num muted' }, totalCodes ? fmtPct(n / totalCodes) : ''));
            }))),
            h('p', { class: 'muted' }, 'Counts of codes across all coders. When one category dominates, α can be low even with high agreement.')),
          h('div', {},
            h('h3', {}, 'Which categories got mixed up'),
            confusionTable(variable, grid),
            h('p', { class: 'muted' }, 'Each cell counts items where one coder chose the row category and another chose the column category. Click a cell to see those items. The diagonal counts items everyone agreed on.')))),
      h('div', { class: 'row spread' },
        h('div', { class: 'pills' },
          [['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved'], ['flagged', 'Codebook issue']].map(([key, label]) =>
            h('button', { class: state.status === key ? 'pill active' : 'pill', onclick: () => { state.status = key; render(); } }, `${label} (${counts[key]})`))),
        state.pair && h('span', {},
          `Showing ${catName(variable, state.pair[0])} vs ${catName(variable, state.pair[1])} `,
          h('button', { class: 'link', onclick: () => { state.pair = null; render(); } }, 'Show all'))),
      list.length === 0
        ? h('div', { class: 'card' }, h('p', { class: 'muted' }, counts.all === 0 ? 'No disagreements on this variable.' : 'No cards match this filter.'))
        : list.map((card) => disagreementCard(card, variable)),
    ];
  }

  function stat(label, value) {
    return h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('strong', {}, value));
  }

  function confusionTable(variable, grid) {
    const cats = variable.categories;
    return h('table', { class: 'confusion' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), cats.map((c) => h('th', { title: c.name }, c.name)))),
      h('tbody', {}, cats.map((row) =>
        h('tr', {}, h('th', { title: row.name }, row.name), cats.map((col) => {
          const n = grid[row.key][col.key];
          if (row.key === col.key) return h('td', { class: 'diag' }, n || '');
          const active = state.pair && state.pair.includes(row.key) && state.pair.includes(col.key);
          return h('td', {},
            n > 0 ? h('button', {
              class: active ? 'cell active' : 'cell',
              'aria-label': `${n} items: ${row.name} versus ${col.name}`,
              onclick: () => { state.pair = active ? null : [row.key, col.key]; state.status = 'all'; render(); },
            }, n) : '');
        })))));
  }

  // ------------------------------------------------------------------- card
  function itemText(text) {
    if (text.length <= LONG_TEXT) return h('div', { class: 'item-text' }, text);
    const box = h('div', { class: 'item-text' }, `${text.slice(0, LONG_TEXT)}…`);
    const btn = h('button', { class: 'link', onclick: () => { box.textContent = text; btn.remove(); } }, `Show all (${text.length.toLocaleString()} characters)`);
    return h('div', {}, box, btn);
  }

  function voteChips(card, variable) {
    return h('div', { class: 'votes' }, card.votes.map((v) =>
      h('span', { class: card.majority && v.category_key !== card.majority ? 'vote odd' : 'vote' },
        h('strong', {}, v.coder.label),
        mySlot && v.coder.id === mySlot.coder_id && h('span', { class: 'muted' }, ' (you)'),
        ` ${catName(variable, v.category_key)}`,
        v.unsure && h('span', { class: 'tag warn-tag' }, 'unsure'))));
  }

  function disagreementCard(card, variable) {
    const key = cardKey(card.item.id, variable.key);
    const row = consensusRow(card);
    const resolved = isResolved(card);
    const cardFlags = flagsOf(card);
    const thread = commentsOf(card);
    const base = { round_id: round.id, item_id: card.item.id, variable_key: variable.key };
    const myCoderId = mySlot?.coder_id || null;
    const authorId = () => (isTrainer && postAs === 'trainer' ? null : myCoderId);
    const canWrite = isTrainer || !!myCoderId;

    async function act(button, fn) {
      await withBusy(button, async () => {
        await fn();
        await loadDiscussion();
        render();
      });
    }

    // consensus picker (trainer only)
    const picker = isTrainer && h('div', { class: 'consensus' },
      h('span', { class: 'part-label' }, resolved ? 'Consensus (click another to change)' : 'Set the consensus code'),
      h('div', { class: 'pills' }, variable.categories.map((c) => {
        const btn = h('button', {
          class: resolved && row.category_key === c.key ? 'pill active' : 'pill',
          onclick: () => act(btn, async () => {
            unwrap(await supabase.from('consensus').upsert(
              { ...base, category_key: c.key, status: 'resolved', resolved_at: new Date().toISOString() },
              { onConflict: 'round_id,item_id,variable_key' }));
          }),
        }, c.name);
        return btn;
      }),
      resolved && (() => {
        const btn = h('button', {
          class: 'link',
          onclick: () => act(btn, async () => {
            unwrap(await supabase.from('consensus').update({ status: 'open', resolved_at: null }).match(base));
          }),
        }, 'Reopen');
        return btn;
      })()));

    // comment form
    const text = h('textarea', { rows: 2, placeholder: 'Add a comment', 'aria-label': 'Comment' }, drafts.get(key) || '');
    text.addEventListener('input', () => drafts.set(key, text.value));
    const postBtn = h('button', { class: 'small' }, 'Post');
    postBtn.addEventListener('click', () => {
      if (!text.value.trim()) return;
      act(postBtn, async () => {
        unwrap(await supabase.from('comments').insert({ ...base, author_coder_id: authorId(), body: text.value.trim() }));
        drafts.delete(key);
      });
    });
    const asSelect = isTrainer && myCoderId && h('select', {
      'aria-label': 'Post as',
      onchange: (e) => { postAs = e.target.value; },
    },
      h('option', { value: 'trainer', selected: postAs === 'trainer' }, 'as Trainer'),
      h('option', { value: 'coder', selected: postAs === 'coder' }, `as Coder ${mySlot.label}`));

    // codebook-issue flag
    const flagBtn = h('button', {
      class: 'secondary small',
      onclick: () => {
        const note = window.prompt('What in the codebook caused this disagreement? (optional)');
        if (note === null) return;
        act(flagBtn, async () => {
          unwrap(await supabase.from('codebook_flags').insert({ ...base, author_coder_id: authorId(), note: note.trim() || null }));
        });
      },
    }, 'Flag as codebook issue');

    return h('div', { class: resolved ? 'card dcard resolved' : 'card dcard', id: `card-${card.item.id}` },
      h('div', { class: 'row spread' },
        h('span', { class: 'muted' }, `ID ${card.item.ext_id}`),
        h('div', { class: 'row' },
          h('span', { class: 'tag' }, card.kind === 'full' ? 'Full split' : `Majority split (${[...card.counts.values()].sort((a, b) => b - a).join(' to ')})`),
          cardFlags.length > 0 && h('span', { class: 'tag warn-tag' }, 'Codebook issue'),
          resolved ? h('span', { class: 'tag ok' }, 'Resolved') : h('span', { class: 'tag busy' }, 'Open'))),
      itemText(card.item.text),
      voteChips(card, variable),
      h('div', { class: 'disputed' }, card.disputed.map((ck) => {
        const c = variable.categories.find((x) => x.key === ck);
        return h('div', { class: 'def' }, h('strong', {}, c?.name || ck), c?.definition && richText(c.definition));
      })),
      !isTrainer && resolved && h('p', { class: 'note' }, 'Consensus: ', h('strong', {}, catName(variable, row.category_key))),
      picker,
      cardFlags.length > 0 && h('div', { class: 'flags' }, cardFlags.map((f) => {
        const mine = f.author_coder_id ? f.author_coder_id === myCoderId : isTrainer;
        const rm = h('button', {
          class: 'link',
          onclick: () => act(rm, async () => { unwrap(await supabase.from('codebook_flags').delete().eq('id', f.id)); }),
        }, 'Remove');
        return h('p', { class: 'warn' }, h('strong', {}, `Codebook issue, ${authorName(f.author_coder_id)}`), f.note ? `: ${f.note} ` : ' ', (mine || isTrainer) && rm);
      })),
      h('div', { class: 'thread' },
        thread.map((c) => h('p', { class: 'comment' },
          h('strong', {}, authorName(c.author_coder_id)), ` ${c.body} `,
          h('span', { class: 'muted' }, new Date(c.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })))),
        canWrite && h('div', { class: 'comment-form' }, text, h('div', { class: 'row' }, postBtn, asSelect, flagBtn))));
  }

  // ---------------------------------------------------------------- by item
  function itemView() {
    const rows = items.map((item, i) => ({
      item,
      cards: variables.map((v) => ({ variable: v, card: cardsByVar.get(v.key)[i] })),
    }));
    const shown = state.onlyDisagreements ? rows.filter((r) => r.cards.some((c) => c.card.isDisagreement)) : rows;
    return [
      h('div', { class: 'card' },
        h('label', {},
          h('input', { type: 'checkbox', checked: state.onlyDisagreements, onchange: (e) => { state.onlyDisagreements = e.target.checked; render(); } }),
          ' Only items with a disagreement'),
        h('span', { class: 'muted' }, `  Showing ${shown.length} of ${items.length} items`)),
      shown.map(({ item, cards }) => h('div', { class: 'card' },
        h('span', { class: 'muted' }, `ID ${item.ext_id}`),
        itemText(item.text),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Variable'), coders.map((c) => h('th', {}, c.label)), h('th', {}, 'Consensus'), h('th', {}, ''))),
          h('tbody', {}, cards.map(({ variable, card }) => {
            const agreed = consensusCode(card, consensusRow(card));
            const byCoder = new Map(card.votes.map((v) => [v.coder.id, v]));
            return h('tr', { class: card.isDisagreement ? 'split' : '' },
              h('td', {}, h('strong', {}, variable.name)),
              coders.map((c) => {
                const v = byCoder.get(c.id);
                return h('td', {}, v ? catName(variable, v.category_key) : h('span', { class: 'muted' }, 'not coded'), v?.unsure && h('span', { class: 'tag warn-tag' }, 'unsure'));
              }),
              h('td', {}, agreed ? catName(variable, agreed) : card.isDisagreement ? h('span', { class: 'tag busy' }, 'Open') : ''),
              h('td', {}, card.isDisagreement && h('button', {
                class: 'link',
                onclick: () => {
                  setView('variable', { variableKey: variable.key });
                  document.getElementById(`card-${item.id}`)?.scrollIntoView?.({ block: 'start' });
                },
              }, 'Open card')));
          }))))),
    ];
  }

  // --------------------------------------------------------------- by coder
  function coderView() {
    const table = (title, cards) => {
      const rows = coderDeviation(cards, coders, (card) => consensusCode(card, consensusRow(card)));
      return h('div', { class: 'card' },
        h('h2', {}, title),
        h('table', {},
          h('thead', {}, h('tr', {}, ['Coder', 'Codes given', 'Differs from consensus', 'Odd one out', 'Marked unsure'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, h('strong', {}, r.coder.label)),
            h('td', { class: 'num' }, r.coded),
            h('td', { class: 'num' }, r.comparable ? `${r.differs} of ${r.comparable} (${fmtPct(r.differs / r.comparable)})` : 'n/a'),
            h('td', { class: 'num' }, r.oddOneOut),
            h('td', { class: 'num' }, r.unsure))))));
    };
    const all = variables.flatMap((v) => cardsByVar.get(v.key));
    const open = all.filter((c) => c.isDisagreement && !isResolved(c)).length;
    return [
      h('div', { class: 'card' },
        h('p', {}, 'Only you, the trainer, can see this tab.'),
        h('p', { class: 'muted' }, `Consensus is the code everyone gave, or your resolved pick. ${open > 0 ? `${open} disagreement${open === 1 ? ' is' : 's are'} still open and not counted yet. ` : ''}"Odd one out" counts items where this coder alone differed from all the others.`)),
      variables.length > 1 && table('All variables', all),
      variables.map((v) => table(v.name, cardsByVar.get(v.key))),
    ];
  }

  // ----------------------------------------------------------------- issues
  function issuesView() {
    const groups = variables.map((v) => ({
      variable: v,
      cards: cardsByVar.get(v.key).filter((c) => flagsOf(c).length > 0),
    })).filter((g) => g.cards.length > 0);
    return [
      h('div', { class: 'card' },
        h('h2', {}, 'Codebook issues'),
        h('p', {}, 'Cards flagged because the disagreement comes from the codebook, not the coder. Use this list to revise the codebook before the next round.'),
        isTrainer && h('a', { class: 'button secondary', href: `#/s/${session.id}/codebook` }, 'Open the codebook editor'),
        groups.length === 0 && h('p', { class: 'muted' }, 'Nothing flagged yet. Use "Flag as codebook issue" on any disagreement card.')),
      groups.map((g) => h('div', { class: 'card' },
        h('h2', {}, `${g.variable.name} (${g.cards.length})`),
        g.cards.map((card) => h('div', { class: 'issue' },
          h('div', { class: 'row spread' },
            h('span', { class: 'muted' }, `ID ${card.item.ext_id}`),
            h('button', {
              class: 'link',
              onclick: () => {
                setView('variable', { variableKey: g.variable.key, status: 'flagged' });
                document.getElementById(`card-${card.item.id}`)?.scrollIntoView?.({ block: 'start' });
              },
            }, 'Open card')),
          h('p', { class: 'quote' }, card.item.text.length > 300 ? `${card.item.text.slice(0, 300)}…` : card.item.text),
          voteChips(card, g.variable),
          flagsOf(card).map((f) => h('p', {}, h('strong', {}, authorName(f.author_coder_id)), f.note ? `: ${f.note}` : ': (no note)')))))),
    ];
  }

  // ---- page shell ----
  mount(app,
    h('div', { class: 'session-head' },
      h('div', {},
        h('a', { class: 'muted', href: backHref }, `← ${session.title}`),
        h('h1', {}, `Round ${round.round_no} review`)),
      h('span', { class: 'muted' }, `Closed ${new Date(round.closed_at).toLocaleDateString()}${mySlot ? `. You are Coder ${mySlot.label}` : ''}`)),
    tabsEl,
    body);
  render();

  // Pick up other people's comments and the trainer's decisions while the page is open.
  const timer = setInterval(async () => {
    if (!body.isConnected) return clearInterval(timer);
    if (document.visibilityState !== 'visible') return;
    const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
    try {
      const snapshotBefore = lastSnapshot;
      const changed = await loadDiscussion();
      if (changed && typing) lastSnapshot = snapshotBefore; // redraw on a later pass, not mid-typing
      else if (changed) render();
    } catch (err) {
      console.error(err);
    }
  }, POLL_MS);
}
