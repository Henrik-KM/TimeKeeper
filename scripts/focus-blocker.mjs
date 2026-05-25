import { execFile } from 'node:child_process';
import { promises as fs, watch as watchFs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultPort = Number(process.env.TIMEKEEPER_FOCUS_PORT || 8766);
const defaultHost = process.env.TIMEKEEPER_FOCUS_HOST || '127.0.0.1';
const backupLatestFilename = 'timekeeper-data.json';
const defaultFocusThreshold = Number(
  process.env.TIMEKEEPER_FOCUS_THRESHOLD || 0.5
);
const defaultDataPollMs = Number(
  process.env.TIMEKEEPER_FOCUS_DATA_POLL_MS || 3000
);
const markerStart = '# TimeKeeper focus block START';
const markerEnd = '# TimeKeeper focus block END';
const staticAppFiles = new Set(['/', '/index.html', '/style.css']);
const staticAppPrefixes = ['/src/', '/assets/'];
const staticMimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8']
]);
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

function getConfiguredStaticRoot() {
  return path.resolve(process.env.TIMEKEEPER_APP_ROOT || process.cwd());
}

function isAllowedStaticPath(decodedPathname) {
  if (staticAppFiles.has(decodedPathname)) return true;
  return staticAppPrefixes.some((prefix) => decodedPathname.startsWith(prefix));
}

export function resolveStaticAppPath(
  pathname,
  staticRoot = getConfiguredStaticRoot()
) {
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname || '/').replace(/\\/g, '/');
  } catch {
    return null;
  }
  if (decodedPathname === '/') decodedPathname = '/index.html';
  if (
    decodedPathname.includes('\0') ||
    decodedPathname.split('/').includes('..') ||
    !isAllowedStaticPath(decodedPathname)
  ) {
    return null;
  }
  const resolvedRoot = path.resolve(staticRoot);
  const resolvedPath = path.resolve(
    resolvedRoot,
    decodedPathname.replace(/^\/+/, '')
  );
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedPath;
}

function getStaticMimeType(filePath) {
  return (
    staticMimeTypes.get(path.extname(filePath).toLowerCase()) ||
    'application/octet-stream'
  );
}

async function serveStaticApp(req, res, url, staticRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const filePath = resolveStaticAppPath(url.pathname, staticRoot);
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': getStaticMimeType(filePath),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(await fs.readFile(filePath));
    return true;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      writeJson(res, 500, { ok: false, error: formatPermissionHint(error) });
      return true;
    }
    return false;
  }
}

function getListenUrls(host, port) {
  if (host !== '0.0.0.0' && host !== '::') {
    return [`http://${host}:${port}`];
  }
  const urls = [`http://127.0.0.1:${port}`];
  Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (network) =>
        network &&
        network.family === 'IPv4' &&
        !network.internal &&
        network.address
    )
    .forEach((network) => {
      urls.push(`http://${network.address}:${port}`);
    });
  return [...new Set(urls)];
}

function computeConcurrencyFactor(count) {
  if (count <= 1) return 1;
  return 1 / (1 + (count - 1) / 3);
}

