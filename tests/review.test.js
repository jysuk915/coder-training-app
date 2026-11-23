import { describe, it, expect } from 'vitest';
import {
  indexCodes, unitsFor, buildCards, sortDisagreements, confusionGrid, consensusCode, coderDeviation, roundReliability, reliabilityRows,
} from '../src/lib/review.js';

const coders = [{ id: 'cA', label: 'A' }, { id: 'cB', label: 'B' }, { id: 'cC', label: 'C' }];
const variable = { key: 'frame', name: 'Frame', categories: [{ key: 'x', name: 'X' }, { key: 'y', name: 'Y' }, { key: 'z', name: 'Z' }] };
const items = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'].map((id) => ({ id, ext_id: id.toUpperCase(), text: id }));
// rows: item, then the code of A, B, C ('.' = not coded, '?' suffix = unsure)
const table = {
  i1: ['x', 'x', 'x'],   // unanimous
  i2: ['x', 'x', 'y'],   // majority, C odd one out
  i3: ['x', 'y', 'z'],   // full split
  i4: ['y', 'x?', 'x'],  // majority, A odd one out, someone unsure
  i5: ['x', 'y', '.'],   // two coders, 1-1 = full split
  i6: ['z', '.', '.'],   // single
  i7: ['.', '.', '.'],   // uncoded
};
const codes = [];
for (const [item, row] of Object.entries(table)) {
  row.forEach((cell, i) => {
    if (cell === '.') return;
    codes.push({ item_id: item, coder_id: coders[i].id, variable_key: 'frame', category_key: cell.replace('?', ''), unsure: cell.endsWith('?') });
  });
}
const index = indexCodes(codes);
const cards = buildCards(items, variable, index, coders);
const byId = Object.fromEntries(cards.map((c) => [c.item.id, c]));

describe('cards', () => {
  it('classifies each item', () => {
    expect(cards.map((c) => c.kind)).toEqual(['unanimous', 'majority', 'full', 'majority', 'full', 'single', 'uncoded']);
    expect(byId.i2.majority).toBe('x');
    expect(byId.i2.dissenters.map((d) => d.label)).toEqual(['C']);
    expect(byId.i4.dissenters.map((d) => d.label)).toEqual(['A']);
    expect(byId.i4.anyUnsure).toBe(true);
    expect(byId.i3.disputed).toEqual(['x', 'y', 'z']);
    expect(byId.i1.unanimousCode).toBe('x');
  });

  it('gives alpha the right units', () => {
    expect(unitsFor(items, 'frame', index)).toEqual([['x', 'x', 'x'], ['x', 'x', 'y'], ['x', 'y', 'z'], ['y', 'x', 'x'], ['x', 'y'], ['z'], []]);
  });

  it('sorts full splits first, then unsure, then by odd one out', () => {
    expect(sortDisagreements(cards).map((c) => c.item.id)).toEqual(['i3', 'i5', 'i4', 'i2']);
    // without the unsure flag, A's odd-one-out card still comes before C's
    const calm = buildCards(items, variable, indexCodes(codes.map((c) => ({ ...c, unsure: false }))), coders);
    expect(sortDisagreements(calm).map((c) => c.item.id)).toEqual(['i3', 'i5', 'i4', 'i2']);
    const swapped = buildCards(items, variable, indexCodes(codes.map((c) => ({ ...c, unsure: c.item_id === 'i2' }))), coders);
    expect(sortDisagreements(swapped).map((c) => c.item.id)).toEqual(['i3', 'i5', 'i2', 'i4']);
  });

  it('counts which category pairs were mixed up', () => {
    const grid = confusionGrid(cards, variable.categories);
    expect(grid.x.y).toBe(4); // i2, i3, i4, i5
    expect(grid.y.x).toBe(4);
    expect(grid.x.z).toBe(1); // i3
    expect(grid.y.z).toBe(1);
    expect(grid.x.x).toBe(1); // i1 unanimous
    expect(grid.z.z).toBe(0);
  });
});

describe('consensus and coder deviation', () => {
  const consensus = { i2: { status: 'resolved', category_key: 'y' }, i3: { status: 'open', category_key: 'x' } };
  const of = (card) => consensusCode(card, consensus[card.item.id]);

  it('uses the resolved pick, else the unanimous code, else nothing', () => {
    expect(of(byId.i1)).toBe('x');
    expect(of(byId.i2)).toBe('y');
    expect(of(byId.i3)).toBeNull(); // reopened, not resolved
    expect(of(byId.i4)).toBeNull();
  });

  it('counts each coder against consensus', () => {
    const rows = Object.fromEntries(coderDeviation(cards, coders, of).map((r) => [r.coder.label, r]));
    // comparable items: i1 (x) and i2 (resolved y)
    expect(rows.A).toMatchObject({ coded: 6, comparable: 2, differs: 1, oddOneOut: 1, unsure: 0 });
    expect(rows.B).toMatchObject({ coded: 5, comparable: 2, differs: 1, oddOneOut: 0, unsure: 1 });
    expect(rows.C).toMatchObject({ coded: 4, comparable: 2, differs: 0, oddOneOut: 1, unsure: 0 });
  });
});

describe('round reliability', () => {
  it('reports per variable and puts failing variables first', () => {
    const easy = { key: 'easy', name: 'Easy', categories: [{ key: 'p' }, { key: 'q' }] };
    const more = [...codes];
    items.slice(0, 4).forEach((it, i) => coders.forEach((c) =>
      more.push({ item_id: it.id, coder_id: c.id, variable_key: 'easy', category_key: i % 2 ? 'p' : 'q', unsure: false })));
    const stats = roundReliability(items, [easy, variable], indexCodes(more), 0.8);
    expect(stats.map((s) => s.variable.key)).toEqual(['frame', 'easy']);
    expect(stats[1]).toMatchObject({ alpha: 1, passed: true, nItems: 4, nUnanimous: 4, nCoders: 3, nDisagreements: 0 });
    expect(stats[0]).toMatchObject({ passed: false, nItems: 5, nUnanimous: 1, nCoders: 3, nDisagreements: 4 });
    expect(stats[0].alpha).toBeLessThan(0.3);
    const rows = reliabilityRows('r1', stats);
    expect(rows[1]).toEqual({ round_id: 'r1', variable_key: 'easy', n_items: 4, n_coders: 3, pct_agreement: 1, alpha: 1, passed: true });
  });
});
