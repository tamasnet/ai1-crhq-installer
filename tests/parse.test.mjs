import assert from 'node:assert/strict';
import {
  normalizeTextBody, normalizeDescription, normalizeInstructions, normalizeFileText, textEqual,
} from '../scripts/lib/parse.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

console.log('normalizeTextBody:');

await test('strips BOM, leading/trailing newlines, normalizes CRLF', () => {
  assert.equal(normalizeTextBody('\uFEFF\r\n# Title\r\n'), '# Title');
  assert.equal(normalizeTextBody('\n\n# Title\n\n'), '# Title');
  assert.equal(normalizeTextBody('line one\n\nline two'), 'line one\n\nline two');
});

await test('preserves internal trailing spaces on lines', () => {
  assert.equal(normalizeTextBody('code   \nnext'), 'code   \nnext');
});

console.log('\nnormalizeDescription:');

await test('trims outer whitespace', () => {
  assert.equal(normalizeDescription('  hello  '), 'hello');
  assert.equal(normalizeDescription('\n spaced \n'), 'spaced');
});

console.log('\nnormalizeInstructions:');

await test('returns undefined for empty or whitespace-only bodies', () => {
  assert.equal(normalizeInstructions(''), undefined);
  assert.equal(normalizeInstructions('   \n  '), undefined);
  assert.equal(normalizeInstructions('\n\n'), undefined);
});

await test('returns normalized text for real bodies', () => {
  assert.equal(normalizeInstructions('\nHello\n'), 'Hello');
});

console.log('\ntextEqual:');

await test('treats whitespace-only body differences as equal', () => {
  assert.ok(textEqual('\n# Title\n', '# Title', { kind: 'body' }));
  assert.ok(textEqual('# Title\r\n', '# Title\n', { kind: 'body' }));
  assert.ok(!textEqual('# Title', '# Other', { kind: 'body' }));
});

await test('description kind trims edges', () => {
  assert.ok(textEqual('  same  ', 'same', { kind: 'description' }));
});

console.log('\nnormalizeFileText:');

await test('normalizes line endings only', () => {
  assert.equal(normalizeFileText('a\r\nb'), 'a\nb');
  assert.equal(normalizeFileText('\n\nbody\n\n'), '\n\nbody\n\n');
});

done();
