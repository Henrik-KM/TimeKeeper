import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPrivateBridgeSettings,
  getPrivateBridgeToken,
  normalizeMobileNotificationConfig,
  savePrivateBridgeSettings,
  savePrivateBridgeToken
} from '../../src/features/private-bridge/core.mjs';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test('migrates an existing Company token into one private bridge connection', () => {
  const storage = new MemoryStorage({
    timekeeperCompanyOperatorToken: 'github_pat_existing',
    timekeeperCompanyOperatorSettings: JSON.stringify({
      repository: 'Henrik-KM/company-private',
      branch: 'operator-stable'
    })
  });

  assert.equal(getPrivateBridgeToken(storage), 'github_pat_existing');
  assert.equal(
    storage.getItem('timekeeperPrivateBridgeToken'),
    'github_pat_existing'
  );
  assert.equal(
    storage.getItem('timekeeperCodexIntegrationToken'),
    'github_pat_existing'
  );
  assert.deepEqual(getPrivateBridgeSettings(storage), {
    repository: 'Henrik-KM/company-private',
    branch: 'operator-stable'
  });
});

test('one saved private bridge connection stays compatible with both features', () => {
  const storage = new MemoryStorage();
  savePrivateBridgeToken('github_pat_shared', storage);
  const settings = savePrivateBridgeSettings(
    { repository: 'Henrik-KM/private-context', branch: 'stable' },
    storage
  );

  assert.equal(
    storage.getItem('timekeeperCompanyOperatorToken'),
    'github_pat_shared'
  );
  assert.equal(
    storage.getItem('timekeeperCodexIntegrationToken'),
    'github_pat_shared'
  );
  assert.deepEqual(settings, {
    repository: 'Henrik-KM/private-context',
    branch: 'stable'
  });
  assert.deepEqual(getPrivateBridgeSettings(storage), settings);

  savePrivateBridgeToken('', storage);
  assert.equal(getPrivateBridgeToken(storage), '');
});

test('normalizes only usable public mobile alert configuration', () => {
  const valid = normalizeMobileNotificationConfig({
    available: true,
    public_key: 'A'.repeat(65),
    subscriptions_path: '/mobile-notifications//subscriptions.json',
    weekday_time: '07:45',
    quiet_hours: ['20:00-07:00']
  });
  const invalid = normalizeMobileNotificationConfig({
    available: true,
    public_key: 'too-short'
  });

  assert.equal(valid.available, true);
  assert.equal(
    valid.subscriptionsPath,
    'mobile-notifications/subscriptions.json'
  );
  assert.equal(invalid.available, false);
});
