import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyFocusStatePayload,
  createFocusBlockerServer,
  defaultBlockedSites,
  normalizeFocusStatePayload,
  parseBlockedSites,
  readBlockState,
  removeExistingBlock,
  runFocusBlockerSelfTest,
  setBlockEnabled
} from '../../scripts/focus-blocker.mjs';

async function makeHostsFile(initialContent = '127.0.0.1 localhost\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timekeeper-focus-'));
  const hostsPath = path.join(dir, 'hosts');
  await fs.writeFile(hostsPath, initialContent, 'utf8');
  return { dir, hostsPath };
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(body || '{}')
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('parseBlockedSites keeps defaults and adds requested domains', () => {
  const params = new URLSearchParams({
    blockedSites: 'https://example.com/path,www.reddit.com,not a domain'
  });
  const sites = parseBlockedSites(params, defaultBlockedSites);

  assert.ok(sites.includes('youtube.com'));
  assert.ok(sites.includes('www.youtube.com'));
  assert.ok(sites.includes('example.com'));
  assert.equal(sites.filter((site) => site === 'www.reddit.com').length, 1);
  assert.equal(sites.includes('not a domain'), false);
});

test('parseBlockedSites can intentionally replace defaults', () => {
  const params = new URLSearchParams({
    blockedSites: 'example.com',
    replaceDefaultSites: '1'
  });

  assert.deepEqual(parseBlockedSites(params, defaultBlockedSites), [
    'example.com'
  ]);
});

