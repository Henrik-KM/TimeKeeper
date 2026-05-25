import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultPort = Number(process.env.TIMEKEEPER_FOCUS_PORT || 8766);
const defaultHost = '127.0.0.1';
const markerStart = '# TimeKeeper focus block START';
const markerEnd = '# TimeKeeper focus block END';
export const defaultBlockedSites = [
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
  'youtube.googleapis.com',
  'ytimg.com',
  'www.ytimg.com',
  'i.ytimg.com'
];

export function getHostsPath() {
  if (process.env.TIMEKEEPER_HOSTS_PATH) {
    return path.resolve(process.env.TIMEKEEPER_HOSTS_PATH);
  }
  if (process.platform === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  }
  return '/etc/hosts';
}

export function normalizeDomain(raw) {
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

function uniqueDomains(domains) {
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))];
}

function logEvent(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

export function getConfiguredDefaultBlockedSites() {
  const extra = process.env.TIMEKEEPER_FOCUS_EXTRA_SITES || '';
  return uniqueDomains([
    ...defaultBlockedSites,
    ...extra.split(',').filter(Boolean)
  ]);
}

export function parseBlockedSites(
  searchParams,
  defaults = getConfiguredDefaultBlockedSites()
) {
  const raw = searchParams.get('blockedSites') || '';
  const requested = raw.split(',').map(normalizeDomain).filter(Boolean);
  const replaceDefaults =
    searchParams.get('replaceDefaultSites') === '1' ||
    searchParams.get('replaceDefaultSites') === 'true';
  return uniqueDomains([
    ...(replaceDefaults ? [] : defaults),
    ...(requested.length ? requested : [])
  ]);
}

export function removeExistingBlock(content) {
  const escapedStart = markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(
    `\\r?\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`,
    'g'
  );
  return content.replace(blockPattern, os.EOL).replace(/\s+$/, '');
}

export function buildHostsBlock(domains) {
  const normalizedDomains = uniqueDomains(domains);
  const lines = [
    markerStart,
    '# Managed by scripts/focus-blocker.mjs. Do not edit this block by hand.'
  ];
  normalizedDomains.forEach((domain) => {
    lines.push(`0.0.0.0 ${domain}`);
    lines.push(`::1 ${domain}`);
  });
  lines.push(markerEnd);
  return lines.join(os.EOL);
}

export function readBlockState(content) {
  const start = content.indexOf(markerStart);
  const end = content.indexOf(markerEnd);
  if (start === -1 || end === -1 || end < start) {
    return { active: false, blockedSites: [] };
  }
  const block = content.slice(start, end);
  const blockedSites = uniqueDomains(
    block
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
  );
  return { active: blockedSites.length > 0, blockedSites };
}

export async function flushDns() {
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

export async function setBlockEnabled(
  enabled,
  domains = getConfiguredDefaultBlockedSites(),
  { hostsPath = getHostsPath(), flush = true } = {}
) {
  const existing = await fs.readFile(hostsPath, 'utf8');
  const withoutBlock = removeExistingBlock(existing);
  const normalizedDomains = uniqueDomains(domains);
  const next = enabled
    ? `${withoutBlock}${os.EOL}${os.EOL}${buildHostsBlock(normalizedDomains)}${os.EOL}`
    : `${withoutBlock}${os.EOL}`;
  if (next !== existing) {
    await fs.writeFile(hostsPath, next, 'utf8');
    if (flush) await flushDns();
  }
  return { hostsPath, blockedSites: enabled ? normalizedDomains : [] };
}

export function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Access-Control-Request-Private-Network',
    'Access-Control-Allow-Private-Network': 'true',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload, null, 2));
}

export function formatPermissionHint(error) {
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return 'Permission denied. On Windows, run PowerShell as Administrator and start with `npm run focus:blocker`.';
  }
  return error && error.message ? error.message : String(error);
}

export function createFocusBlockerServer({
  host = defaultHost,
  port = defaultPort,
  hostsPath = getHostsPath(),
  flush = true,
  defaults = getConfiguredDefaultBlockedSites()
} = {}) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }

    const url = new URL(req.url || '/', `http://${host}:${port}`);
    try {
      if (url.pathname === '/health' || url.pathname === '/focus/status') {
        const content = await fs.readFile(hostsPath, 'utf8');
        writeJson(res, 200, {
          ok: true,
          hostsPath,
          defaultBlockedSites: defaults,
          ...readBlockState(content)
        });
        return;
      }

      if (url.pathname === '/focus/start') {
        const blockedSites = parseBlockedSites(url.searchParams, defaults);
        const paidFocus = Number(url.searchParams.get('paidFocus'));
        const threshold = Number(url.searchParams.get('threshold'));
        const shouldBlock =
          Number.isFinite(paidFocus) &&
          Number.isFinite(threshold) &&
          paidFocus > threshold;
        const result = await setBlockEnabled(shouldBlock, blockedSites, {
          hostsPath,
          flush
        });
        logEvent(
          shouldBlock
            ? `focus/start enabled ${result.blockedSites.length} sites; paidFocus=${url.searchParams.get('paidFocus') || 'unknown'}`
            : `focus/start ignored below threshold; paidFocus=${url.searchParams.get('paidFocus') || 'unknown'}`
        );
        writeJson(res, 200, {
          ok: true,
          active: shouldBlock,
          paidFocus: url.searchParams.get('paidFocus') || null,
          threshold: url.searchParams.get('threshold') || null,
          ...result
        });
        return;
      }

      if (url.pathname === '/focus/stop') {
        const result = await setBlockEnabled(false, defaults, {
          hostsPath,
          flush
        });
        logEvent('focus/stop disabled site block');
        writeJson(res, 200, { ok: true, active: false, ...result });
        return;
      }

      writeJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: formatPermissionHint(error),
        hostsPath
      });
    }
  });
}

export async function cleanupAndExit() {
  try {
    await setBlockEnabled(false);
  } finally {
    process.exit(0);
  }
}

export function startFocusBlockerServer({
  host = defaultHost,
  port = defaultPort
} = {}) {
  const server = createFocusBlockerServer({ host, port });
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  server.listen(port, host, () => {
    process.stdout.write(
      `TimeKeeper focus blocker listening on http://${host}:${port}\n` +
        `Hosts file: ${getHostsPath()}\n` +
        'Run this terminal as Administrator/root so the service can edit the hosts file.\n'
    );
  });
  return server;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startFocusBlockerServer();
}
