import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import {
  slugify, normalizeCodebook, validateCodebook, codebookFromCsvRows, codebookToCsvRows, codebookFromJson,
} from '../src/lib/codebook.js';
import { guessColumns, prepareItems } from '../src/lib/dataset.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const parse = (text) => Papa.parse(text, { header: true, skipEmptyLines: true });

describe('codebook', () => {
  it('makes readable keys', () => {
    expect(slugify('Primary Frame (main)')).toBe('primary_frame_main');
    expect(slugify('***')).toBe('item');
  });

  it('keeps existing keys and gives unique keys to new entries', () => {
    const cb = normalizeCodebook({
      variables: [
        { key: 'tone', name: 'Renamed tone', categories: [{ key: 'pos', name: 'Positive!' }, { name: 'Pos' }, { name: 'Pos' }] },
        { name: 'Tone', categories: [] },
      ],
    });
    expect(cb.variables.map((v) => v.key)).toEqual(['tone', 'tone_2']);
    expect(cb.variables[0].categories.map((c) => c.key)).toEqual(['pos', 'pos_2', 'pos_3']);
  });

  it('explains what is missing', () => {
    expect(validateCodebook({ variables: [] })).toEqual(['Add at least one variable.']);
    const problems = validateCodebook(normalizeCodebook({ variables: [{ name: 'Tone', categories: [{ name: 'Only one' }] }] }));
    expect(problems).toEqual(['"Tone" needs at least two categories.']);
  });

  it('round-trips through CSV and JSON', () => {
    const cb = codebookFromCsvRows(parse(read('../sample/sample_codebook.csv')).data);
    expect(validateCodebook(cb)).toEqual([]);
    const again = codebookFromCsvRows(codebookToCsvRows(cb));
    expect(again).toEqual(cb);
    expect(codebookFromJson(JSON.stringify({ codebook: cb }))).toEqual(cb);
  });

  it('the sample JSON and CSV codebooks match', () => {
    const fromCsv = codebookFromCsvRows(parse(read('../sample/sample_codebook.csv')).data);
    const fromJson = codebookFromJson(read('../sample/sample_codebook.json'));
    expect(fromJson).toEqual(fromCsv);
    expect(fromCsv.variables.length).toBe(3);
  });
});

describe('dataset', () => {
  it('guesses the id and text columns', () => {
    expect(guessColumns(['post_id', 'platform', 'text'])).toEqual({ idCol: 'post_id', textCol: 'text' });
    expect(guessColumns(['ID', 'Body'])).toEqual({ idCol: 'ID', textCol: 'Body' });
  });

  it('skips rows with a missing or repeated id, or no text', () => {
    const { items, skipped } = prepareItems(
      [{ a: '1', b: 'x' }, { a: '1', b: 'again' }, { a: '', b: 'y' }, { a: '2', b: '  ' }, { a: '3', b: 'z' }], 'a', 'b');
    expect(items).toEqual([{ ext_id: '1', text: 'x' }, { ext_id: '3', text: 'z' }]);
    expect(skipped).toEqual({ missingId: 1, missingText: 1, duplicateId: 1 });
  });

  it('the sample dataset is clean: 60 unique items', () => {
    const { data, meta } = parse(read('../sample/sample_dataset.csv'));
    const cols = guessColumns(meta.fields);
    const { items, skipped } = prepareItems(data, cols.idCol, cols.textCol);
    expect(items.length).toBe(60);
    expect(skipped).toEqual({ missingId: 0, missingText: 0, duplicateId: 0 });
  });
});
