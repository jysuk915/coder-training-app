// Helpers for turning an uploaded CSV into items (id + text, optional group).

export function guessColumns(fields) {
  const find = (patterns) =>
    fields.find((f) => patterns.some((p) => p.test(f.trim()))) || null;
  const idCol = find([/^id$/i, /_id$/i, /^id_/i, /id$/i]);
  const textCol =
    find([/^text$/i, /^(content|body|post|message|tweet|comment|caption)$/i, /text/i]) ||
    fields.find((f) => f !== idCol) ||
    null;
  const groupCol = find([/^(group|platform|source)$/i]);
  return { idCol: idCol || fields[0] || null, textCol, groupCol: groupCol !== idCol && groupCol !== textCol ? groupCol : null };
}

// Returns the usable items plus counts of rows that were skipped and why.
// groupCol is optional; when given, each item carries a group_label
// (rows with an empty group cell get none).
export function prepareItems(rows, idCol, textCol, groupCol = null) {
  const items = [];
  const seen = new Set();
  const skipped = { missingId: 0, missingText: 0, duplicateId: 0 };
  let noGroup = 0;
  rows.forEach((row) => {
    const id = String(row[idCol] ?? '').trim();
    const text = String(row[textCol] ?? '').trim();
    if (!id) return void skipped.missingId++;
    if (!text) return void skipped.missingText++;
    if (seen.has(id)) return void skipped.duplicateId++;
    seen.add(id);
    const item = { ext_id: id, text };
    if (groupCol) {
      const g = String(row[groupCol] ?? '').trim();
      item.group_label = g || null;
      if (!g) noGroup++;
    }
    items.push(item);
  });
  return { items, skipped, noGroup };
}

// "FB 1,950, YT 1,950" from [{ group_label, n }]
export function describeGroups(counts, field) {
  return counts.map((c) => `${c.group_label || '(no group)'} ${Number(c[field]).toLocaleString()}`).join(', ');
}
