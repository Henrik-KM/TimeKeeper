import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeGitHubContextContent,
  fetchPrivateContext,
  getContextApiPath,
  getContextSummary
} from '../../scripts/pull-codex-context.mjs';

const context = {
  schema: 'timekeeper-codex-development-context/v1',
  generatedAt: '2026-07-30T20:00:00.000Z',
  coverage: {
    totalProjects: 3,
    totalEntries: 42
  },
  usage: {
    windows: {
      all: {
        effectiveHours: 123.5
      }
    }
  },
  projects: [],
  entries: []
};

test('builds the private GitHub context API path', () => {
  assert.equal(
    getContextApiPath({
      repository: 'Henrik-KM/timekeeper-private-context',
      branch: 'main',
      pathValue: 'snapshots/codex context.json'
    }),
    'repos/Henrik-KM/timekeeper-private-context/contents/snapshots/codex%20context.json?ref=main'
  );
});

test('decodes and summarizes a private context payload', () => {
  const encoded = Buffer.from(JSON.stringify(context)).toString('base64');
  const decoded = decodeGitHubContextContent(encoded);
  assert.deepEqual(decoded, context);
  assert.deepEqual(getContextSummary(decoded), {
    generatedAt: '2026-07-30T20:00:00.000Z',
    projects: 3,
    entries: 42,
    effectiveHours: 123.5
  });
});

test('fetches context through authenticated gh without exposing a token', () => {
  const calls = [];
  const fetched = fetchPrivateContext({}, (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify(context)).toString('base64'),
      stderr: ''
    };
  });
  assert.deepEqual(fetched, context);
  assert.match(calls[0].command, /^gh(?:\.exe)?$/);
  assert.deepEqual(calls[0].args.slice(-2), ['--jq', '.content']);
  assert.equal(JSON.stringify(calls).includes('token'), false);
});
