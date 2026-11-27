import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyProfileChanges,
  profileChanges
} from '../../src/shared/profile-changes.mjs';

test('independent row and field edits merge once, including insertions and removals', () => {
  const before = {
    entries: [{ id: 1, note: 'old', extra: true }, { id: 2 }],
    backupRevision: 1
  };
  const local = {
    entries: [{ id: 3 }, { id: 1, note: 'new', extra: true }],
    backupRevision: 2
  };
  const remote = {
    entries: [{ id: 1, note: 'old', extra: false }, { id: 2 }, { id: 4 }],
    backupRevision: 3,
    unknown: { keep: 1 }
  };
  const changes = JSON.parse(JSON.stringify(profileChanges(before, local)));
  assert.equal(applyProfileChanges(remote, changes), true);
  assert.deepEqual(remote, {
    entries: [{ id: 3 }, { id: 1, note: 'new', extra: false }, { id: 4 }],
    backupRevision: 3,
    unknown: { keep: 1 }
  });
  assert.equal(applyProfileChanges(remote, changes), false);
});

test('competing field edits, edits of removed rows, and competing reorders are reported', () => {
  const before = {
    items: [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 }
    ]
  };
  const edit = profileChanges(before, {
    items: [{ id: 'a', value: 3 }, before.items[1]]
  });
  for (const items of [[{ id: 'a', value: 4 }], [before.items[1]]]) {
    assert.throws(() => applyProfileChanges({ items }, edit), {
      name: 'ProfileConflictError'
    });
  }
  const reorder = profileChanges(before, {
    items: [...before.items].reverse()
  });
  assert.throws(
    () =>
      applyProfileChanges({ items: [...before.items, { id: 'c' }] }, reorder),
    { name: 'ProfileConflictError' }
  );
});
