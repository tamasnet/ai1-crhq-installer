#!/usr/bin/env node
// satellitePackageName / resolveSatelliteId — pure identity helpers (DB-free, no sandbox).
// Run from the project root:  node tests/identity.test.mjs
import assert from 'node:assert/strict';
import { satellitePackageName, resolveSatelliteId } from '../scripts/lib/identity.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

console.log('satellitePackageName:');

await test('drops a leading myzone- and ensures an ai1- prefix', () => {
  assert.equal(satellitePackageName('myzone-tamas'), 'ai1-tamas');
});

await test('adds ai1- when absent', () => {
  assert.equal(satellitePackageName('tamas'), 'ai1-tamas');
});

await test('leaves an existing ai1- name unchanged', () => {
  assert.equal(satellitePackageName('ai1-foo'), 'ai1-foo');
});

await test('strips myzone- before checking the ai1- prefix', () => {
  assert.equal(satellitePackageName('myzone-ai1-foo'), 'ai1-foo');
});

await test('resolveSatelliteId honors SATELLITE_ID; satellitePackageName defaults to it', () => {
  const prev = process.env.SATELLITE_ID;
  process.env.SATELLITE_ID = 'myzone-zed';
  try {
    assert.equal(resolveSatelliteId(), 'myzone-zed');
    assert.equal(satellitePackageName(), 'ai1-zed');
  } finally {
    if (prev === undefined) delete process.env.SATELLITE_ID; else process.env.SATELLITE_ID = prev;
  }
});

done();
