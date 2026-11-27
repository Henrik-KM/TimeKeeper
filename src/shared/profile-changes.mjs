function same(a, b) {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function keyed(items) {
  return (
    items.every(
      (item) =>
        record(item) &&
        (typeof item.id === 'string' || typeof item.id === 'number')
    ) && new Set(items.map((item) => item.id)).size === items.length
  );
}

// Record field changes and stable row IDs so a change in one tab can be
// applied to a newer profile without replacing unrelated rows or metadata.
export function profileChanges(before, after) {
  const changes = [];
  function visit(old, next, path) {
    if (same(old, next)) return;
    if (record(old) && record(next)) {
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (!path.length && (key === 'updatedAt' || key === 'backupRevision'))
          continue;
        visit(
          Object.hasOwn(old, key) ? old[key] : undefined,
          Object.hasOwn(next, key) ? next[key] : undefined,
          [...path, key]
        );
      }
      return;
    }
    if (
      Array.isArray(old) &&
      Array.isArray(next) &&
      keyed(old) &&
      keyed(next)
    ) {
      const previous = new Map(old.map((item) => [item.id, item]));
      const current = new Map(next.map((item) => [item.id, item]));
      // An intentional reorder needs the entire list as a precondition.
      if (
        same(
          [...previous.keys()].filter((id) => current.has(id)),
          [...current.keys()].filter((id) => previous.has(id))
        )
      ) {
        for (const item of old)
          visit(item, current.get(item.id), [...path, { id: item.id }]);
        for (let i = next.length - 1; i >= 0; i--) {
          const item = next[i];
          if (!previous.has(item.id))
            changes.push({
              path: [...path, { id: item.id }],
              after: item,
              nextId: next[i + 1]?.id
            });
        }
        return;
      }
    }
    changes.push({ path, before: old, after: next });
  }
  visit(before, after, []);
  return changes;
}

export function profileConflictError(
  message = 'Another tab changed the same data. Review the latest values and retry.'
) {
  const error = new Error(message);
  error.name = 'ProfileConflictError';
  return error;
}

// The caller supplies a detached copy. A conflicting group must be discarded
// as a whole, including any earlier changes already applied to this copy.
export function applyProfileChanges(profile, changes) {
  let changed = false;
  for (const { path, before, after, nextId } of changes) {
    let target = profile;
    for (const key of path.slice(0, -1)) {
      target =
        typeof key === 'object'
          ? target?.find?.((item) => item.id === key.id)
          : target && Object.hasOwn(target, key)
            ? target[key]
            : undefined;
      if (!target || typeof target !== 'object') throw profileConflictError();
    }
    const key = path.at(-1);
    const row = typeof key === 'object';
    if (row && !Array.isArray(target)) throw profileConflictError();
    const index = row ? target.findIndex((item) => item.id === key.id) : key;
    const value = Object.hasOwn(target, index) ? target[index] : undefined;
    if (same(value, after)) continue;
    if (!same(value, before)) throw profileConflictError();
    changed = true;
    if (row && index === -1) {
      const nextIndex = target.findIndex((item) => item.id === nextId);
      target.splice(nextIndex < 0 ? target.length : nextIndex, 0, after);
    } else if (after === undefined) {
      if (row) target.splice(index, 1);
      else delete target[index];
    } else {
      Object.defineProperty(target, index, {
        value: after,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  return changed;
}
