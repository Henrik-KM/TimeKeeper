import {
  applyProfileChanges,
  profileChanges,
  profileConflictError
} from './profile-changes.mjs';
import { persistProfile } from './profile-storage.mjs';
import { uuid } from './id.mjs';

function snapshot(value) {
  const raw = JSON.stringify(value);
  return () => JSON.parse(raw);
}

// read() returns a detached copy of the stored profile with application defaults.
export async function openProfileSession(key, read, notify, offerConflicts) {
  const storage = window.localStorage;
  const pendingPrefix = key + ':pending:';
  const conflictPrefix = key + ':conflict:';
  const journalKey = key + ':journal';
  let releaseWriter;
  let ownsWriter = false;
  let changedListener = () => {};
  let queuedDrain;
  let sequence = 0;
  const writerId = uuid();
  let version = readVersion();
  let initial = read();
  let previous = snapshot(initial);
  let generation = 0;

  function readVersion() {
    return { base: storage.getItem(key), journal: storage.getItem(journalKey) };
  }

  function differentBase() {
    return (
      storage.getItem(key) !== version.base ||
      storage.getItem(journalKey) !== version.journal
    );
  }

  function remember(readPrevious, observedVersion) {
    previous = readPrevious;
    version = observedVersion;
  }

  function storedKeys(prefix = pendingPrefix) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (name?.startsWith(prefix)) keys.push(name);
    }
    return keys.sort();
  }

  let displayedConflicts = '';
  function reportConflicts() {
    const keys = storedKeys(conflictPrefix);
    const signature = keys.join(',');
    if (!signature || signature === displayedConflicts) return;
    displayedConflicts = signature;
    offerConflicts(
      keys.map((name) => JSON.parse(storage.getItem(name))),
      () => {
        for (const name of keys) storage.removeItem(name);
        displayedConflicts = '';
      }
    );
  }

  function apply(value, request) {
    const changed = applyProfileChanges(value, request.changes);
    if (
      request.startedProjects &&
      value.entries.some(
        (entry) =>
          entry.isRunning &&
          request.startedProjects.includes(String(entry.projectId)) &&
          !request.runningIds.includes(entry.id)
      )
    ) {
      throw profileConflictError(
        'A timer for this project was already started in another tab.'
      );
    }
    const revision = Number(value.backupRevision) || 0;
    if (changed || (request.bump && request.baseRevision === revision)) {
      if (request.bump) {
        value.backupRevision = Math.max(revision + 1, request.revision || 0);
        value.updatedAt =
          value.updatedAt > request.updatedAt
            ? value.updatedAt
            : request.updatedAt;
      }
      return true;
    }
    return false;
  }

  // Only the elected writer touches the canonical profile or its compression
  // journal. Other tabs can durably submit a small edit and close immediately.
  function drain() {
    let wrote = false;
    for (const name of storedKeys()) {
      const request = JSON.parse(storage.getItem(name));
      if (!request) continue;
      const value = read();
      let changed;
      try {
        changed = apply(value, request);
      } catch (error) {
        if (error.name !== 'ProfileConflictError') throw error;
        // Preserve a conflicting submission for recovery and notify its tab.
        storage.setItem(
          name.replace(pendingPrefix, conflictPrefix),
          JSON.stringify(request)
        );
        storage.removeItem(name);
        reportConflicts();
        continue;
      }
      if (changed) {
        persistProfile(storage, key, value, () => ownsWriter);
        wrote = true;
      }
      storage.removeItem(name);
    }
    if (wrote) queueMicrotask(changedListener);
  }

  // On insecure LAN origins Web Locks may be unavailable. IndexedDB still
  // serializes readwrite transactions across tabs, including their callbacks.
  let lockDatabase;
  function drainWithIndexedDB() {
    lockDatabase ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(key + '-writer', 1);
      opening.onupgradeneeded = () =>
        opening.result.createObjectStore('writer');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    return lockDatabase.then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('writer', 'readwrite');
          tx.objectStore('writer').get('lock').onsuccess = () => {
            try {
              drain();
            } catch (error) {
              tx.abort();
              reject(error);
            }
          };
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  function report(error) {
    notify(
      error?.message || 'TimeKeeper could not finish saving this tab’s changes.'
    );
  }

  function drainAndReport() {
    try {
      drain();
    } catch (error) {
      report(error);
    }
  }

  async function tryWriter() {
    if (!navigator.locks) {
      if (storedKeys().length) await drainWithIndexedDB();
      return;
    }
    // Release on pagehide/freeze so a suspended Android tab cannot block saves.
    await new Promise((ready, reject) => {
      navigator.locks
        .request(key, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            ready(undefined);
            return;
          }
          ownsWriter = true;
          const held = new Promise((resolve) => {
            releaseWriter = resolve;
          });
          try {
            drainAndReport();
            ready(undefined);
            await held;
          } finally {
            ownsWriter = false;
            releaseWriter = null;
          }
        })
        .catch(reject);
    });
  }

  function scheduleDrain() {
    if (ownsWriter) {
      drainAndReport();
    } else if (!queuedDrain) {
      const request = navigator.locks
        ? navigator.locks.request(key, drain)
        : drainWithIndexedDB();
      queuedDrain = request.catch(report).finally(() => {
        queuedDrain = null;
      });
    }
  }

  await tryWriter().catch(report);
  window.addEventListener('pagehide', () => releaseWriter?.());
  document.addEventListener('freeze', () => releaseWriter?.());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseWriter?.();
    else if (!ownsWriter) tryWriter().catch(report);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !ownsWriter) tryWriter().catch(report);
  });
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith(pendingPrefix) && event.newValue && ownsWriter)
      scheduleDrain();
    if (event.key === key || event.key === journalKey) changedListener();
    if (event.key?.startsWith(conflictPrefix) && event.newValue)
      reportConflicts();
  });

  function latest() {
    // A different tab can commit during this read. Keep the stamp from
    // before reading so its newer write can never certify an older snapshot.
    const observedVersion = readVersion();
    let value = read();
    for (const name of storedKeys()) {
      const request = JSON.parse(storage.getItem(name));
      if (!request) continue;
      const candidate = structuredClone(value);
      try {
        apply(candidate, request);
        value = candidate;
      } catch (error) {
        if (error.name !== 'ProfileConflictError') throw error;
      }
    }
    return { value, observedVersion };
  }

  // A previous tab may have closed after submitting an edit but before folding
  // it into the profile. Display that edit even if this tab is not the writer.
  if (differentBase() || storedKeys().length) {
    const current = latest();
    initial = current.value;
    remember(snapshot(initial), current.observedVersion);
  }
  reportConflicts();
  const session = {
    onChange(listener) {
      changedListener = listener;
    },
    get generation() {
      return generation;
    },
    changed() {
      return (
        differentBase() || storedKeys().some((name) => !name.endsWith(writerId))
      );
    },
    refresh(force = false) {
      if (!force && !differentBase()) return null;
      const { value, observedVersion } = latest();
      const changed = JSON.stringify(value) !== JSON.stringify(previous());
      remember(snapshot(value), observedVersion);
      if (changed) generation++;
      return changed || force ? value : null;
    },
    save(value) {
      if (ownsWriter && !differentBase()) {
        remember(
          persistProfile(storage, key, value, () => ownsWriter),
          readVersion()
        );
        return value;
      }
      const before = previous();
      const request = {
        changes: profileChanges(before, value),
        baseRevision: Number(before.backupRevision) || 0,
        revision: Number(value.backupRevision) || 0,
        updatedAt: value.updatedAt,
        bump:
          value.backupRevision !== before.backupRevision ||
          value.updatedAt !== before.updatedAt
      };
      if (request.changes.some((change) => change.path[0] === 'entries')) {
        const previousTimers = new Map(
          (before.entries || [])
            .filter((entry) => entry.isRunning)
            .map((entry) => [entry.id, String(entry.projectId)])
        );
        const running = (value.entries || []).filter(
          (entry) => entry.isRunning
        );
        const started = running.filter(
          (entry) => previousTimers.get(entry.id) !== String(entry.projectId)
        );
        if (started.length) {
          request.startedProjects = started.map((entry) =>
            String(entry.projectId)
          );
          request.runningIds = running.map((entry) => entry.id);
        }
      }
      if (ownsWriter) drain();
      const { value: current, observedVersion } = latest();
      if (JSON.stringify(before) !== JSON.stringify(current)) generation++;
      apply(current, request);
      if (ownsWriter) {
        remember(
          persistProfile(storage, key, current, () => ownsWriter),
          readVersion()
        );
      } else {
        const id = [
          String(Number(current.backupRevision) || 0).padStart(16, '0'),
          Date.now(),
          String(++sequence).padStart(8, '0'),
          writerId
        ].join('-');
        storage.setItem(pendingPrefix + id, JSON.stringify(request));
        remember(snapshot(current), observedVersion);
        scheduleDrain();
      }
      return current;
    }
  };
  return { initial, session };
}
