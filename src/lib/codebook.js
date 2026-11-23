// Codebook shape (stored as JSON, one snapshot per version). Every variable
// uses the same layout:
//
// { variables: [ {
//     key, name,
//     instructions,                      // optional: rules for the whole variable
//     categories: [ { key, name, definition, examples: [..] } ],   // at least two
//     worked_examples: [ { text, code, reason } ]                   // optional; code = a category key
// } ] }
//
// Keys are stable ids. They are created once from the name and never change
// when a name is edited, so codes from different rounds stay comparable.

export function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'item';
}

function uniqueKey(base, taken) {
  let key = base;
  let i = 2;
  while (taken.has(key)) key = `${base}_${i++}`;
  taken.add(key);
  return key;
}

// Give a key to every named variable and category that lacks one.
// Changes the codebook in place (the editor relies on this) and returns it.
export function assignKeys(codebook) {
  const vars = codebook.variables || [];
  const varKeys = new Set(vars.map((v) => v.key).filter(Boolean));
  for (const v of vars) {
    if (!v.key && String(v.name || '').trim()) v.key = uniqueKey(slugify(v.name), varKeys);
    const cats = v.categories || [];
    const catKeys = new Set(cats.map((c) => c.key).filter(Boolean));
    for (const c of cats) {
      if (!c.key && String(c.name || '').trim()) c.key = uniqueKey(slugify(c.name), catKeys);
    }
  }
  return codebook;
}

// Returns a clean copy: trimmed text, keys assigned, empty examples dropped.
export function normalizeCodebook(codebook) {
  const copy = assignKeys(JSON.parse(JSON.stringify({ variables: codebook.variables || [] })));
  return {
    variables: copy.variables.map((v) => ({
      key: v.key || '',
      name: String(v.name || '').trim(),
      instructions: String(v.instructions ?? v.description ?? '').trim(),
      categories: (v.categories || []).map((c) => ({
        key: c.key || '',
        name: String(c.name || '').trim(),
        definition: String(c.definition || '').trim(),
        examples: (c.examples || []).map((e) => String(e).trim()).filter(Boolean),
      })),
      worked_examples: (v.worked_examples || [])
        .map((w) => ({
          text: String(w.text || '').trim(),
          code: String(w.code || ''),
          reason: String(w.reason || '').trim(),
        }))
        .filter((w) => w.text),
    })),
  };
}

// Returns a list of plain-language problems; empty means ready to use.
export function validateCodebook(codebook) {
  const problems = [];
  const vars = codebook.variables || [];
  if (vars.length === 0) problems.push('Add at least one variable.');
  const seenVars = new Set();
  const seenVarKeys = new Set();
  vars.forEach((v, i) => {
    const label = v.name || `Variable ${i + 1}`;
    if (!v.name) problems.push(`Variable ${i + 1} needs a name.`);
    const lower = (v.name || '').toLowerCase();
    if (lower && seenVars.has(lower)) problems.push(`Two variables are named "${v.name}".`);
    seenVars.add(lower);
    if (v.key && seenVarKeys.has(v.key)) problems.push(`Two variables share the key "${v.key}".`);
    seenVarKeys.add(v.key);
    const cats = v.categories || [];
    if (cats.length < 2) problems.push(`"${label}" needs at least two categories.`);
    const seenCats = new Set();
    const seenCatKeys = new Set();
    cats.forEach((c, j) => {
      if (!c.name) problems.push(`"${label}": category ${j + 1} needs a name.`);
      const cl = (c.name || '').toLowerCase();
      if (cl && seenCats.has(cl)) problems.push(`"${label}" has two categories named "${c.name}".`);
      seenCats.add(cl);
      if (c.key && seenCatKeys.has(c.key)) problems.push(`"${label}" has two categories with the key "${c.key}".`);
      if (c.key) seenCatKeys.add(c.key);
    });
    (v.worked_examples || []).forEach((w, j) => {
      if (w.text && !seenCatKeys.has(w.code)) problems.push(`"${label}": worked example ${j + 1} needs a code.`);
    });
  });
  return problems;
}

export const CODEBOOK_CSV_COLUMNS = ['variable', 'instructions', 'category', 'definition', 'examples'];

// CSV format: one row per category. Examples are separated by " | ".
// Worked examples do not fit this table; use the JSON format to move them.
export function codebookFromCsvRows(rows) {
  const lower = (row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const byName = new Map();
  for (const raw of rows) {
    const row = lower(raw);
    const vname = String(row.variable || '').trim();
    const cname = String(row.category || '').trim();
    if (!vname && !cname) continue;
    if (!vname || !cname) {
      throw new Error('Every row of a codebook CSV needs both a "variable" and a "category".');
    }
    if (!byName.has(vname)) byName.set(vname, { name: vname, instructions: '', categories: [] });
    const v = byName.get(vname);
    const instructions = row.instructions ?? row.variable_description;
    if (!v.instructions && instructions) v.instructions = String(instructions).trim();
    v.categories.push({
      name: cname,
      definition: String(row.definition || '').trim(),
      examples: String(row.examples || '').split('|').map((e) => e.trim()).filter(Boolean),
    });
  }
  if (byName.size === 0) {
    throw new Error(`No rows found. The CSV needs these columns: ${CODEBOOK_CSV_COLUMNS.join(', ')}.`);
  }
  return normalizeCodebook({ variables: [...byName.values()] });
}

export function codebookToCsvRows(codebook) {
  const rows = [];
  for (const v of codebook.variables || []) {
    (v.categories || []).forEach((c, i) => {
      rows.push({
        variable: v.name,
        instructions: i === 0 ? v.instructions || '' : '',
        category: c.name,
        definition: c.definition || '',
        examples: (c.examples || []).join(' | '),
      });
    });
  }
  return rows;
}

// Accepts the app's own JSON export (with or without the wrapper object).
export function codebookFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const cb = parsed.codebook || parsed;
  if (!cb || !Array.isArray(cb.variables)) {
    throw new Error('This JSON file does not look like a codebook (no "variables" list).');
  }
  return normalizeCodebook(cb);
}
