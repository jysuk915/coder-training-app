// Krippendorff's alpha checked against published reference values.
import { describe, it, expect } from 'vitest';
import { krippendorffAlphaNominal, percentAgreement, variableReliability } from '../src/lib/alpha.js';

// Turn a coder-by-item table (rows = coders, '.' or '*' = missing) into units.
function unitsFrom(rows) {
  const table = rows.map((r) => r.trim().split(/\s+/));
  const nItems = table[0].length;
  for (const r of table) expect(r.length).toBe(nItems);
  return Array.from({ length: nItems }, (_, i) => table.map((r) => r[i]).filter((v) => v !== '.' && v !== '*'));
}
const alpha = (rows) => krippendorffAlphaNominal(unitsFrom(rows)).alpha;

describe("Krippendorff's alpha (nominal) against reference values", () => {
  // Krippendorff (2011), Computing Krippendorff's Alpha-Reliability, section A:
  // binary data, two observers, no missing data. Published alpha = 0.095.
  it('Krippendorff 2011, example A: binary, two coders -> 0.095', () => {
    const a = alpha([
      '0 1 0 0 0 0 0 0 1 0',
      '1 1 1 0 0 1 0 0 0 0',
    ]);
    expect(a).toBeCloseTo(0.095, 3);
  });

  // Same paper, section B: nominal data, two observers, no missing data.
  // Published alpha = 0.692.
  it('Krippendorff 2011, example B: nominal, two coders -> 0.692', () => {
    const a = alpha([
      'a a b b d c c c e d d a',
      'b a b b b c c c e d d d',
    ]);
    expect(a).toBeCloseTo(0.692, 3);
  });

  // Same paper, section C: nominal data, four observers, missing data.
  // Published alpha = 0.743. Unit 12 has one value and is not pairable.
  it('Krippendorff 2011, example C: four coders with missing data -> 0.743', () => {
    const rows = [
      '1 2 3 3 2 1 4 1 2 . . .',
      '1 2 3 3 2 2 4 1 2 5 . 3',
      '. 3 3 3 2 3 4 2 2 5 1 .',
      '1 2 3 3 2 4 4 1 2 5 1 .',
    ];
    const result = krippendorffAlphaNominal(unitsFrom(rows));
    expect(result.alpha).toBeCloseTo(0.743, 3);
    expect(result.pairableUnits).toBe(11);
    expect(result.pairableValues).toBe(40);
    // intermediate values printed in the paper: n_1..n_5 = 9, 13, 10, 5, 3
    expect(result.categoryTotals).toEqual({ 1: 9, 2: 13, 3: 10, 4: 5, 5: 3 });
  });

  // The worked example in the Wikipedia article "Krippendorff's alpha":
  // three coders, 15 units, heavy missing data. Published nominal alpha = 0.691.
  it('Wikipedia worked example: three coders, 15 units -> 0.691', () => {
    const a = alpha([
      '* * * * * 3 4 1 2 1 1 3 3 * 3',
      '1 * 2 1 3 3 4 3 * * * * * * *',
      '* * 2 1 3 4 4 * 2 1 1 3 3 * 4',
    ]);
    expect(a).toBeCloseTo(0.691, 3);
  });
});

