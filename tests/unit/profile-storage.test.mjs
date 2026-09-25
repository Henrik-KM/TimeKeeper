import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompressedProfile,
  loadStoredProfile,
  parseStoredProfile,
  persistProfile
} from '../../src/shared/profile-storage.mjs';

function makeStorage(rejectPlain = false) {
  const values = new Map();
  return {
    getItem: (key = 'timekeeperDataPro') => values.get(key) ?? null,
    setItem: (key, next) => {
      if (
        rejectPlain &&
        key === 'timekeeperDataPro' &&
        !isCompressedProfile(next)
      ) {
        const error = new Error('Storage quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, next);
    },
    removeItem: (key) => values.delete(key)
  };
}

test('profile storage keeps the old JSON format when it fits', () => {
  const storage = makeStorage();
  const profile = { projects: [], entries: [{ description: 'Work' }] };
  persistProfile(storage, 'timekeeperDataPro', profile);
  assert.equal(isCompressedProfile(storage.getItem()), false);
  assert.deepEqual(parseStoredProfile(storage.getItem()), profile);
});

test('quota fallback preserves complete Unicode profile across repeated saves', () => {
  const storage = makeStorage(true);
  const profile = {
    projects: [{ name: 'Anders 🧪' }],
    entries: Array.from({ length: 200 }, (_, id) => ({
      id,
      description: 'Mätning 漢字 ' + id,
      source: id % 2 ? 'claude' : 'timer',
      unknownField: { keep: true }
    }))
  };
  persistProfile(storage, 'timekeeperDataPro', profile);
  assert.equal(isCompressedProfile(storage.getItem()), true);
  assert.deepEqual(parseStoredProfile(storage.getItem()), profile);
  const compressedBase = storage.getItem();
  profile.entries.push({
    id: 201,
    description: 'new timer',
    source: 'timer',
    unknownField: { keep: true }
  });
  persistProfile(storage, 'timekeeperDataPro', profile);
  assert.deepEqual(loadStoredProfile(storage, 'timekeeperDataPro'), profile);
  assert.equal(storage.getItem(), compressedBase);
  assert.ok(storage.getItem('timekeeperDataPro:journal').length < 1000);
  assert.notDeepEqual(parseStoredProfile(storage.getItem()), profile);
  assert.ok(storage.getItem().length < JSON.stringify(profile).length);
});

test('a full change journal falls back to an atomic compressed profile', () => {
  const storage = makeStorage(true);
  const profile = {
    entries: [{ id: 'timer', isRunning: true }],
    backupRevision: 1
  };
  persistProfile(storage, 'timekeeperDataPro', profile);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === 'timekeeperDataPro:journal') {
      const error = new Error('Storage quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    setItem(key, value);
  };
  profile.entries[0].isRunning = false;
  profile.backupRevision = 2;
  persistProfile(storage, 'timekeeperDataPro', profile);
  assert.equal(storage.getItem('timekeeperDataPro:journal'), null);
  assert.deepEqual(loadStoredProfile(storage, 'timekeeperDataPro'), profile);
});
