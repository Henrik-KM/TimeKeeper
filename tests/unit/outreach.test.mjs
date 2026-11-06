import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutreachCommand,
  normalizeOutreachSnapshot,
  outreachGroup,
  safeOutreachUrl
} from '../../src/features/outreach/core.mjs';

function fixture() {
  return {
    schema_version: 1,
    kind: 'henrik_outreach',
    state_version: 'current',
    opportunities: [
      {
        opportunity_id: 'lead',
        person_id: 'person',
        company: 'Example',
        contact: 'Alex',
        status: 'needs_you',
        ownership: 'human'
      }
    ],
    counts: { messages_sent: 0, drafts_prepared: 1, interested: 0 }
  };
}
test('outreach rejects old Company payloads and keeps legitimate zero counts', () => {
  assert.equal(
    normalizeOutreachSnapshot({ schema_version: 1, priorities: [] }),
    null
  );
  const snapshot = normalizeOutreachSnapshot(fixture());
  assert.equal(snapshot.counts.messages, 0);
  assert.equal(snapshot.counts.interested, 0);
  assert.equal(snapshot.opportunities[0].humanOwned, true);
});
test('outreach links reject executable schemes and embedded credentials', () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///private',
    'https://token@example.com/',
    'https://127.0.0.1/'
  ]) {
    assert.equal(safeOutreachUrl(url), '');
  }
  assert.equal(
    safeOutreachUrl('https://www.linkedin.com/in/alex/'),
    'https://www.linkedin.com/in/alex/'
  );
});
test('outreach controls bind the snapshot and a known person', () => {
  const snapshot = normalizeOutreachSnapshot(fixture());
  const command = buildOutreachCommand({
    action: 'take_over',
    commandId: 'outreach-12345',
    snapshot,
    personId: 'person'
  });
  assert.equal(command.state_version, 'current');
  assert.equal(command.source, 'timekeeper_mobile');
  assert.equal(command.person_id, 'person');
  assert.throws(() =>
    buildOutreachCommand({
      action: 'send',
      commandId: 'outreach-12345',
      snapshot
    })
  );
  assert.throws(() =>
    buildOutreachCommand({
      action: 'release',
      commandId: 'outreach-12345',
      snapshot,
      personId: 'stranger'
    })
  );
});
test('outreach separates human action from active interest and closed work', () => {
  assert.equal(outreachGroup({ status: 'needs_you' }), 'needs');
  assert.equal(outreachGroup({ status: 'interested' }), 'active');
  assert.equal(outreachGroup({ status: 'planned' }), 'planned');
  assert.equal(
    outreachGroup({ status: 'active', suppressed: true }),
    'results'
  );
});
