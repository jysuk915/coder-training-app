// Reliability statistics for one variable.
//
// Input everywhere: `units`, a list with one entry per item. Each entry is the
// list of category values given to that item by the coders who coded it
// (missing codes are simply left out). Example for 3 coders, 2 items:
//   [['a', 'a', 'b'], ['b', 'b']]      // third coder skipped item 2

// Krippendorff's alpha for nominal data, any number of coders, missing data
// allowed. Follows Krippendorff (2011), "Computing Krippendorff's
// Alpha-Reliability": build the coincidence matrix from every pairable unit
// (items with at least two codes), then alpha = 1 - Do / De.
//
// Returns alpha = null when it cannot be computed: no item has two codes, or
// every code is the same category (no variation, so De = 0).
export function krippendorffAlphaNominal(units) {
  const coincidence = new Map(); // "c|k" -> o_ck
  const totals = new Map(); // c -> n_c
  let n = 0; // total pairable values
  let pairableUnits = 0;

  for (const values of units) {
    const m = values.length;
    if (m < 2) continue; // a single code cannot be compared with anything
    pairableUnits++;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    for (const [c, nc] of counts) {
      for (const [k, nk] of counts) {
        const pairs = c === k ? nc * (nc - 1) : nc * nk;
        if (pairs === 0) continue;
        const key = `${c}|${k}`;
        coincidence.set(key, (coincidence.get(key) || 0) + pairs / (m - 1));
      }
      totals.set(c, (totals.get(c) || 0) + nc);
    }
    n += m;
  }

  const base = { pairableUnits, pairableValues: n, categoryTotals: Object.fromEntries(totals) };
  if (n < 2) return { alpha: null, reason: 'No item was coded by two or more coders.', ...base };

  let observed = 0; // sum of off-diagonal coincidences
  for (const [key, o] of coincidence) {
    const [c, k] = key.split('|');
    if (c !== k) observed += o;
  }
  let expected = 0; // sum over c != k of n_c * n_k
  for (const [c, nc] of totals) for (const [k, nk] of totals) if (c !== k) expected += nc * nk;

  if (expected === 0) {
    return { alpha: null, reason: 'Every code is the same category, so alpha cannot be computed.', ...base };
  }
  const Do = observed / n;
  const De = expected / (n * (n - 1));
  return { alpha: 1 - Do / De, observedDisagreement: Do, expectedDisagreement: De, ...base };
}

// Percent agreement, two ways:
// - pairwise: of all pairs of coders who both coded an item, the share that chose the same category
// - unanimous: number of items where every coder who coded it chose the same category
export function percentAgreement(units) {
  let pairs = 0;
  let agreeing = 0;
  let pairableUnits = 0;
  let unanimousUnits = 0;
  for (const values of units) {
    const m = values.length;
    if (m < 2) continue;
    pairableUnits++;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    if (counts.size === 1) unanimousUnits++;
    pairs += (m * (m - 1)) / 2;
    for (const nc of counts.values()) agreeing += (nc * (nc - 1)) / 2;
  }
  return { pairwise: pairs > 0 ? agreeing / pairs : null, pairableUnits, unanimousUnits };
}

// Everything the app reports for one variable in one round.
export function variableReliability(units, target) {
  const a = krippendorffAlphaNominal(units);
  const p = percentAgreement(units);
  return {
    alpha: a.alpha,
    alphaReason: a.reason || null,
    pctAgreement: p.pairwise,
    nItems: p.pairableUnits,
    nUnanimous: p.unanimousUnits,
    categoryTotals: a.categoryTotals,
    // round before comparing so that an alpha shown as .80 passes a .80 target
    passed: a.alpha !== null && Math.round(a.alpha * 1000) / 1000 >= target,
  };
}
