import { supabase, unwrap, fetchAll } from '../supabase.js';

export const codeKey = (itemId, variableKey) => `${itemId}|${variableKey}`;

// The coder slot this browser holds in a session, plus the session's rounds.
export async function loadCoderContext(sessionId) {
  const slots = unwrap(await supabase.rpc('my_coder_slots'));
  const slot = slots.find((s) => s.session_id === sessionId);
  if (!slot) return null;
  const rounds = unwrap(await supabase.from('rounds').select('*').eq('session_id', sessionId).order('round_no'));
  return { slot, rounds, openRound: rounds.find((r) => r.status === 'open') || null };
}

// Everything a coder needs to work on one round: codebook, batch, own codes.
export async function loadRound(round, coderId) {
  const codebookRow = unwrap(await supabase.from('codebook_versions')
    .select('version, content').eq('id', round.codebook_version_id).single());
  const batch = unwrap(await supabase.from('round_items')
    .select('position, items(id, ext_id, text)').eq('round_id', round.id).order('position'));
  const codeRows = await fetchAll(() => supabase.from('codes')
    .select('item_id, variable_key, category_key, unsure')
    .eq('round_id', round.id).eq('coder_id', coderId).order('item_id').order('variable_key'));
  const submission = unwrap(await supabase.from('submissions')
    .select('submitted_at').eq('round_id', round.id).eq('coder_id', coderId).maybeSingle());

  const codes = new Map(codeRows.map((c) => [codeKey(c.item_id, c.variable_key), { category_key: c.category_key, unsure: c.unsure }]));
  return {
    codebook: codebookRow.content,
    codebookVersion: codebookRow.version,
    items: batch.map((b) => b.items).filter(Boolean),
    codes,
    submittedAt: submission?.submitted_at || null,
  };
}

// How many items have a code for every variable.
export function countComplete(items, variables, codes) {
  return items.filter((it) => variables.every((v) => codes.has(codeKey(it.id, v.key)))).length;
}
