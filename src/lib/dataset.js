// Helpers for turning an uploaded CSV into items (id + text).

export function guessColumns(fields) {
  const find = (patterns) =>
    fields.find((f) => patterns.some((p) => p.test(f.trim()))) || null;
  const idCol = find([/^id$/i, /_id$/i, /^id_/i, /id$/i]);
  const textCol =
    find([/^text$/i, /^(content|body|post|message|tweet|comment|caption)$/i, /text/i]) ||
    fields.find((f) => f !== idCol) ||
    null;
  return { idCol: idCol || fields[0] || null, textCol };
}

// Returns the usable items plus counts of rows that were skipped and why.
export function prepareItems(rows, idCol, textCol) {
  const items = [];
  const seen = new Set();
  const skipped = { missingId: 0, missingText: 0, duplicateId: 0 };
  rows.forEach((row) => {
    const id = String(row[idCol] ?? '').trim();
    const text = String(row[textCol] ?? '').trim();
    if (!id) return void skipped.missingId++;
    if (!text) return void skipped.missingText++;
    if (seen.has(id)) return void skipped.duplicateId++;
    seen.add(id);
    items.push({ ext_id: id, text });
  });
  return { items, skipped };
}
