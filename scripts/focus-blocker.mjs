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
const defaultFocusStatePollMs = Number(
  process.env.TIMEKEEPER_FOCUS_STATE_INTERVAL_MS || 30000
);
const defaultFocusStateStaleMs = Number(
  process.env.TIMEKEEPER_FOCUS_STATE_STALE_MS || 180000
);
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

function decodeBase64Text(value) {
  return Buffer.from(
    String(value || '').replace(/\s+/g, ''),
    'base64'
  ).toString('utf8');
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
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

export function normalizeFocusStatePayload(
  payload,
  {
    defaults = getConfiguredDefaultBlockedSites(),
    now = new Date(),
    staleMs = defaultFocusStateStaleMs
  } = {}
) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      active: false,
      error: 'Focus state payload was empty or invalid.'
    };
  }

  if (typeof payload.content === 'string') {
    try {
      return normalizeFocusStatePayload(
        JSON.parse(decodeBase64Text(payload.content)),
        {
          defaults,
          now,
          staleMs
        }
      );
    } catch (error) {
      return {
        ok: false,
        active: false,
        error: `Could not decode GitHub focus state content: ${error.message || error}`
      };
    }
  }

  const paidFocusPercent = Number(
    payload.paidFocusPercent ?? payload.paidFocus ?? payload.focusPercent
  );
  const thresholdPercent = Number(
    payload.thresholdPercent ?? payload.threshold ?? 50
  );
  const updatedMs = parseDateMs(payload.updatedAt || payload.updated_at);
  const expiresMs = parseDateMs(payload.expiresAt || payload.expires_at);
  const nowMs = now.getTime();
  const staleByAge =
    updatedMs !== null &&
    Number.isFinite(staleMs) &&
    staleMs > 0 &&
    nowMs - updatedMs > staleMs;
  const expired = expiresMs !== null && nowMs > expiresMs;
  const blockedSites = uniqueDomains(
    Array.isArray(payload.blockedSites)
      ? payload.blockedSites
      : String(payload.blockedSites || '')
          .split(',')
          .filter(Boolean)
  );
  const candidateSites = blockedSites.length ? blockedSites : defaults;
  const hasExplicitFocus = Number.isFinite(paidFocusPercent);
  const requestedActive =
    payload.active === true ||
    payload.action === 'start' ||
    (payload.active !== false &&
      hasExplicitFocus &&
      Number.isFinite(thresholdPercent) &&
      paidFocusPercent > thresholdPercent);
  const active =
    requestedActive &&
    hasExplicitFocus &&
    Number.isFinite(thresholdPercent) &&
    paidFocusPercent > thresholdPercent &&
    !staleByAge &&
    !expired;

  return {
    ok: true,
    active,
    requestedActive,
    stale: staleByAge || expired,
    staleReason: expired ? 'expired' : staleByAge ? 'stale' : '',
    paidFocusPercent: hasExplicitFocus ? paidFocusPercent : null,
    thresholdPercent: Number.isFinite(thresholdPercent) ? thresholdPercent : 50,
    updatedAt: payload.updatedAt || payload.updated_at || null,
    expiresAt: payload.expiresAt || payload.expires_at || null,
    blockedSites: candidateSites
  };
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