describe("Krippendorff's alpha: properties and edge cases", () => {
  it('perfect agreement with variation is 1', () => {
    expect(alpha(['a b a b c', 'a b a b c', 'a b a b c'])).toBeCloseTo(1, 10);
  });

  it('systematic disagreement is negative', () => {
    expect(alpha(['a b a b', 'b a b a'])).toBeLessThan(0);
  });

  it('does not depend on the order of coders, items, or category labels', () => {
    const base = alpha(['1 2 3 3 2 1 4 1 2 . . .', '1 2 3 3 2 2 4 1 2 5 . 3', '. 3 3 3 2 3 4 2 2 5 1 .', '1 2 3 3 2 4 4 1 2 5 1 .']);
    const coderShuffled = alpha(['1 2 3 3 2 4 4 1 2 5 1 .', '. 3 3 3 2 3 4 2 2 5 1 .', '1 2 3 3 2 1 4 1 2 . . .', '1 2 3 3 2 2 4 1 2 5 . 3']);
    const relabeled = alpha(['p q r r q p s p q . . .', 'p q r r q q s p q t . r', '. r r r q r s q q t p .', 'p q r r q s s p q t p .']);
    expect(coderShuffled).toBeCloseTo(base, 12);
    expect(relabeled).toBeCloseTo(base, 12);
    const units = unitsFrom(['1 2 3 3 2 1', '1 2 3 3 2 2']);
    expect(krippendorffAlphaNominal([...units].reverse()).alpha).toBeCloseTo(krippendorffAlphaNominal(units).alpha, 12);
  });

  it('items with fewer than two codes are ignored', () => {
    const withSingles = krippendorffAlphaNominal([['a', 'a'], ['b', 'b'], ['a', 'b'], ['a'], []]);
    const without = krippendorffAlphaNominal([['a', 'a'], ['b', 'b'], ['a', 'b']]);
    expect(withSingles.alpha).toBeCloseTo(without.alpha, 12);
    expect(withSingles.pairableUnits).toBe(3);
  });

  it('cannot be computed when every code is the same category', () => {
    const r = krippendorffAlphaNominal([['a', 'a'], ['a', 'a', 'a']]);
    expect(r.alpha).toBeNull();
    expect(r.reason).toMatch(/same category/);
  });

  it('cannot be computed when nothing is pairable', () => {
    expect(krippendorffAlphaNominal([]).alpha).toBeNull();
    expect(krippendorffAlphaNominal([['a'], ['b']]).alpha).toBeNull();
  });

  it('matches direct pair counting for a complete table with three coders', () => {
    // Written independently of the coincidence-matrix code: count mismatching
    // pairs within items (each weighted 1/(m-1)) and mismatching pairs overall.
    const units = unitsFrom(['1 2 3 3 2 1 4 1 2 5', '1 2 3 3 2 2 4 1 2 5', '1 3 3 3 2 3 4 2 2 5']);
    let n = 0;
    let within = 0;
    const all = [];
    for (const u of units) {
      n += u.length;
      all.push(...u);
      for (let i = 0; i < u.length; i++) for (let j = 0; j < u.length; j++) if (i !== j && u[i] !== u[j]) within += 1 / (u.length - 1);
    }
    let overall = 0;
    for (let i = 0; i < all.length; i++) for (let j = 0; j < all.length; j++) if (i !== j && all[i] !== all[j]) overall++;
    const direct = 1 - (within / n) / (overall / (n * (n - 1)));
    expect(krippendorffAlphaNominal(units).alpha).toBeCloseTo(direct, 12);
    expect(direct).toBeCloseTo(0.702346, 6);
  });

  it('matches a hand calculation for two coders, two categories', () => {
    // 4 items: aa, bb, ab, aa. Values: a = 5, b = 3, n = 8.
    // Do = 2 mismatching coincidences / 8 = 0.25
    // De = (5*3 + 3*5) / (8*7) = 30/56
    // alpha = 1 - 0.25 / (30/56) = 1 - 14/30 = 0.5333...
    expect(alpha(['a b a a', 'a b b a'])).toBeCloseTo(1 - 14 / 30, 12);
  });
});

describe('percent agreement', () => {
  it('counts agreeing pairs and unanimous items', () => {
    // item 1: aab -> 1 of 3 pairs agree; item 2: bbb -> 3 of 3; item 3: ab -> 0 of 1; item 4: single, ignored
    const p = percentAgreement([['a', 'a', 'b'], ['b', 'b', 'b'], ['a', 'b'], ['a']]);
    expect(p.pairwise).toBeCloseTo(4 / 7, 12);
    expect(p.pairableUnits).toBe(3);
    expect(p.unanimousUnits).toBe(1);
  });

  it('for two coders it is the share of items coded the same', () => {
    expect(percentAgreement(unitsFrom(['0 1 0 0 0 0 0 0 1 0', '1 1 1 0 0 1 0 0 0 0'])).pairwise).toBeCloseTo(0.6, 12);
  });

  it('is null when nothing is pairable', () => {
    expect(percentAgreement([['a']]).pairwise).toBeNull();
  });
});

describe('pass or fail against the target', () => {
  it('passes at or above the target and fails below or when alpha is undefined', () => {
    const perfect = [['a', 'a'], ['b', 'b']];
    expect(variableReliability(perfect, 0.8).passed).toBe(true);
    expect(variableReliability(unitsFrom(['a a b b d c c c e d d a', 'b a b b b c c c e d d d']), 0.8).passed).toBe(false);
    expect(variableReliability(unitsFrom(['a a b b d c c c e d d a', 'b a b b b c c c e d d d']), 0.69).passed).toBe(true);
    expect(variableReliability([['a', 'a'], ['a', 'a']], 0.8)).toMatchObject({ alpha: null, passed: false, pctAgreement: 1 });
  });
});

// Independent check: 40 random tables with missing data, alpha computed by
// the R package irr (see tests/fixtures/make_alpha_fixtures.R).
describe("Krippendorff's alpha against R's irr package", async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync('tests/fixtures/alpha_irr.json', 'utf8'));
  it(`matches ${fixture.cases.length} random tables from ${fixture.source}`, () => {
    expect(fixture.cases.length).toBe(40);
    for (const c of fixture.cases) {
      const nItems = c.table[0].length;
      const units = Array.from({ length: nItems }, (_, i) => c.table.map((row) => row[i]).filter((v) => v !== null));
      expect(krippendorffAlphaNominal(units).alpha).toBeCloseTo(c.alpha, 9);
    }
  });
});
