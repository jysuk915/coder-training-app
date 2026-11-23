import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import {
  slugify, assignKeys, normalizeCodebook, validateCodebook, codebookFromCsvRows, codebookToCsvRows, codebookFromJson,
} from '../src/lib/codebook.js';
import { guessColumns, prepareItems } from '../src/lib/dataset.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const parse = (text) => Papa.parse(text, { header: true, skipEmptyLines: true });

describe('codebook', () => {
  it('makes readable keys', () => {
    expect(slugify('Primary Frame (main)')).toBe('primary_frame_main');
    expect(slugify('***')).toBe('item');
  });

  it('keeps existing keys and gives unique keys to new named entries', () => {
    const cb = normalizeCodebook({
      variables: [
        { key: 'tone', name: 'Renamed tone', categories: [{ key: 'pos', name: 'Positive!' }, { name: 'Pos' }, { name: 'Pos' }, { name: '' }] },
        { name: 'Tone', categories: [] },
      ],
    });
    expect(cb.variables.map((v) => v.key)).toEqual(['tone', 'tone_2']);
    expect(cb.variables[0].categories.map((c) => c.key)).toEqual(['pos', 'pos_2', 'pos_3', '']);
  });

  it('assignKeys fills in keys in place without touching existing ones', () => {
    const draft = { variables: [{ name: 'Stance', categories: [{ key: 'x', name: 'Support' }, { name: 'Oppose' }, { name: ' ' }] }] };
    assignKeys(draft);
    expect(draft.variables[0].key).toBe('stance');
    expect(draft.variables[0].categories.map((c) => c.key)).toEqual(['x', 'oppose', undefined]);
  });

  it('reads the older "description" field as instructions', () => {
    const cb = normalizeCodebook({ variables: [{ name: 'A', description: 'Old text', categories: [] }] });
    expect(cb.variables[0].instructions).toBe('Old text');
    expect(cb.variables[0].worked_examples).toEqual([]);
  });

  it('explains what is missing', () => {
    expect(validateCodebook({ variables: [] })).toEqual(['Add at least one variable.']);
    const problems = validateCodebook(normalizeCodebook({ variables: [{ name: 'Tone', categories: [{ name: 'Only one' }] }] }));
    expect(problems).toEqual(['"Tone" needs at least two categories.']);
  });

  it('flags worked examples without a valid code and drops empty ones', () => {
    const cb = normalizeCodebook({ variables: [{ name: 'Tone', categories: [{ name: 'Pos' }, { name: 'Neg' }],
      worked_examples: [{ text: 'Great!', code: 'pos', reason: 'Praise' }, { text: 'Hmm', code: 'gone' }, { text: '  ', code: 'pos' }] }] });
    expect(cb.variables[0].worked_examples).toHaveLength(2);
    expect(validateCodebook(cb)).toEqual(['"Tone": worked example 2 needs a code.']);
  });

  it('round-trips through CSV and JSON', () => {
    const cb = codebookFromCsvRows(parse(read('../sample/sample_codebook.csv')).data);
    expect(validateCodebook(cb)).toEqual([]);
    expect(cb.variables[0].instructions).toContain('\n- Sarcasm counts');
    const again = codebookFromCsvRows(codebookToCsvRows(cb));
    expect(again).toEqual(cb);
    expect(codebookFromJson(JSON.stringify({ codebook: cb }))).toEqual(cb);
  });

  it('the sample JSON matches the sample CSV and adds worked examples', () => {
    const fromCsv = codebookFromCsvRows(parse(read('../sample/sample_codebook.csv')).data);
    const fromJson = codebookFromJson(read('../sample/sample_codebook.json'));
    expect(validateCodebook(fromJson)).toEqual([]);
    expect(fromJson.variables.map((v) => v.worked_examples.length)).toEqual([3, 2, 2]);
    const strip = (cb) => ({ variables: cb.variables.map((v) => ({ ...v, worked_examples: [] })) });
    expect(strip(fromJson)).toEqual(fromCsv);
  });

  it('worked examples in the sample are not items from the sample dataset', () => {
    const fromJson = codebookFromJson(read('../sample/sample_codebook.json'));
    const texts = new Set(parse(read('../sample/sample_dataset.csv')).data.map((r) => r.text));
    for (const v of fromJson.variables) for (const w of v.worked_examples) expect(texts.has(w.text)).toBe(false);
  });
});

describe('dataset', () => {
  it('guesses the id, text, and group columns', () => {
    expect(guessColumns(['post_id', 'platform', 'text'])).toEqual({ idCol: 'post_id', textCol: 'text', groupCol: 'platform' });
    expect(guessColumns(['ID', 'Body'])).toEqual({ idCol: 'ID', textCol: 'Body', groupCol: null });
  });

  it('skips rows with a missing or repeated id, or no text', () => {
    const { items, skipped } = prepareItems(
      [{ a: '1', b: 'x' }, { a: '1', b: 'again' }, { a: '', b: 'y' }, { a: '2', b: '  ' }, { a: '3', b: 'z' }], 'a', 'b');
    expect(items).toEqual([{ ext_id: '1', text: 'x' }, { ext_id: '3', text: 'z' }]);
    expect(skipped).toEqual({ missingId: 1, missingText: 1, duplicateId: 1 });
  });

  it('attaches a group when a group column is chosen', () => {
    const { items, noGroup } = prepareItems(
      [{ a: '1', b: 'x', g: ' FB ' }, { a: '2', b: 'y', g: 'YT' }, { a: '3', b: 'z', g: '' }], 'a', 'b', 'g');
    expect(items).toEqual([
      { ext_id: '1', text: 'x', group_label: 'FB' }, { ext_id: '2', text: 'y', group_label: 'YT' }, { ext_id: '3', text: 'z', group_label: null }]);
    expect(noGroup).toBe(1);
  });

  it('the sample dataset is clean: 60 unique items', () => {
    const { data, meta } = parse(read('../sample/sample_dataset.csv'));
    const cols = guessColumns(meta.fields);
    const { items, skipped } = prepareItems(data, cols.idCol, cols.textCol);
    expect(items.length).toBe(60);
    expect(skipped).toEqual({ missingId: 0, missingText: 0, duplicateId: 0 });
    expect(cols.groupCol).toBeNull();
  });
});