export async function runFocusBlockerSelfTest({
  hostsPath = getHostsPath(),
  domains = ['timekeeper-self-test.invalid'],
  flush = true
} = {}) {
  const testedSites = uniqueDomains(domains);
  const original = await fs.readFile(hostsPath, 'utf8');
  const previousState = readBlockState(original);
  let mayHaveChanged = false;
  try {
    await setBlockEnabled(true, testedSites, { hostsPath, flush });
    mayHaveChanged = true;
    const enabledContent = await fs.readFile(hostsPath, 'utf8');
    const enabledState = readBlockState(enabledContent);
    const missingSites = testedSites.filter(
      (site) => !enabledState.blockedSites.includes(site)
    );
    if (!enabledState.active || missingSites.length) {
      throw new Error(
        `Self-test block was not written correctly. Missing: ${missingSites.join(', ') || 'managed block'}`
      );
    }

    await setBlockEnabled(false, testedSites, { hostsPath, flush });
    const disabledContent = await fs.readFile(hostsPath, 'utf8');
    const disabledState = readBlockState(disabledContent);
    if (disabledState.active) {
      throw new Error('Self-test block could not be removed.');
    }

    if (disabledContent !== original) {
      await fs.writeFile(hostsPath, original, 'utf8');
      if (flush) await flushDns();
    }
    const restoredState = readBlockState(original);
    return {
      ok: true,
      hostsPath,
      testedSites,
      previousActive: previousState.active,
      previousBlockedSites: previousState.blockedSites,
      enabledBlockedSites: enabledState.blockedSites,
      restored: true,
      restoredActive: restoredState.active,
      restoredBlockedSites: restoredState.blockedSites
    };
  } catch (error) {
    if (mayHaveChanged) {
      try {
        await fs.writeFile(hostsPath, original, 'utf8');
        if (flush) await flushDns();
      } catch (restoreError) {
        throw new Error(
          `Self-test failed and restore failed: ${restoreError.message || restoreError}`
        );
      }
    }
    throw error;
  }
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

export async function fetchFocusStatePayload(url, { token = '' } = {}) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('_timekeeperPoll', String(Date.now()));
  const headers = {
    Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.8',
    'Cache-Control': 'no-store'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(requestUrl, { headers, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Focus state request returned ${response.status}.`);
  }
  return response.json();
}

export async function applyFocusStatePayload(
  payload,
  {
    hostsPath = getHostsPath(),
    flush = true,
    defaults = getConfiguredDefaultBlockedSites(),
    now = new Date(),
    staleMs = defaultFocusStateStaleMs
  } = {}
) {
  const state = normalizeFocusStatePayload(payload, {
    defaults,
    now,
    staleMs
  });
  if (!state.ok) {
    await setBlockEnabled(false, defaults, { hostsPath, flush });
    return state;
  }
  const result = await setBlockEnabled(state.active, state.blockedSites, {
    hostsPath,
    flush
  });
  return { ...state, ...result };
}

export function startFocusStatePolling({
  url = process.env.TIMEKEEPER_FOCUS_STATE_URL || '',
  token = process.env.TIMEKEEPER_FOCUS_STATE_TOKEN || '',
  intervalMs = defaultFocusStatePollMs,
  staleMs = defaultFocusStateStaleMs,
  hostsPath = getHostsPath(),
  flush = true,
  defaults = getConfiguredDefaultBlockedSites()
} = {}) {
  if (!url) return null;
  let stopped = false;
  let timer = null;
  let lastActive = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(poll, Math.max(5000, intervalMs));
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const payload = await fetchFocusStatePayload(url, { token });
      const result = await applyFocusStatePayload(payload, {
        hostsPath,
        flush,
        defaults,
        staleMs
      });
      if (result.active !== lastActive) {
        lastActive = result.active;
        logEvent(
          result.active
            ? `focus/state enabled ${result.blockedSites.length} sites; paidFocus=${result.paidFocusPercent}`
            : `focus/state disabled block${result.staleReason ? ` (${result.staleReason})` : ''}; paidFocus=${result.paidFocusPercent ?? 'unknown'}`
        );
      }
    } catch (error) {
      logEvent(`focus/state poll failed: ${error.message || error}`);
    } finally {
      schedule();
    }
  };

  poll();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    pollNow: poll
  };
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

      if (url.pathname === '/focus/self-test') {
        const requestedSites = parseBlockedSites(url.searchParams, []);
        const useDefaultSites =
          url.searchParams.get('useDefaultSites') === '1' ||
          url.searchParams.get('useDefaultSites') === 'true';
        const result = await runFocusBlockerSelfTest({
          hostsPath,
          flush,
          domains: useDefaultSites
            ? defaults
            : requestedSites.length
              ? requestedSites
              : undefined
        });
        logEvent(
          `focus/self-test wrote and restored ${result.testedSites.length} sites`
        );
        writeJson(res, 200, result);
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
  port = defaultPort,
  remoteStateUrl = process.env.TIMEKEEPER_FOCUS_STATE_URL || '',
  remoteStateToken = process.env.TIMEKEEPER_FOCUS_STATE_TOKEN || ''
} = {}) {
  const server = createFocusBlockerServer({ host, port });
  let remotePoller = null;
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  server.on('close', () => {
    if (remotePoller) remotePoller.stop();
  });
  server.listen(port, host, () => {
    process.stdout.write(
      `TimeKeeper focus blocker listening on http://${host}:${port}\n` +
        `Hosts file: ${getHostsPath()}\n` +
        'Run this terminal as Administrator/root so the service can edit the hosts file.\n'
    );
    if (remoteStateUrl) {
      remotePoller = startFocusStatePolling({
        url: remoteStateUrl,
        token: remoteStateToken
      });
      process.stdout.write(`Polling remote focus state: ${remoteStateUrl}\n`);
    }
  });
  return server;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const sitesArg =
      args.find((arg) => arg.startsWith('--sites=')) ||
      args.find((arg) => arg.startsWith('--blocked-sites='));
    const useDefaultSites =
      args.includes('--default-sites') || args.includes('--use-default-sites');
    const domains = useDefaultSites
      ? getConfiguredDefaultBlockedSites()
      : sitesArg
        ? sitesArg.split('=').slice(1).join('=').split(',')
        : undefined;
    runFocusBlockerSelfTest({
      domains,
      flush: !args.includes('--no-flush')
    })
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(
          `${JSON.stringify(
            {
              ok: false,
              hostsPath: getHostsPath(),
              error: formatPermissionHint(error)
            },
            null,
            2
          )}\n`
        );
        process.exitCode = 1;
      });
  } else {
    const stateUrlArg = args.find((arg) => arg.startsWith('--state-url='));
    const stateTokenArg = args.find((arg) => arg.startsWith('--state-token='));
    startFocusBlockerServer({
      remoteStateUrl: stateUrlArg
        ? stateUrlArg.split('=').slice(1).join('=')
        : undefined,
      remoteStateToken: stateTokenArg
        ? stateTokenArg.split('=').slice(1).join('=')
        : undefined
    });
  }
}
