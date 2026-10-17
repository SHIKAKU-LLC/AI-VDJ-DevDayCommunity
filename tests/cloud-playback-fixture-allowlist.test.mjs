import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';

test('unauthenticated local fixture allowlist resolves the complete exact browser module import graph', async () => {
  const source = await readFile(new URL('./cloud-playback-browser-fixture-server.mjs', import.meta.url), 'utf8');
  const files = new Map([...source.matchAll(/\['(\/[^']+\.mjs)', '([^']+\.mjs)'\]/g)].map(match => [match[1], match[2]]));
  assert.equal(files.get('/playback/clip-timeline.mjs'), 'room-web/playback/clip-timeline.mjs');
  assert.equal(files.get('/fixture.mjs'), 'tests/cloud-playback-browser-fixture.mjs');
  const pending = ['/fixture.mjs', '/room-worklet.mjs'], visited = new Set();
  while (pending.length) {
    const url = pending.pop(); if (visited.has(url)) continue; visited.add(url);
    assert.ok(files.has(url), `missing browser module: ${url}`);
    const body = await readFile(new URL('../' + files.get(url), import.meta.url), 'utf8');
    for (const match of body.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('.') || specifier.startsWith('/'), `unbound module import: ${specifier}`);
      const dependency = specifier.startsWith('/') ? specifier : posix.resolve(posix.dirname(url), specifier);
      assert.ok(files.has(dependency), `${url} imports unallowlisted ${dependency}`); pending.push(dependency);
    }
  }
  assert.ok(visited.has('/playback/clip-timeline.mjs'));
});