export function getEntryFocusFactor(entry, fallbackCount = 1) {
  const candidates = [
    entry && entry.focusFactor,
    entry && entry.manualFactor,
    entry && entry.factor,
    computeConcurrencyFactor(fallbackCount)
  ];
  const value = candidates.find(
    (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0
  );
  return Number.isFinite(Number(value)) ? Number(value) : 1;
}

export function computePaidFocusFromTimekeeperData(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const projects = new Map(
    (Array.isArray(data.projects) ? data.projects : []).map((project) => [
      String(project && project.id),
      project || {}
    ])
  );
  const runningEntries = (
    Array.isArray(data.entries) ? data.entries : []
  ).filter((entry) => entry && entry.isRunning);
  return runningEntries.reduce((sum, entry) => {
    const project = projects.get(String(entry.projectId));
    const hourlyRate = project ? Number(project.hourlyRate) : NaN;
    const isUnpaid = Number.isFinite(hourlyRate) && hourlyRate <= 0;
    if (isUnpaid) return sum;
    return sum + getEntryFocusFactor(entry, runningEntries.length);
  }, 0);
}

function getConfiguredDataFilePath() {
  const explicitFile = (process.env.TIMEKEEPER_DATA_FILE || '').trim();
  if (explicitFile) return path.resolve(explicitFile);
  const backupDir = (process.env.TIMEKEEPER_BACKUP_DIR || '').trim();
  if (backupDir) return path.resolve(backupDir, backupLatestFilename);
  return null;
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

const focusDataMonitorState = {
  enabled: false,
  dataFilePath: null,
  dataFileExists: false,
  active: false,
  paidFocus: 0,
  lastCheckedAt: null,
  lastError: null
};

export function getFocusDataMonitorState() {
  return { ...focusDataMonitorState };
}

async function syncBlockFromDataFile({
  dataFilePath,
  threshold = defaultFocusThreshold,
  defaults = getConfiguredDefaultBlockedSites(),
  flush = true
}) {
  focusDataMonitorState.enabled = true;
  focusDataMonitorState.dataFilePath = dataFilePath;
  focusDataMonitorState.lastCheckedAt = new Date().toISOString();
  try {
    const raw = await fs.readFile(dataFilePath, 'utf8');
    focusDataMonitorState.dataFileExists = true;
    const payload = JSON.parse(raw);
    const paidFocus = computePaidFocusFromTimekeeperData(payload);
    const shouldBlock = paidFocus > threshold;
    const wasActive = focusDataMonitorState.active;
    focusDataMonitorState.paidFocus = paidFocus;
    focusDataMonitorState.active = shouldBlock;
    focusDataMonitorState.lastError = null;
    await setBlockEnabled(shouldBlock, defaults, { flush });
    if (shouldBlock !== wasActive) {
      logEvent(
        shouldBlock
          ? `data monitor enabled site block; paidFocus=${Math.round(paidFocus * 100)}`
          : `data monitor disabled site block; paidFocus=${Math.round(paidFocus * 100)}`
      );
    }
  } catch (error) {
    focusDataMonitorState.dataFileExists = false;
    focusDataMonitorState.lastError = formatPermissionHint(error);
    if (focusDataMonitorState.active) {
      await setBlockEnabled(false, defaults, { flush });
      focusDataMonitorState.active = false;
      focusDataMonitorState.paidFocus = 0;
      logEvent(
        'data monitor disabled site block because the data file is unavailable'
      );
    }
  }
}

export function startFocusDataMonitor({
  dataFilePath = getConfiguredDataFilePath(),
  pollMs = defaultDataPollMs,
  threshold = defaultFocusThreshold,
  defaults = getConfiguredDefaultBlockedSites(),
  flush = true
} = {}) {
  if (!dataFilePath) {
    focusDataMonitorState.enabled = false;
    focusDataMonitorState.dataFilePath = null;
    focusDataMonitorState.lastError =
      'No TIMEKEEPER_DATA_FILE or TIMEKEEPER_BACKUP_DIR configured.';
    return { stop() {} };
  }
  const resolvedPath = path.resolve(dataFilePath);
  focusDataMonitorState.enabled = true;
  focusDataMonitorState.dataFilePath = resolvedPath;
  logEvent(`watching TimeKeeper data file: ${resolvedPath}`);
  const sync = () => {
    syncBlockFromDataFile({
      dataFilePath: resolvedPath,
      threshold,
      defaults,
      flush
    }).catch((error) => {
      focusDataMonitorState.lastError = formatPermissionHint(error);
    });
  };
  sync();
  const interval = setInterval(sync, Math.max(1000, pollMs));
  let watcher = null;
  try {
    watcher = watchFs(path.dirname(resolvedPath), (eventType, fileName) => {
      if (!fileName || String(fileName) === path.basename(resolvedPath)) {
        sync();
      }
    });
  } catch (error) {
    focusDataMonitorState.lastError = formatPermissionHint(error);
  }
  return {
    stop() {
      clearInterval(interval);
      if (watcher) watcher.close();
    }
  };
}

export function createFocusBlockerServer({
  host = defaultHost,
  port = defaultPort,
  hostsPath = getHostsPath(),
  flush = true,
  defaults = getConfiguredDefaultBlockedSites(),
  staticRoot = getConfiguredStaticRoot(),
  serveApp = true
} = {}) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }

    const url = new URL(req.url || '/', `http://${host}:${port}`);
    try {
      if (serveApp) {
        const handledStatic = await serveStaticApp(req, res, url, staticRoot);
        if (handledStatic) return;
      }

      if (url.pathname === '/health' || url.pathname === '/focus/status') {
        const content = await fs.readFile(hostsPath, 'utf8');
        writeJson(res, 200, {
          ok: true,
          hostsPath,
          defaultBlockedSites: defaults,
          dataMonitor: getFocusDataMonitorState(),
          ...readBlockState(content)
        });
        return;
      }

      if (url.pathname === '/focus/start') {
        const blockedSites = parseBlockedSites(url.searchParams, defaults);
        const paidFocus = Number(url.searchParams.get('paidFocus'));
        const threshold = Number(url.searchParams.get('threshold'));
        const shouldBlock =
          !Number.isFinite(paidFocus) ||
          !Number.isFinite(threshold) ||
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
  startFocusDataMonitor();
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  server.listen(port, host, () => {
    const urls = getListenUrls(host, port);
    process.stdout.write(
      `TimeKeeper focus blocker listening on ${urls.join(', ')}\n` +
        `TimeKeeper app served from the same address for phone-to-desktop blocking.\n` +
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
