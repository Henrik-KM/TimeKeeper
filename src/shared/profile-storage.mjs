import { compressToUTF16, decompressFromUTF16 } from './vendor/lz-string.mjs';

const COMPRESSED_PREFIX = 'timekeeper-lz1:';
const JOURNAL_SUFFIX = ':journal';
const COMPACT_AFTER_CHARS = 64 * 1024;
const cachedStates = new WeakMap();
const activeWorkers = new WeakMap();

export function isCompressedProfile(raw) {
  return typeof raw === 'string' && raw.startsWith(COMPRESSED_PREFIX);
}

export function parseStoredProfile(raw) {
  if (!isCompressedProfile(raw)) return JSON.parse(raw);
  const decoded = decompressFromUTF16(raw.slice(COMPRESSED_PREFIX.length));
  if (!decoded)
    throw new Error('Saved TimeKeeper profile could not be decoded.');
  return JSON.parse(decoded);
}

function bodyOf(value) {
  const body = { ...value };
  delete body.updatedAt;
  delete body.backupRevision;
  return JSON.stringify(body);
}

function baseFingerprint(raw) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}:${hash >>> 0}`;
}

function applyPatch(body, patch) {
  const [start, removed, inserted] = patch;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(removed) ||
    start < 0 ||
    removed < 0 ||
    start + removed > body.length ||
    typeof inserted !== 'string'
  ) {
    throw new Error('Saved TimeKeeper change journal is invalid.');
  }
  return body.slice(0, start) + inserted + body.slice(start + removed);
}

function makePatch(previous, next) {
  if (previous === next) return null;
  let start = 0;
  while (start < previous.length && start < next.length) {
    if (previous.charCodeAt(start) !== next.charCodeAt(start)) break;
    start += 1;
  }
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start) {
    if (previous.charCodeAt(previousEnd - 1) !== next.charCodeAt(nextEnd - 1))
      break;
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return [start, previousEnd - start, next.slice(start, nextEnd)];
}

function stateMap(storage) {
  let map = cachedStates.get(storage);
  if (!map) {
    map = new Map();
    cachedStates.set(storage, map);
  }
  return map;
}

function getCompressedState(storage, key, raw) {
  const journalRaw = storage.getItem(key + JOURNAL_SUFFIX);
  const map = stateMap(storage);
  const cached = map.get(key);
  if (cached?.baseRaw === raw && cached.journalRaw === journalRaw)
    return cached;

  const base = parseStoredProfile(raw);
  const fingerprint = baseFingerprint(raw);
  let body = bodyOf(base);
  let journal = null;
  if (journalRaw) {
    const candidate = JSON.parse(journalRaw);
    if (
      candidate?.version !== 1 ||
      typeof candidate.base !== 'string' ||
      !Array.isArray(candidate.patches)
    ) {
      throw new Error('Saved TimeKeeper change journal is invalid.');
    }
    if (candidate.base === fingerprint) {
      for (const patch of candidate.patches) body = applyPatch(body, patch);
      journal = candidate;
    } else if (candidate.compactedBase !== fingerprint) {
      const baseRevision = Number(base.backupRevision);
      const journalRevision = Number(candidate.backupRevision);
      if (
        !Number.isFinite(baseRevision) ||
        !Number.isFinite(journalRevision) ||
        baseRevision < journalRevision
      ) {
        throw new Error('Saved TimeKeeper changes do not match the profile.');
      }
    }
  }
  const profile = JSON.parse(body);
  const metadata = journal || base;
  for (const field of ['updatedAt', 'backupRevision']) {
    if (Object.hasOwn(metadata, field)) profile[field] = metadata[field];
  }
  const state = {
    baseRaw: raw,
    journalRaw,
    fingerprint,
    journal,
    body,
    profile
  };
  map.set(key, state);
  return state;
}

export function loadStoredProfile(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  return isCompressedProfile(raw)
    ? getCompressedState(storage, key, raw).profile
    : parseStoredProfile(raw);
}

function scheduleCompaction(storage, key, value, state) {
  if (
    typeof Worker === 'undefined' ||
    state.journalRaw.length < COMPACT_AFTER_CHARS
  )
    return;
  const map = stateMap(storage);
  let workers = activeWorkers.get(storage);
  if (!workers) {
    workers = new Map();
    activeWorkers.set(storage, workers);
  }
  if (workers.has(key)) return;
  let worker;
  try {
    worker = new Worker(
      new URL('./profile-compression-worker.mjs', import.meta.url),
      { type: 'module' }
    );
  } catch {
    return;
  }
  workers.set(key, worker);
  const serialized = JSON.stringify(value);
  const expectedBase = state.baseRaw;
  const expectedJournal = state.journalRaw;
  const finish = () => {
    worker.terminate();
    workers.delete(key);
  };
  worker.onmessage = (event) => {
    try {
      if (
        storage.getItem(key) !== expectedBase ||
        storage.getItem(key + JOURNAL_SUFFIX) !== expectedJournal
      )
        return;
      const compacted = COMPRESSED_PREFIX + event.data;
      storage.setItem(
        key + JOURNAL_SUFFIX,
        JSON.stringify({
          ...state.journal,
          compactedBase: baseFingerprint(compacted)
        })
      );
      storage.setItem(key, compacted);
      storage.removeItem(key + JOURNAL_SUFFIX);
      map.set(key, {
        baseRaw: compacted,
        journalRaw: null,
        fingerprint: baseFingerprint(compacted),
        journal: null,
        body: state.body,
        profile: value
      });
    } catch {
      // The journal remains durable if compaction cannot replace the base.
    } finally {
      finish();
    }
  };
  worker.onerror = finish;
  worker.postMessage(serialized);
}

export function persistProfile(storage, key, value) {
  const raw = storage.getItem(key);
  if (!isCompressedProfile(raw)) {
    const serialized = JSON.stringify(value);
    try {
      storage.setItem(key, serialized);
    } catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      storage.setItem(key, COMPRESSED_PREFIX + compressToUTF16(serialized));
    }
    storage.removeItem(key + JOURNAL_SUFFIX);
    stateMap(storage).delete(key);
    return;
  }

  const state = getCompressedState(storage, key, raw);
  const nextBody = bodyOf(value);
  const patch = makePatch(state.body, nextBody);
  const journal = {
    version: 1,
    base: state.fingerprint,
    patches: patch
      ? [...(state.journal?.patches || []), patch]
      : state.journal?.patches || [],
    updatedAt: value.updatedAt,
    backupRevision: value.backupRevision
  };
  const journalRaw = JSON.stringify(journal);
  try {
    storage.setItem(key + JOURNAL_SUFFIX, journalRaw);
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error;
    storage.setItem(
      key,
      COMPRESSED_PREFIX + compressToUTF16(JSON.stringify(value))
    );
    storage.removeItem(key + JOURNAL_SUFFIX);
    stateMap(storage).delete(key);
    return;
  }
  const nextState = {
    ...state,
    journalRaw,
    journal,
    body: nextBody,
    profile: value
  };
  stateMap(storage).set(key, nextState);
  scheduleCompaction(storage, key, value, nextState);
}
