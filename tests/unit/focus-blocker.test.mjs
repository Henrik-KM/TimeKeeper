import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computePaidFocusFromTimekeeperData,
  createFocusBlockerServer,
  defaultBlockedSites,
  parseBlockedSites,
  readBlockState,
  removeExistingBlock,
  resolveStaticAppPath,
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

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
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

test('computePaidFocusFromTimekeeperData sums running paid timer focus', () => {
  const paidFocus = computePaidFocusFromTimekeeperData({
    projects: [
      { id: 'paid', hourlyRate: 100 },
      { id: 'free', hourlyRate: 0 }
    ],
    entries: [
      { projectId: 'paid', isRunning: true, focusFactor: 1 },
      { projectId: 'paid', isRunning: true, manualFactor: 0.5 },
      { projectId: 'free', isRunning: true, focusFactor: 2 },
      { projectId: 'paid', isRunning: false, focusFactor: 2 }
    ]
  });

  assert.equal(paidFocus, 1.5);
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

test('resolveStaticAppPath only exposes app files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timekeeper-static-'));

  assert.equal(resolveStaticAppPath('/', dir), path.join(dir, 'index.html'));
  assert.equal(
    resolveStaticAppPath('/src/main.mjs', dir),
    path.join(dir, 'src', 'main.mjs')
  );
  assert.equal(resolveStaticAppPath('/package.json', dir), null);
  assert.equal(resolveStaticAppPath('/src/../package.json', dir), null);
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

test('HTTP server serves the static app for LAN phone access', async () => {
  const { hostsPath } = await makeHostsFile();
  const staticRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'timekeeper-app-')
  );
  await fs.mkdir(path.join(staticRoot, 'src'));
  await fs.writeFile(
    path.join(staticRoot, 'index.html'),
    '<!doctype html><title>TimeKeeper</title>',
    'utf8'
  );
  await fs.writeFile(
    path.join(staticRoot, 'src', 'main.mjs'),
    'export const ok = true;',
    'utf8'
  );
  const server = createFocusBlockerServer({
    hostsPath,
    flush: false,
    staticRoot
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
    const index = await requestText(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-type']), /text\/html/);
    assert.match(index.body, /TimeKeeper/);

    const script = await requestText(`${baseUrl}/src/main.mjs`);
    assert.equal(script.status, 200);
    assert.match(String(script.headers['content-type']), /javascript/);
    assert.match(script.body, /ok = true/);

    const hidden = await requestText(`${baseUrl}/package.json`);
    assert.equal(hidden.status, 404);
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
