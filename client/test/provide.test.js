import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from '../src/provide.js';

test('Chrome args carry a hand-off code and never the API token', () => {
  const args = buildArgs({
    url: 'https://bonsai-swarm.example',
    code: 'abc-123',
    profileDir: '/tmp/bsw-profile',
  });
  const url = args.at(-1);
  assert.match(url, /#code=abc-123/);
  assert.equal(url.includes('token='), false);
  assert.equal(url.includes('bsw_'), false);
});

test('buildArgs refuses to fall back to putting the token in the URL', () => {
  assert.throws(
    () => buildArgs({ url: 'https://bonsai-swarm.example', token: 'bsw_secret', profileDir: '/tmp/x' }),
    /hand-off code/,
  );
});
