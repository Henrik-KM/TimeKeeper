import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  decodeGitHubContextContent,
  decryptEncryptedContextContent,
  fetchEncryptedContext,
  fetchPrivateContext,
  getContextApiPath,
  getContextSummary
} from '../../scripts/pull-codex-context.mjs';
import { encryptCodexContext } from '../../src/features/codex/encryption.mjs';

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
      stdout: JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(context)).toString('base64')
      }),
      stderr: ''
    };
  });
  assert.deepEqual(fetched, context);
  assert.match(calls[0].command, /^gh(?:\.exe)?$/);
  assert.equal(calls[0].args[0], 'api');
  assert.ok(calls[0].args[1].includes('contents/codex-context.json'));
  assert.ok(calls[0].options.maxBuffer >= 64 * 1024 * 1024);
  assert.equal(JSON.stringify(calls).includes('token'), false);
});

test('round trips an encrypted fallback through the private key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  const encrypted = await encryptCodexContext(context, publicKey);
  const encodedEncrypted = Buffer.from(JSON.stringify(encrypted)).toString(
    'base64'
  );
  assert.deepEqual(
    decryptEncryptedContextContent(encodedEncrypted, privateKey),
    context
  );

  const responses = [
    encodedEncrypted,
    Buffer.from(privateKey).toString('base64')
  ];
  const fetched = fetchEncryptedContext({}, () => ({
    status: 0,
    stdout: JSON.stringify({ encoding: 'base64', content: responses.shift() }),
    stderr: ''
  }));
  assert.deepEqual(fetched, context);
});

test('reads large private context from its exact Git blob instead of stale fallback', () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const fetched = fetchPrivateContext({}, (_command, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: JSON.stringify(
        calls.length === 1
          ? { encoding: 'none', content: '', sha, size: 3 * 1024 * 1024 }
          : {
              encoding: 'base64',
              content: Buffer.from(JSON.stringify(context)).toString('base64')
            }
      ),
      stderr: ''
    };
  });
  assert.deepEqual(fetched, context);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1][1],
    `repos/Henrik-KM/timekeeper-private-context/git/blobs/${sha}`
  );
});

test('rejects missing GitHub content instead of treating it as an empty snapshot', () => {
  assert.throws(
    () =>
      fetchPrivateContext({}, () => ({
        status: 0,
        stdout: JSON.stringify({ encoding: 'none', content: '' }),
        stderr: ''
      })),
    /content was missing/
  );
});
