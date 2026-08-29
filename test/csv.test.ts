import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/lib/csv.ts';

test('parses quoted fields with commas and escaped quotes', () => {
  const rows = parseCsv('"a,b","c"\n"x""y","z"');
  assert.deepEqual(rows, [['a,b', 'c'], ['x"y', 'z']]);
});

test('strips a UTF-8 BOM and handles CRLF', () => {
  const rows = parseCsv('﻿h1,h2\r\nv1,v2\r\n');
  assert.deepEqual(rows, [['h1', 'h2'], ['v1', 'v2']]);
});

test('keeps newlines inside quotes', () => {
  const rows = parseCsv('"line1\nline2",b');
  assert.deepEqual(rows, [['line1\nline2', 'b']]);
});
