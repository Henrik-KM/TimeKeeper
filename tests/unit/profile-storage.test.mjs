import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompressedProfile,
  parseStoredProfile,
  persistProfile
} from '../../src/shared/profile-storage.mjs';

function makeStorage(rejectPlain = false) {
  let value = null;
  return {
    getItem: () => value,
    setItem: (_, next) => {
      if (rejectPlain && !isCompressedProfile(next)) {
        const error = new Error('Storage quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      value = next;
    }
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
  profile.entries.push({
    id: 201,
    description: 'new timer',
    source: 'timer',
    unknownField: { keep: true }
  });
  persistProfile(storage, 'timekeeperDataPro', profile);
  assert.deepEqual(parseStoredProfile(storage.getItem()), profile);
  assert.ok(storage.getItem().length < JSON.stringify(profile).length);
});
