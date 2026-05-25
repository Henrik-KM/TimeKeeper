import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFocusBlockerServer,
  defaultBlockedSites,
  parseBlockedSites,
  readBlockState,
  removeExistingBlock,
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
