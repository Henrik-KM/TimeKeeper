import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.env.TIMEKEEPER_FOCUS_PORT || 8766);
const host = '127.0.0.1';
const markerStart = '# TimeKeeper focus block START';
const markerEnd = '# TimeKeeper focus block END';
const defaultBlockedSites = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtubei.googleapis.com',
  'youtube.googleapis.com'
];

function getHostsPath() {
  if (process.env.TIMEKEEPER_HOSTS_PATH) {
    return path.resolve(process.env.TIMEKEEPER_HOSTS_PATH);
  }
  if (process.platform === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  }
  return '/etc/hosts';
}

function normalizeDomain(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  if (!cleaned) return null;
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(cleaned)) return null;
  return cleaned;
}

function parseBlockedSites(searchParams) {
  const raw = searchParams.get('blockedSites') || '';
  const requested = raw.split(',').map(normalizeDomain).filter(Boolean);
  return [...new Set(requested.length ? requested : defaultBlockedSites)];
}

function removeExistingBlock(content) {
  const escapedStart = markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(
    `\\r?\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`,
    'g'
  );
  return content.replace(blockPattern, os.EOL).replace(/\s+$/, '');
}

function buildHostsBlock(domains) {
  const lines = [
    markerStart,
    '# Managed by scripts/focus-blocker.mjs. Do not edit this block by hand.'
  ];
  domains.forEach((domain) => {
    lines.push(`0.0.0.0 ${domain}`);
    lines.push(`::1 ${domain}`);
  });
  lines.push(markerEnd);
  return lines.join(os.EOL);
}

async function flushDns() {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('ipconfig', ['/flushdns'], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      await execFileAsync('dscacheutil', ['-flushcache']);
      await execFileAsync('killall', ['-HUP', 'mDNSResponder']);
    } else {
      await execFileAsync('resolvectl', ['flush-caches']);
    }
  } catch (error) {
    // DNS flush is best-effort; the hosts file change is still the source of truth.
  }
}

async function setBlockEnabled(enabled, domains = defaultBlockedSites) {
  const hostsPath = getHostsPath();
  const existing = await fs.readFile(hostsPath, 'utf8');
  const withoutBlock = removeExistingBlock(existing);
  const next = enabled
    ? `${withoutBlock}${os.EOL}${os.EOL}${buildHostsBlock(domains)}${os.EOL}`
    : `${withoutBlock}${os.EOL}`;
  await fs.writeFile(hostsPath, next, 'utf8');
  await flushDns();
  return { hostsPath, blockedSites: enabled ? domains : [] };
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function formatPermissionHint(error) {
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return 'Permission denied. On Windows, run PowerShell as Administrator and start with `npm run focus:blocker`.';
  }
  return error && error.message ? error.message : String(error);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    writeJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || '/', `http://${host}:${port}`);
  try {
    if (url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        hostsPath: getHostsPath(),
        defaultBlockedSites
      });
      return;
    }

    if (url.pathname === '/focus/start') {
      const blockedSites = parseBlockedSites(url.searchParams);
      const result = await setBlockEnabled(true, blockedSites);
      writeJson(res, 200, {
        ok: true,
        active: true,
        paidFocus: url.searchParams.get('paidFocus') || null,
        ...result
      });
      return;
    }

    if (url.pathname === '/focus/stop') {
      const result = await setBlockEnabled(false);
      writeJson(res, 200, { ok: true, active: false, ...result });
      return;
    }

    writeJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: formatPermissionHint(error),
      hostsPath: getHostsPath()
    });
  }
});

async function cleanupAndExit() {
  try {
    await setBlockEnabled(false);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

server.listen(port, host, () => {
  process.stdout.write(
    `TimeKeeper focus blocker listening on http://${host}:${port}\n` +
      `Hosts file: ${getHostsPath()}\n` +
      'Run this terminal as Administrator/root so the service can edit the hosts file.\n'
  );
});
