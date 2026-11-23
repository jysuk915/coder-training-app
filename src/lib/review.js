// Pure logic for the review screens: who coded what, where coders split,
// how to sort disagreements, and how far each coder is from consensus.
import { variableReliability } from './alpha.js';

const k = (itemId, variableKey) => `${itemId}|${variableKey}`;

// codes: [{ item_id, coder_id, variable_key, category_key, unsure }]
// -> Map "item|variable" -> Map coder_id -> { category_key, unsure }
export function indexCodes(codes) {
  const index = new Map();
  for (const c of codes) {
    const key = k(c.item_id, c.variable_key);
    if (!index.has(key)) index.set(key, new Map());
    index.get(key).set(c.coder_id, { category_key: c.category_key, unsure: !!c.unsure });
  }
  return index;
}

// The values each item received for one variable, in the shape alpha.js expects.
export function unitsFor(items, variableKey, index) {
  return items.map((it) => [...(index.get(k(it.id, variableKey))?.values() || [])].map((v) => v.category_key));
}

// One card per item for a variable.
// kind: 'unanimous' | 'majority' (one category has more than half the codes)
//     | 'full' (no category has more than half) | 'single' | 'uncoded'
export function buildCards(items, variable, index, coders) {
  const order = new Map(variable.categories.map((c, i) => [c.key, i]));
  return items.map((item, position) => {
    const byCoder = index.get(k(item.id, variable.key)) || new Map();
    const votes = coders.filter((c) => byCoder.has(c.id)).map((c) => ({ coder: c, ...byCoder.get(c.id) }));
    const counts = new Map();
    for (const v of votes) counts.set(v.category_key, (counts.get(v.category_key) || 0) + 1);
    let kind = 'uncoded';
    let majority = null;
    if (votes.length === 1) kind = 'single';
    else if (votes.length > 1) {
      if (counts.size === 1) kind = 'unanimous';
      else {
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top[1] > votes.length / 2) { kind = 'majority'; majority = top[0]; } else kind = 'full';
      }
    }
    return {
      item,
      position,
      variableKey: variable.key,
      votes,
      counts,
      kind,
      majority,
      unanimousCode: kind === 'unanimous' ? votes[0].category_key : null,
      dissenters: kind === 'majority' ? votes.filter((v) => v.category_key !== majority).map((v) => v.coder) : [],
      anyUnsure: votes.some((v) => v.unsure),
      disputed: [...counts.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99)),
      isDisagreement: kind === 'majority' || kind === 'full',
    };
  });
}

// Review order: full splits before majority splits; within each, cards where
// someone was unsure first; then grouped by who the odd one out was; then
// the order items appeared in the round.
export function sortDisagreements(cards) {
  const rank = (c) => (c.kind === 'full' ? 0 : 1);
  const odd = (c) => (c.dissenters.length === 1 ? c.dissenters[0].label : '~');
  return cards.filter((c) => c.isDisagreement).sort((a, b) =>
    rank(a) - rank(b)
    || Number(b.anyUnsure) - Number(a.anyUnsure)
    || odd(a).localeCompare(odd(b))
    || a.position - b.position);
}

// grid[c][k] = number of items where one coder chose c and another chose k.
// grid[c][c] = number of items where every coder chose c.
export function confusionGrid(cards, categories) {
  const grid = {};
  for (const c of categories) {
    grid[c.key] = {};
    for (const d of categories) grid[c.key][d.key] = 0;
  }
  for (const card of cards) {
    if (card.kind === 'unanimous') {
      if (grid[card.unanimousCode]) grid[card.unanimousCode][card.unanimousCode]++;
    } else if (card.isDisagreement) {
      for (const a of card.disputed) for (const b of card.disputed) {
        if (a !== b && grid[a] && b in grid[a]) grid[a][b]++;
      }
    }
  }
  return grid;
}

// The agreed code for a card: the trainer's resolved pick, or the code
// everyone gave. Unresolved disagreements have none (null).
export function consensusCode(card, consensusRow) {
  if (consensusRow && consensusRow.status === 'resolved' && consensusRow.category_key) return consensusRow.category_key;
  return card.unanimousCode;
}

// Per coder: how often their code differs from consensus.
// consensusOf(card) -> category key or null
export function coderDeviation(cards, coders, consensusOf) {
  const rows = new Map(coders.map((c) => [c.id, { coder: c, coded: 0, comparable: 0, differs: 0, oddOneOut: 0, unsure: 0 }]));
  for (const card of cards) {
    const agreed = consensusOf(card);
    for (const v of card.votes) {
      const r = rows.get(v.coder.id);
      if (!r) continue;
      r.coded++;
      if (v.unsure) r.unsure++;
      if (agreed !== null && agreed !== undefined) {
        r.comparable++;
        if (v.category_key !== agreed) r.differs++;
      }
    }
    if (card.dissenters.length === 1) rows.get(card.dissenters[0].id).oddOneOut++;
  }
  return [...rows.values()];
}

function statsFor(items, variable, index, target) {
  const units = unitsFor(items, variable.key, index);
  const stats = variableReliability(units, target);
  const coders = new Set();
  for (const it of items) for (const id of index.get(k(it.id, variable.key))?.keys() || []) coders.add(id);
  return { variable, ...stats, nCoders: coders.size, nDisagreements: stats.nItems - stats.nUnanimous };
}

// Reliability for every variable in a round, failing variables first.
export function roundReliability(items, variables, index, target) {
  return variables.map((variable) => statsFor(items, variable, index, target))
    .sort((a, b) => Number(a.passed) - Number(b.passed) || (a.alpha ?? -2) - (b.alpha ?? -2));
}

// The group names used by a round's items (empty when the dataset has no groups).
export function groupsOf(items) {
  return [...new Set(items.map((it) => it.group_label).filter(Boolean))].sort();
}

// Reliability per group: Map variable key -> [{ group, alpha, ... }], one entry per group.
export function groupReliability(items, variables, index, target) {
  const groups = groupsOf(items);
  const out = new Map();
  if (groups.length === 0) return out;
  for (const variable of variables) {
    out.set(variable.key, groups.map((group) => ({
      group,
      ...statsFor(items.filter((it) => it.group_label === group), variable, index, target),
    })));
  }
  return out;
}

// Rows for the reliability table in the database: one per variable for all
// items (group_label ''), plus one per variable and group.
export function reliabilityRows(roundId, stats, byGroup = new Map()) {
  const row = (s, group) => ({
    round_id: roundId,
    variable_key: s.variable.key,
    group_label: group,
    n_items: s.nItems,
    n_coders: s.nCoders,
    pct_agreement: s.pctAgreement,
    alpha: s.alpha,
    passed: s.passed,
  });
  return [
    ...stats.map((s) => row(s, '')),
    ...[...byGroup.values()].flatMap((list) => list.map((s) => row(s, s.group))),
  ];
}