test('setBlockEnabled writes and removes only the managed hosts block', async () => {
  const { hostsPath } = await makeHostsFile(
    ['127.0.0.1 localhost', '# user managed line', ''].join(os.EOL)
  );

  await setBlockEnabled(true, ['reddit.com', 'youtube.com'], {
    hostsPath,
    flush: false
  });
  const blocked = await fs.readFile(hostsPath, 'utf8');
  assert.match(blocked, /# TimeKeeper focus block START/);
  assert.match(blocked, /0\.0\.0\.0 reddit\.com/);
  assert.match(blocked, /::1 youtube\.com/);
  assert.match(blocked, /# user managed line/);
  assert.deepEqual(readBlockState(blocked), {
    active: true,
    blockedSites: ['reddit.com', 'youtube.com']
  });

  await setBlockEnabled(false, [], { hostsPath, flush: false });
  const unblocked = await fs.readFile(hostsPath, 'utf8');
  assert.doesNotMatch(unblocked, /TimeKeeper focus block START/);
  assert.match(unblocked, /# user managed line/);
});

test('removeExistingBlock handles repeated managed sections', () => {
  const content = [
    '127.0.0.1 localhost',
    '# TimeKeeper focus block START',
    '0.0.0.0 reddit.com',
    '# TimeKeeper focus block END',
    '# TimeKeeper focus block START',
    '0.0.0.0 youtube.com',
    '# TimeKeeper focus block END',
    '# keep me',
    ''
  ].join(os.EOL);

  const cleaned = removeExistingBlock(content);
  assert.doesNotMatch(cleaned, /reddit\.com/);
  assert.doesNotMatch(cleaned, /youtube\.com/);
  assert.match(cleaned, /# keep me/);
});

test('runFocusBlockerSelfTest writes, verifies, and restores the original hosts file', async () => {
  const original = [
    '127.0.0.1 localhost',
    '# TimeKeeper focus block START',
    '0.0.0.0 reddit.com',
    '::1 reddit.com',
    '# TimeKeeper focus block END',
    '# user managed line',
    ''
  ].join(os.EOL);
  const { hostsPath } = await makeHostsFile(original);

  const result = await runFocusBlockerSelfTest({
    hostsPath,
    domains: ['timekeeper-self-test.invalid'],
    flush: false
  });
  const finalContent = await fs.readFile(hostsPath, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.previousActive, true);
  assert.deepEqual(result.testedSites, ['timekeeper-self-test.invalid']);
  assert.ok(
    result.enabledBlockedSites.includes('timekeeper-self-test.invalid')
  );
  assert.equal(result.restoredActive, true);
  assert.deepEqual(result.restoredBlockedSites, ['reddit.com']);
  assert.equal(finalContent, original);
});

test('HTTP start, status, and stop operate on a configured hosts file', async () => {
  const { hostsPath } = await makeHostsFile();
  const server = createFocusBlockerServer({
    hostsPath,
    flush: false,
    defaults: ['reddit.com', 'youtube.com']
  });

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const start = await requestJson(
      `${baseUrl}/focus/start?paidFocus=150&threshold=50&blockedSites=example.com`
    );
    assert.equal(start.status, 200);
    assert.equal(start.headers['access-control-allow-private-network'], 'true');
    assert.equal(start.body.active, true);
    assert.ok(start.body.blockedSites.includes('reddit.com'));
    assert.ok(start.body.blockedSites.includes('youtube.com'));
    assert.ok(start.body.blockedSites.includes('example.com'));

    const status = await requestJson(`${baseUrl}/focus/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.active, true);
    assert.ok(status.body.blockedSites.includes('example.com'));

    const stop = await requestJson(`${baseUrl}/focus/stop`);
    assert.equal(stop.status, 200);
    assert.equal(stop.body.active, false);

    const afterStop = await fs.readFile(hostsPath, 'utf8');
    assert.equal(readBlockState(afterStop).active, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP self-test reports success and restores previous block state', async () => {
  const original = [
    '127.0.0.1 localhost',
    '# TimeKeeper focus block START',
    '0.0.0.0 youtube.com',
    '::1 youtube.com',
    '# TimeKeeper focus block END',
    ''
  ].join(os.EOL);
  const { hostsPath } = await makeHostsFile(original);
  const server = createFocusBlockerServer({
    hostsPath,
    flush: false,
    defaults: ['reddit.com', 'youtube.com']
  });

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(
      `${baseUrl}/focus/self-test?blockedSites=timekeeper-self-test.invalid`
    );
    const finalContent = await fs.readFile(hostsPath, 'utf8');

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.testedSites, [
      'timekeeper-self-test.invalid'
    ]);
    assert.equal(response.body.restoredActive, true);
    assert.deepEqual(response.body.restoredBlockedSites, ['youtube.com']);
    assert.equal(finalContent, original);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP start only blocks with explicit paid focus above threshold', async () => {
  const { hostsPath } = await makeHostsFile();
  const server = createFocusBlockerServer({
    hostsPath,
    flush: false,
    defaults: ['reddit.com', 'youtube.com']
  });

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const missingFocus = await requestJson(`${baseUrl}/focus/start`);
    assert.equal(missingFocus.status, 200);
    assert.equal(missingFocus.body.active, false);

    const atThreshold = await requestJson(
      `${baseUrl}/focus/start?paidFocus=50&threshold=50`
    );
    assert.equal(atThreshold.status, 200);
    assert.equal(atThreshold.body.active, false);

    const belowThreshold = await requestJson(
      `${baseUrl}/focus/start?paidFocus=0&threshold=50`
    );
    assert.equal(belowThreshold.status, 200);
    assert.equal(belowThreshold.body.active, false);

    const content = await fs.readFile(hostsPath, 'utf8');
    assert.equal(readBlockState(content).active, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP OPTIONS preflight allows browser local-network requests', async () => {
  const { hostsPath } = await makeHostsFile();
  const server = createFocusBlockerServer({ hostsPath, flush: false });

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP address.');
  }

  try {
    const response = await requestJson(
      `http://127.0.0.1:${address.port}/focus/start`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Private-Network': 'true'
        }
      }
    );
    assert.equal(response.status, 204);
    assert.equal(
      response.headers['access-control-allow-private-network'],
      'true'
    );
    assert.match(
      String(response.headers['access-control-allow-methods']),
      /GET/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('normalizeFocusStatePayload accepts raw and GitHub contents focus state', () => {
  const now = new Date('2026-06-04T12:00:00.000Z');
  const rawState = {
    version: 1,
    active: true,
    paidFocusPercent: 150,
    thresholdPercent: 50,
    updatedAt: '2026-06-04T11:59:30.000Z',
    expiresAt: '2026-06-04T12:05:00.000Z',
    blockedSites: ['reddit.com', 'https://youtube.com/watch?v=1']
  };
  const normalized = normalizeFocusStatePayload(rawState, {
    defaults: ['example.com'],
    now,
    staleMs: 180000
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.active, true);
  assert.equal(normalized.paidFocusPercent, 150);
  assert.deepEqual(normalized.blockedSites, ['reddit.com', 'youtube.com']);

  const githubPayload = {
    content: Buffer.from(JSON.stringify(rawState), 'utf8').toString('base64')
  };
  const decoded = normalizeFocusStatePayload(githubPayload, {
    defaults: ['example.com'],
    now,
    staleMs: 180000
  });

  assert.equal(decoded.active, true);
  assert.deepEqual(decoded.blockedSites, ['reddit.com', 'youtube.com']);
});

test('remote focus state blocks only above threshold and clears stale states', async () => {
  const { hostsPath } = await makeHostsFile();
  const now = new Date('2026-06-04T12:00:00.000Z');

  const active = await applyFocusStatePayload(
    {
      active: true,
      paidFocusPercent: 100,
      thresholdPercent: 50,
      updatedAt: '2026-06-04T11:59:30.000Z',
      blockedSites: ['reddit.com']
    },
    {
      hostsPath,
      flush: false,
      defaults: ['youtube.com'],
      now,
      staleMs: 180000
    }
  );
  assert.equal(active.active, true);
  assert.deepEqual(active.blockedSites, ['reddit.com']);
  assert.equal(
    readBlockState(await fs.readFile(hostsPath, 'utf8')).active,
    true
  );

  const stale = await applyFocusStatePayload(
    {
      active: true,
      paidFocusPercent: 100,
      thresholdPercent: 50,
      updatedAt: '2026-06-04T11:50:00.000Z',
      blockedSites: ['reddit.com']
    },
    {
      hostsPath,
      flush: false,
      defaults: ['youtube.com'],
      now,
      staleMs: 180000
    }
  );
  assert.equal(stale.active, false);
  assert.equal(stale.stale, true);
  assert.equal(
    readBlockState(await fs.readFile(hostsPath, 'utf8')).active,
    false
  );

  const atThreshold = await applyFocusStatePayload(
    {
      active: true,
      paidFocusPercent: 50,
      thresholdPercent: 50,
      updatedAt: '2026-06-04T11:59:30.000Z',
      blockedSites: ['reddit.com']
    },
    {
      hostsPath,
      flush: false,
      defaults: ['youtube.com'],
      now,
      staleMs: 180000
    }
  );
  assert.equal(atThreshold.active, false);
  assert.equal(
    readBlockState(await fs.readFile(hostsPath, 'utf8')).active,
    false
  );
});
